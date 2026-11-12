import { describe, expect, it } from "vitest";
import {
  LIVENESS_CHECK_MS,
  LivenessWatch,
  MIN_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeout,
} from "./liveness.js";

describe("heartbeatTimeout", () => {
  it("waits three heartbeat intervals, counting at least one second per interval", () => {
    expect(heartbeatTimeout(15_000)).toBe(45_000);
    expect(heartbeatTimeout(1)).toBe(3 * MIN_HEARTBEAT_INTERVAL_MS);
  });
});

describe("LivenessWatch", () => {
  // 확인 타이머가 제때 깨어나는 것처럼 시각을 1초씩 옮기며 확인합니다.
  function setup(timeoutMs = 3000) {
    let now = 1_000_000;
    const watch = new LivenessWatch(timeoutMs, () => now);
    const tick = (ms = LIVENESS_CHECK_MS) => {
      now += ms;
      return watch.check().result;
    };
    return { watch, tick };
  }

  it("stays alive while server messages keep coming", () => {
    const { watch, tick } = setup();
    for (let i = 0; i < 10; i += 1) {
      expect(tick()).toBe("alive");
      watch.received();
    }
  });

  it("is dead once no server message came for longer than the timeout", () => {
    const { tick } = setup(3000);
    expect([tick(), tick(), tick()]).toEqual(["alive", "alive", "alive"]);
    // 3초를 넘은 4초째에 죽은 것으로 봅니다.
    expect(tick()).toBe("dead");
  });

  it("skips the check when the timer woke up late after the event loop was blocked", () => {
    const { watch, tick } = setup(3000);
    expect(tick()).toBe("alive");
    // 이벤트 루프가 10초 막혔다 풀려 타이머가 늦게 깨어났습니다. 막힌 동안 온 메시지가 아직 처리되지 않았을 수 있습니다.
    expect(tick(LIVENESS_CHECK_MS + 10_000)).toBe("skipped");
    // 그 사이 처리된 메시지가 있으면 다음 확인에서 살아 있습니다.
    watch.received();
    expect(tick()).toBe("alive");
  });

  it("is dead at the next check after a block when nothing came in", () => {
    const { tick } = setup(3000);
    expect(tick(LIVENESS_CHECK_MS + 10_000)).toBe("skipped");
    expect(tick()).toBe("dead");
  });

  it("does not skip a timer that is only a little late", () => {
    const { tick } = setup(3000);
    // 0.9초 늦은 것은 막힘으로 보지 않으므로, 메시지 없이 3.8초가 지나면 죽은 것으로 봅니다.
    expect(tick(LIVENESS_CHECK_MS + 900)).toBe("alive");
    expect(tick(LIVENESS_CHECK_MS + 900)).toBe("dead");
  });
});
