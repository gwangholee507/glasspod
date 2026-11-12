// metrics 주기 전송입니다(design.md 7.3, 7.4). 측정은 SDK가 시작될 때부터 멈출 때까지 연결과 상관없이 이어 가고,
// welcome을 받으면 바로 한 번 보낸 뒤 한 주기마다 보냅니다. 연결이 끝나면 보내기만 멈춥니다.
// 끊긴 동안 따로 쌓지 않습니다. 보낼 때 읽은 값이 최신 값이고, 지연과 응답 시간은 지난 전송 뒤를 모두 덮습니다.
// 보낼 값이 없어도 주기마다 보내며, 이것이 heartbeat입니다. 값은 runtime.*, http.*(T07), app.* 순서로 보냅니다.
import type { MetricValue } from "@glasspod/protocol";
import { guard } from "./guard.js";
import type { HttpCollector } from "./http.js";
import { debug } from "./log.js";
import type { Registry } from "./registry.js";
import type { RuntimeSampler } from "./runtime.js";

// 서버가 이보다 짧은 주기를 주면 이 값을 씁니다. 서버 설정은 1ms도 허용하므로 앱을 지킵니다.
export const MIN_METRICS_INTERVAL_MS = 1000;
// Node 타이머가 받는 가장 긴 간격입니다. 넘으면 Node가 1ms로 바꿔 버립니다.
export const MAX_TIMER_MS = 2_147_483_647;

// welcome의 metricsIntervalMs를 SDK가 쓸 주기로 바꿉니다.
export function effectiveInterval(requestedMs: number): number {
  return Math.min(Math.max(requestedMs, MIN_METRICS_INTERVAL_MS), MAX_TIMER_MS);
}

// 모은 값을 metrics 메시지로 보냅니다. 보냈으면 그 메시지의 seq, 연결이 없어 못 보냈으면 undefined입니다.
export type SendMetrics = (values: MetricValue[]) => number | undefined;

export class MetricsReporter {
  private readonly runtime: RuntimeSampler;
  private readonly http: HttpCollector;
  private readonly registry: Registry;
  private readonly send: SendMetrics;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    runtime: RuntimeSampler,
    http: HttpCollector,
    registry: Registry,
    send: SendMetrics,
  ) {
    this.runtime = runtime;
    this.http = http;
    this.registry = registry;
    this.send = send;
  }

  // SDK가 시작될 때(start()) 부릅니다. 이벤트 루프 지연 측정을 시작합니다.
  start(): void {
    this.runtime.start();
  }

  // 연결되면(welcome) 부릅니다. 끊긴 동안(첫 연결이면 start() 뒤)의 값을 바로 한 번 보내고, 그 뒤 한 주기마다 보냅니다.
  connected(requestedMs: number): void {
    this.disconnected();
    const intervalMs = effectiveInterval(requestedMs);
    if (intervalMs !== requestedMs) {
      debug(
        `metrics interval ${requestedMs}ms from server ${intervalMs > requestedMs ? "raised" : "lowered"} to ${intervalMs}ms`,
      );
    }
    const timer = setInterval(() => guard(() => this.tick()), intervalMs);
    // SDK 타이머가 앱 종료를 막지 않게 합니다.
    timer.unref();
    this.timer = timer;
    debug(`metrics every ${intervalMs}ms`);
    this.tick();
  }

  // 연결이 끝나면(끊김, stop) 부릅니다. 보내기만 멈추고 측정은 이어 갑니다.
  disconnected(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    debug("metrics paused");
  }

  // SDK가 멈출 때(stop()) 부릅니다. 측정도 멈춥니다.
  stop(): void {
    this.disconnected();
    this.runtime.stop();
  }

  private tick(): void {
    const values = [
      ...this.runtime.collect(),
      ...this.http.collect(),
      ...this.registry.collect(),
    ];
    const seq = this.send(values);
    if (seq !== undefined) {
      debug(`metrics sent seq=${seq} values=${values.length}`);
    }
  }
}
