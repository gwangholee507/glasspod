import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  EventAggregator,
  GROUP_WINDOW_MS,
  MAX_GROUPS,
  MAX_HELD,
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
// online: 연결됨(limit이 1분 한도), offline: SDK는 돌지만 연결이 없음, off: SDK가 돌지 않음
function setup(limit = 120) {
  const state: { limit: number; mode: "online" | "offline" | "off" } = {
    limit,
    mode: "online",
  };
  const sent: Sent[] = [];
  let seq = 0;
  const aggregator = new EventAggregator(
    (content, ts, count) => {
      if (state.mode !== "online") {
        return undefined;
      }
      sent.push({ name: content.name, message: content.message, ts, count });
      return seq++;
    },
    () => (state.mode === "online" ? state.limit : state.mode),
  );
  // 연결된 것처럼 바꾸고 aggregator에 알립니다(SDK에서는 welcome 때).
  const connect = (newLimit = state.limit) => {
    state.mode = "online";
    state.limit = newLimit;
    aggregator.connected();
  };
  return { state, sent, aggregator, connect };
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

  it("drops events while the SDK is not started", () => {
    const { state, sent, aggregator, connect } = setup();
    state.mode = "off";
    aggregator.record(timeout("before start"));
    connect();
    vi.advanceTimersByTime(GROUP_WINDOW_MS * 2);
    expect(sent).toHaveLength(0);
    expect(aggregator.heldCount).toBe(0);
  });

  it("holds events while offline and sends them in order with their original ts", () => {
    const { state, sent, aggregator, connect } = setup();
    state.mode = "offline";

    // 연결 전에도 묶기는 그대로입니다. 첫 건은 바로 보관하고, 나머지는 창 끝에 묶어 보관합니다.
    aggregator.record(timeout("a"));
    vi.advanceTimersByTime(1000);
    aggregator.record(timeout("a"));
    aggregator.record(timeout("a"));
    vi.advanceTimersByTime(1000);
    aggregator.record(timeout("b"));
    vi.advanceTimersByTime(GROUP_WINDOW_MS);
    expect(sent).toHaveLength(0);
    expect(aggregator.heldCount).toBe(3);

    connect();
    expect(sent).toEqual([
      { name: "exception", message: "a", ts: START, count: 1 },
      { name: "exception", message: "b", ts: START + 2000, count: 1 },
      { name: "exception", message: "a", ts: START + 1000, count: 2 },
    ]);
    expect(aggregator.heldCount).toBe(0);

    // 보낸 뒤에는 보통 때처럼 바로 보냅니다.
    aggregator.record(timeout("c"));
    expect(sent.at(-1)?.message).toBe("c");
  });

  it("holds what was counted when the connection drops in the middle of a window", () => {
    const { state, sent, aggregator, connect } = setup();
    aggregator.record(timeout("a"));
    aggregator.record(timeout("a"));
    state.mode = "offline";
    vi.advanceTimersByTime(GROUP_WINDOW_MS + 1000);
    connect();
    expect(sent.map((event) => [event.message, event.count])).toEqual([
      ["a", 1],
      ["a", 1],
    ]);
  });

  it("keeps at most MAX_HELD events while offline, dropping the oldest", () => {
    const { state, sent, aggregator, connect } = setup(10_000);
    state.mode = "offline";
    // 서로 다른 이벤트를 창이 끝날 때마다 새로 일으켜 보관함을 넘칩니다.
    for (let i = 0; i < MAX_HELD + 20; i += 1) {
      aggregator.record(timeout(`error ${i}`));
      if (i % MAX_GROUPS === MAX_GROUPS - 1) {
        vi.advanceTimersByTime(GROUP_WINDOW_MS + 1000);
      }
    }
    expect(aggregator.heldCount).toBe(MAX_HELD);
    expect(warnSpy.mock.calls.map((call) => call[0])).toEqual([
      `[glasspod] event buffer full (${MAX_HELD} events while disconnected); dropping the oldest`,
    ]);

    connect();
    expect(sent).toHaveLength(MAX_HELD);
    expect(sent[0]?.message).toBe("error 20");
    expect(sent.at(-1)?.message).toBe(`error ${MAX_HELD + 19}`);
  });

  it("sends held events within the per-minute limit and lets new events wait in their groups", () => {
    const { state, sent, aggregator, connect } = setup();
    state.mode = "offline";
    for (let i = 0; i < 8; i += 1) {
      aggregator.record(timeout(`held ${i}`));
    }
    vi.advanceTimersByTime(GROUP_WINDOW_MS + 1000);

    connect(5);
    expect(sent.map((event) => event.message)).toEqual([
      "held 0",
      "held 1",
      "held 2",
      "held 3",
      "held 4",
    ]);
    expect(warnSpy.mock.calls.map((call) => call[0])).toEqual([
      "[glasspod] event limit reached (5 per minute from the server); events are grouped and sent later",
    ]);

    // 보관분이 남아 있는 동안 새 event는 보내지 않고 셉니다.
    aggregator.record(timeout("new"));
    aggregator.record(timeout("new"));
    vi.advanceTimersByTime(RATE_WINDOW_MS - 2000);
    expect(sent).toHaveLength(5);

    // 한도가 풀리면 남은 보관분부터 보내고, 이어서 기다리던 묶음을 보냅니다.
    vi.advanceTimersByTime(2000);
    expect(sent.slice(5).map((event) => [event.message, event.count])).toEqual([
      ["held 5", 1],
      ["held 6", 1],
      ["held 7", 1],
      ["new", 2],
    ]);
  });

  it("drops held events when the new server's limit is 0", () => {
    const { state, sent, aggregator, connect } = setup();
    state.mode = "offline";
    aggregator.record(timeout("a"));
    connect(0);
    vi.advanceTimersByTime(RATE_WINDOW_MS);
    expect(sent).toHaveLength(0);
    expect(aggregator.heldCount).toBe(0);
  });

  it("drops held events on reset()", () => {
    const { state, sent, aggregator, connect } = setup();
    state.mode = "offline";
    aggregator.record(timeout("a"));
    aggregator.reset();
    connect();
    expect(sent).toHaveLength(0);
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

  it("sends a fatal exception first, then the held events, then the groups", () => {
    const { state, sent, aggregator, connect } = setup(1);
    state.mode = "offline";
    aggregator.record(timeout("held 1"));
    aggregator.record(timeout("held 2"));
    connect();
    aggregator.record(timeout("new"));
    expect(sent.map((event) => event.message)).toEqual(["held 1"]);

    vi.setSystemTime(START + 500);
    expect(aggregator.flushFatal(timeout("crash"))).toEqual({
      seq: 1,
      flushed: 2,
    });
    expect(sent.slice(1).map((event) => event.message)).toEqual([
      "crash",
      "held 2",
      "new",
    ]);
    expect(aggregator.heldCount).toBe(0);
  });

  it("cannot send a fatal exception while offline", () => {
    const { state, sent, aggregator } = setup();
    state.mode = "offline";
    expect(aggregator.flushFatal(timeout("crash"))).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
