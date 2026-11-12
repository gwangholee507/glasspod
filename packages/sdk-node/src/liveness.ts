// 응답 없는 연결(반쯤 열린 연결)을 알아챕니다(design.md 7.4, docs/guides/T08.md 결정 3, 15, 16).
// 내장 WebSocket은 ping을 보내지도 받은 것을 알리지도 않으므로, 서버가 주기마다 보내는 heartbeat를 씁니다.
// 서버 메시지가 heartbeat 주기의 3배 동안 없으면 연결이 죽은 것으로 봅니다.
import { performance } from "node:perf_hooks";

// 몇 주기 동안 서버 메시지가 없으면 죽은 것으로 볼지입니다. 한두 번 늦는 것은 넘깁니다.
export const HEARTBEAT_MISSES = 3;
// 서버가 이보다 짧은 주기를 주어도 이 값으로 셉니다. metrics 주기 하한과 같습니다.
export const MIN_HEARTBEAT_INTERVAL_MS = 1000;
// 확인 타이머의 간격입니다.
export const LIVENESS_CHECK_MS = 1000;
// 확인 타이머가 이보다 더 늦게 깨어나면 이벤트 루프가 막혔던 것으로 보고 그 확인을 건너뜁니다.
export const LATE_CHECK_MS = 1000;

// welcome의 heartbeatIntervalMs로 연결이 죽었다고 볼 시간을 정합니다.
export function heartbeatTimeout(intervalMs: number): number {
  return HEARTBEAT_MISSES * Math.max(intervalMs, MIN_HEARTBEAT_INTERVAL_MS);
}

export type LivenessCheck =
  | { result: "alive" }
  // 이벤트 루프가 막혔다 풀린 직후입니다. 막힌 동안 온 메시지가 아직 처리되지 않았을 수 있습니다.
  | { result: "skipped"; lateMs: number }
  | { result: "dead"; silentMs: number };

// 연결 하나의 서버 메시지 도착을 지켜봅니다. 시각은 시스템 시계가 바뀌어도 흔들리지 않는 값을 씁니다.
export class LivenessWatch {
  readonly timeoutMs: number;
  private readonly now: () => number;
  private lastReceived: number;
  private lastCheck: number;

  constructor(timeoutMs: number, now: () => number = () => performance.now()) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.lastReceived = now();
    this.lastCheck = this.lastReceived;
  }

  // 서버 메시지가 왔을 때 부릅니다. 종류는 상관없습니다.
  received(): void {
    this.lastReceived = this.now();
  }

  // 확인 타이머(LIVENESS_CHECK_MS 간격)에서 부릅니다.
  check(): LivenessCheck {
    const now = this.now();
    const lateMs = now - this.lastCheck - LIVENESS_CHECK_MS;
    this.lastCheck = now;
    if (lateMs > LATE_CHECK_MS) {
      return { result: "skipped", lateMs };
    }
    const silentMs = now - this.lastReceived;
    return silentMs > this.timeoutMs
      ? { result: "dead", silentMs }
      : { result: "alive" };
  }
}
