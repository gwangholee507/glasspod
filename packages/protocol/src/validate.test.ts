import { describe, expect, it } from "vitest";
import {
  parseSdkMessage,
  parseServerMessage,
  validateSnapshotData,
} from "./validate.js";
import type { ParseResult } from "./validate.js";

// design.md 7.3의 예시 메시지입니다. 설계 문서의 예시가 스키마를 통과해야 합니다.
const hello = {
  type: "hello",
  seq: 0,
  ts: 1793873730120,
  protocol: 1,
  sdk: { lang: "node", version: "0.1.0" },
  pod: { namespace: "shop", name: "orders-7d9f8-x2kq1" },
  instanceId: "4f1c2a9e",
  app: { name: "orders", version: "1.4.2" },
  capabilities: ["snapshot"],
};
const metrics = {
  type: "metrics",
  seq: 42,
  ts: 1793873735120,
  values: [
    { name: "runtime.event_loop.lag_p99_ms", kind: "gauge", value: 12.4 },
    { name: "runtime.heap.used_bytes", kind: "gauge", value: 48234496 },
    { name: "http.requests.total", kind: "counter", value: 1532 },
    { name: "app.queue.length", kind: "gauge", value: 1200 },
  ],
};
const event = {
  type: "event",
  seq: 43,
  ts: 1793873733870,
  level: "error",
  name: "exception",
  message: "DB timeout after 5000ms",
  count: 1,
  data: { errorType: "TimeoutError", route: "GET /orders", stack: "..." },
};
const response = {
  type: "response",
  seq: 51,
  ts: 1793873740020,
  replyTo: "r-7",
  ok: true,
  data: {
    state: { "app.mode": "draining" },
    inFlight: [{ route: "GET /orders", elapsedMs: 8200 }],
    process: { uptimeSec: 3600, heapUsedBytes: 48234496 },
  },
};
const welcome = {
  type: "welcome",
  metricsIntervalMs: 5000,
  maxEventsPerMinute: 120,
  heartbeatIntervalMs: 15000,
};
const reject = { type: "reject", reason: "unknown-pod" };
const request = { type: "request", id: "r-7", action: "snapshot" };
const heartbeat = { type: "heartbeat" };

const { pod: _pod, ...helloWithoutPod } = hello;
const { type: _type, ...metricsWithoutType } = metrics;
const { metricsIntervalMs: _interval, ...welcomeWithoutInterval } = welcome;
const { heartbeatIntervalMs: _heartbeat, ...welcomeWithoutHeartbeat } = welcome;

type Case = { name: string; input: unknown; error: string };

// 실패해야 하는 입력과, 오류 문구에 들어 있어야 하는 내용입니다.
function expectError(result: ParseResult<unknown>, error: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(error);
}

