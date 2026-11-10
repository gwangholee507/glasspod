import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  EventAggregator,
  GROUP_WINDOW_MS,
  MAX_GROUPS,
  RATE_WINDOW_MS,
  eventKey,
} from "./events.js";
import type { EventContent } from "./events.js";

interface Sent {
  name: string;
  message: string | undefined;
  ts: number;
  count: number;
}

const START = 1_800_000_000_000;

function timeout(message = "DB timeout"): EventContent {
  return {
    level: "error",
    name: "exception",
    message,
    data: { errorType: "TimeoutError" },
  };
}

// 연결 상태와 한도를 바꿔 가며 보낸 것을 기록하는 aggregator를 만듭니다.
function setup(limit: number | undefined = 120) {
  const state = { limit, connected: true };
  const sent: Sent[] = [];
  let seq = 0;
  const aggregator = new EventAggregator(
    (content, ts, count) => {
      if (!state.connected) {
        return undefined;
      }
      sent.push({ name: content.name, message: content.message, ts, count });
      return seq++;
    },
    () => (state.connected ? state.limit : undefined),
  );
  return { state, sent, aggregator };
}

describe("EventAggregator", () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it("sends the first event at once and the repeats as one event per window", () => {
    const { sent, aggregator } = setup();

    // 0초에 첫 건, 1~9초에 9번, 11~19초에 9번 일어납니다.
    aggregator.record(timeout());
    for (let second = 1; second < 20; second += 1) {
      vi.advanceTimersByTime(1000);
      if (second !== 10) {
        aggregator.record(timeout());
      }
    }
    vi.advanceTimersByTime(GROUP_WINDOW_MS + 2000);

    expect(sent).toEqual([
      { name: "exception", message: "DB timeout", ts: START, count: 1 },
      { name: "exception", message: "DB timeout", ts: START + 1000, count: 9 },
      {
        name: "exception",
        message: "DB timeout",
        ts: START + 11_000,
        count: 9,
      },
    ]);

    // 조용한 창이 지나면 잊으므로 다음 것은 다시 바로 나갑니다.
    vi.advanceTimersByTime(GROUP_WINDOW_MS * 2);
    aggregator.record(timeout());
    expect(sent).toHaveLength(4);
    expect(sent[3]?.count).toBe(1);
  });

  it("groups by name, level, message and errorType", () => {
    const base = timeout();
    expect(eventKey(base)).toBe(
      eventKey({ ...base, data: { ...base.data, stack: "x" } }),
    );
    expect(eventKey(base)).not.toBe(eventKey(timeout("other")));
    expect(eventKey(base)).not.toBe(eventKey({ ...base, level: "warn" }));
    expect(eventKey(base)).not.toBe(
      eventKey({ ...base, data: { errorType: "TypeError" } }),
    );

    const { sent, aggregator } = setup();
    aggregator.record(timeout("a"));
    aggregator.record(timeout("b"));
    aggregator.record(timeout("a"));
    expect(sent.map((event) => event.message)).toEqual(["a", "b"]);
  });

  it("keeps to the per-minute limit and sends what waited once there is room", () => {
    const { sent, aggregator } = setup(2);

    aggregator.record(timeout("a"));
    aggregator.record(timeout("b"));
    aggregator.record(timeout("c"));
    aggregator.record(timeout("c"));
    expect(sent.map((event) => event.message)).toEqual(["a", "b"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      "event limit reached (2 per minute",
    );

    // 1분이 지나기 전에는 c를 보내지 않습니다.
    vi.advanceTimersByTime(RATE_WINDOW_MS - 1000);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(2000);
    expect(sent[2]).toEqual({
      name: "exception",
      message: "c",
      ts: START,
      count: 2,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the limit is 0", () => {
    const { state, sent, aggregator } = setup(0);
    aggregator.record(timeout());
    aggregator.record(timeout("other"));
    vi.advanceTimersByTime(RATE_WINDOW_MS * 2);
    expect(sent).toHaveLength(0);
    expect(aggregator.flushFatal(timeout())).toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(warnSpy.mock.calls.map((call) => call[0])).toEqual([
      "[glasspod] event limit is 0 per minute from the server; events are not sent",
    ]);

    // 세는 동안 다시 연결한 서버의 한도가 0이면 센 것을 버립니다.
    state.limit = 10;
    aggregator.record(timeout());
    aggregator.record(timeout());
    state.limit = 0;
    vi.advanceTimersByTime(GROUP_WINDOW_MS + 1000);
    state.limit = 10;
    vi.advanceTimersByTime(GROUP_WINDOW_MS * 2);
    expect(sent.map((event) => event.count)).toEqual([1]);
  });

  it("drops events while not connected", () => {
    const { state, sent, aggregator } = setup();
    state.connected = false;
    aggregator.record(timeout("offline"));
    expect(sent).toHaveLength(0);

    // 창 동안 끊기면 창 끝에 센 것을 버립니다.
    state.connected = true;
    aggregator.record(timeout("a"));
    aggregator.record(timeout("a"));
    state.connected = false;
    vi.advanceTimersByTime(GROUP_WINDOW_MS + 1000);
    state.connected = true;
    vi.advanceTimersByTime(GROUP_WINDOW_MS * 2);
    expect(sent.map((event) => [event.message, event.count])).toEqual([
      ["a", 1],
    ]);
  });

  it("counts at most MAX_GROUPS different events at a time", () => {
    const { sent, aggregator } = setup(1000);
    for (let i = 0; i <= MAX_GROUPS; i += 1) {
      aggregator.record(timeout(`error ${i}`));
    }
    expect(sent).toHaveLength(MAX_GROUPS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      `more than ${MAX_GROUPS} different events`,
    );

    // 창이 끝나 잊고 나면 다시 받습니다.
    vi.advanceTimersByTime(GROUP_WINDOW_MS + 1000);
    aggregator.record(timeout("later"));
    expect(sent.at(-1)?.message).toBe("later");
  });

  it("sends a fatal exception at once with the repeats it was counting", () => {
    const { sent, aggregator } = setup(1);
    aggregator.record(timeout("a"));
    aggregator.record(timeout("a"));
    aggregator.record(timeout("a"));
    aggregator.record(timeout("b"));
    expect(sent).toHaveLength(1);

    vi.setSystemTime(START + 500);
    // 한도(1)를 이미 썼어도 바로 보내고, 세던 b도 함께 보냅니다.
    expect(aggregator.flushFatal(timeout("a"))).toEqual({ seq: 1, flushed: 1 });
    expect(sent.slice(1)).toEqual([
      { name: "exception", message: "a", ts: START + 500, count: 3 },
      { name: "exception", message: "b", ts: START, count: 1 },
    ]);

    // 보낸 뒤에는 세던 것이 남지 않습니다.
    vi.advanceTimersByTime(RATE_WINDOW_MS * 2);
    expect(sent).toHaveLength(3);
  });
});
