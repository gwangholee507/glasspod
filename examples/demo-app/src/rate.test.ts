import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateTicker, TICK_MS } from "./rate.js";

describe("RateTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // calls를 비우고 seconds초를 흘려보낸 뒤, 그동안 부른 횟수의 합을 돌려줍니다.
  function run(calls: number[], seconds: number): number {
    calls.length = 0;
    vi.advanceTimersByTime(seconds * 1000);
    return calls.reduce((sum, count) => sum + count, 0);
  }

  it("초당 횟수를 100ms마다 나누고 남은 몫을 넘긴다", () => {
    const calls: number[] = [];
    const ticker = new RateTicker(25, (count) => calls.push(count));
    ticker.start();
    expect(run(calls, 1)).toBe(25);
    expect(calls).toHaveLength(1000 / TICK_MS);
    expect(Math.max(...calls) - Math.min(...calls)).toBe(1);
    ticker.stop();
  });

  it("초당 1번은 정확히 1초마다 부른다", () => {
    const calls: number[] = [];
    const ticker = new RateTicker(1, (count) => calls.push(count));
    ticker.start();
    for (let i = 0; i < 10; i++) {
      expect(run(calls, 1)).toBe(1);
    }
    ticker.stop();
  });

  it("setRate는 다음 차례부터, stop 뒤에는 부르지 않는다", () => {
    const calls: number[] = [];
    const ticker = new RateTicker(10, (count) => calls.push(count));
    ticker.start();
    expect(run(calls, 1)).toBe(10);
    ticker.setRate(3);
    expect(run(calls, 2)).toBe(6);
    ticker.stop();
    expect(run(calls, 1)).toBe(0);
  });
});