function toText(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

describe("parseSdkMessage", () => {
  it.each([hello, metrics, event, response])(
    "accepts the design.md example: $type",
    (message) => {
      expect(parseSdkMessage(JSON.stringify(message))).toEqual({
        ok: true,
        message,
      });
    },
  );

  it("accepts an empty metrics batch (heartbeat)", () => {
    expect(parseSdkMessage(JSON.stringify({ ...metrics, values: [] })).ok).toBe(
      true,
    );
  });

  it("ignores unknown fields", () => {
    const text = JSON.stringify({
      ...hello,
      extra: 1,
      pod: { ...hello.pod, zone: "a" },
    });
    expect(parseSdkMessage(text).ok).toBe(true);
  });

  it("narrows the message type by its type field", () => {
    const result = parseSdkMessage(JSON.stringify(hello));
    if (!result.ok || result.message.type !== "hello")
      throw new Error("expected a hello message");
    // 타입 검사(npm run typecheck)에서 HelloMessage로 좁혀져야 pod를 읽을 수 있습니다.
    expect(result.message.pod.name).toBe("orders-7d9f8-x2kq1");
  });

  it.each<Case>([
    { name: "text that is not JSON", input: "{", error: "not valid JSON" },
    {
      name: "a message without type",
      input: metricsWithoutType,
      error: "property 'type'",
    },
    {
      name: "an unknown type",
      input: { ...hello, type: "ping" },
      error: 'unknown message type: "ping"',
    },
    {
      name: "a type that is not a string",
      input: { ...hello, type: 3 },
      error: 'tag "type" must be string',
    },
    {
      name: "a server message",
      input: welcome,
      error: 'unknown message type: "welcome"',
    },
    {
      name: "a missing required field",
      input: helloWithoutPod,
      error: "property 'pod'",
    },
    {
      name: "a negative seq",
      input: { ...metrics, seq: -1 },
      error: "message/seq",
    },
    {
      name: "a fractional ts",
      input: { ...metrics, ts: 1.5 },
      error: "message/ts",
    },
    {
      name: "an unknown metric kind",
      input: {
        ...metrics,
        values: [{ name: "app.queue.length", kind: "histogram", value: 1 }],
      },
      error: "message/values/0/kind",
    },
    {
      name: "a metric name with capitals",
      input: {
        ...metrics,
        values: [{ name: "app.Queue", kind: "gauge", value: 1 }],
      },
      error: "message/values/0/name",
    },
    {
      name: "a metric name without a prefix",
      input: {
        ...metrics,
        values: [{ name: "queue_length", kind: "gauge", value: 1 }],
      },
      error: "message/values/0/name",
    },
    {
      name: "an event count of 0",
      input: { ...event, count: 0 },
      error: "message/count",
    },
    {
      name: "an unknown event level",
      input: { ...event, level: "fatal" },
      error: "message/level",
    },
    {
      name: "a failed response without error",
      input: { ...response, ok: false, data: undefined },
      error: "property 'error'",
    },
  ])("rejects $name", ({ input, error }) => {
    expectError(parseSdkMessage(toText(input)), error);
  });
});

describe("parseServerMessage", () => {
  it.each([welcome, reject, request, heartbeat])(
    "accepts the design.md example: $type",
    (message) => {
      expect(parseServerMessage(JSON.stringify(message))).toEqual({
        ok: true,
        message,
      });
    },
  );

  it("accepts a welcome without heartbeatIntervalMs from a server that sends no heartbeat", () => {
    expect(parseServerMessage(JSON.stringify(welcomeWithoutHeartbeat)).ok).toBe(
      true,
    );
  });

  it("accepts an unknown request action so the SDK can answer ok: false", () => {
    expect(
      parseServerMessage(JSON.stringify({ ...request, action: "threadDump" }))
        .ok,
    ).toBe(true);
  });

  it.each<Case>([
    { name: "text that is not JSON", input: "", error: "not valid JSON" },
    {
      name: "an SDK message",
      input: hello,
      error: 'unknown message type: "hello"',
    },
    {
      name: "a welcome without metricsIntervalMs",
      input: welcomeWithoutInterval,
      error: "property 'metricsIntervalMs'",
    },
    {
      name: "a welcome with heartbeatIntervalMs 0",
      input: { ...welcome, heartbeatIntervalMs: 0 },
      error: "message/heartbeatIntervalMs",
    },
    {
      name: "a request with an empty id",
      input: { ...request, id: "" },
      error: "message/id",
    },
  ])("rejects $name", ({ input, error }) => {
    expectError(parseServerMessage(toText(input)), error);
  });
});

describe("validateSnapshotData", () => {
  const { process: _process, ...dataWithoutProcess } = response.data;

  it("accepts the design.md example", () => {
    expect(validateSnapshotData(response.data)).toEqual({
      ok: true,
      message: response.data,
    });
  });

  it("accepts an empty state and no requests in flight", () => {
    expect(
      validateSnapshotData({ ...response.data, state: {}, inFlight: [] }).ok,
    ).toBe(true);
  });

  it.each<Case>([
    {
      name: "a missing process",
      input: dataWithoutProcess,
      error: "data must have required property 'process'",
    },
    {
      name: "a state value that is not a string",
      input: { ...response.data, state: { "app.mode": 1 } },
      error: "data/state/app.mode",
    },
    {
      name: "a negative elapsedMs",
      input: {
        ...response.data,
        inFlight: [{ route: "GET /orders", elapsedMs: -1 }],
      },
      error: "data/inFlight/0/elapsedMs",
    },
    {
      name: "a fractional heapUsedBytes",
      input: {
        ...response.data,
        process: { uptimeSec: 1, heapUsedBytes: 1.5 },
      },
      error: "data/process/heapUsedBytes",
    },
    { name: "a value that is not an object", input: null, error: "data" },
  ])("rejects $name", ({ input, error }) => {
    expectError(validateSnapshotData(input), error);
  });
});
