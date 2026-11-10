import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { WarnOnce } from "./log.js";
import { MAX_STATES, MAX_STATE_VALUE_CHARS, StateStore } from "./states.js";

describe("StateStore", () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("makes a state event only when the value changes", () => {
    const states = new StateStore(new WarnOnce());
    expect(states.set("app.mode", "ready")).toEqual({
      level: "info",
      name: "state",
      message: "app.mode: ready",
      data: { name: "app.mode", to: "ready" },
    });
    expect(states.set("app.mode", "ready")).toBeUndefined();
    expect(states.set("app.mode", "draining")).toEqual({
      level: "info",
      name: "state",
      message: "app.mode: ready -> draining",
      data: { name: "app.mode", from: "ready", to: "draining" },
    });
    states.set("app.db", "up");
    expect(states.current()).toEqual({
      "app.mode": "draining",
      "app.db": "up",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores bad names, bad values and states over the limit", () => {
    const states = new StateStore(new WarnOnce());
    expect(states.set("mode", "ready")).toBeUndefined();
    expect(states.set("app.mode", 1)).toBeUndefined();
    expect(
      states.set("app.mode", "x".repeat(MAX_STATE_VALUE_CHARS + 1)),
    ).toBeUndefined();
    for (let i = 0; i < MAX_STATES; i += 1) {
      states.set(`app.s${i}`, "on");
    }
    expect(states.set("app.extra", "on")).toBeUndefined();
    expect(states.set("app.extra2", "on")).toBeUndefined();
    // 이미 있는 상태는 상한과 상관없이 바꿀 수 있습니다.
    expect(states.set("app.s0", "off")?.message).toBe("app.s0: on -> off");
    // 경고는 문제마다 한 번입니다: 이름, app.mode의 값, 상한.
    expect(warnSpy.mock.calls.map((call) => call[0])).toEqual([
      '[glasspod] state ignored: "mode" must start with "app." and use lowercase letters, digits and _ in each level',
      `[glasspod] state ignored: "app.mode": value must be a string of at most ${MAX_STATE_VALUE_CHARS} characters`,
      `[glasspod] state ignored: "app.extra": at most ${MAX_STATES} states can be registered`,
    ]);
    expect(Object.keys(states.current())).toHaveLength(MAX_STATES);
  });
});
