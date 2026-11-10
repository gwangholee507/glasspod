// metrics 주기 전송입니다(design.md 7.3). welcome을 받으면 시작하고, 연결이 끝나면 멈춥니다.
// 보낼 값이 없어도 주기마다 보내며, 이것이 heartbeat입니다. 끊긴 동안의 값 유지는 T08에서 합니다.
import type { MetricValue } from "@glasspod/protocol";
import { guard } from "./guard.js";
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
  private readonly registry: Registry;
  private readonly send: SendMetrics;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(runtime: RuntimeSampler, registry: Registry, send: SendMetrics) {
    this.runtime = runtime;
    this.registry = registry;
    this.send = send;
  }

  // 연결되면(welcome) 부릅니다. 첫 metrics는 한 주기 뒤에 보냅니다.
  begin(requestedMs: number): void {
    this.end();
    const intervalMs = effectiveInterval(requestedMs);
    if (intervalMs !== requestedMs) {
      debug(
        `metrics interval ${requestedMs}ms from server ${intervalMs > requestedMs ? "raised" : "lowered"} to ${intervalMs}ms`,
      );
    }
    this.runtime.start();
    const timer = setInterval(() => guard(() => this.tick()), intervalMs);
    // SDK 타이머가 앱 종료를 막지 않게 합니다.
    timer.unref();
    this.timer = timer;
    debug(`metrics every ${intervalMs}ms`);
  }

  // 연결이 끝나면(끊김, stop) 부릅니다. 이벤트 루프 지연 측정도 멈춥니다.
  end(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.runtime.stop();
    debug("metrics stopped");
  }

  private tick(): void {
    const values = [...this.runtime.collect(), ...this.registry.collect()];
    const seq = this.send(values);
    if (seq !== undefined) {
      debug(`metrics sent seq=${seq} values=${values.length}`);
    }
  }
}
