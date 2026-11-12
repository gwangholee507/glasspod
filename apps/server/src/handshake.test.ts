import { describe, expect, it } from "vitest";
import { decideHello } from "./handshake.js";

const settings = {
  metricsIntervalMs: 5000,
  maxEventsPerMinute: 120,
  heartbeatIntervalMs: 15000,
};

// design.md 7.3의 hello 예시입니다.
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

const { pod: _pod, ...helloWithoutPod } = hello;
const { sdk: _sdk, ...helloWithoutSdk } = hello;

describe("decideHello", () => {
  it("accepts a valid hello and replies with the configured welcome", () => {
    const decision = decideHello(JSON.stringify(hello), settings);
    expect(decision).toEqual({
      accepted: true,
      hello,
      welcome: {
        type: "welcome",
        metricsIntervalMs: 5000,
        maxEventsPerMinute: 120,
        heartbeatIntervalMs: 15000,
      },
    });
  });

  it("accepts a hello with unknown fields", () => {
    const text = JSON.stringify({ ...hello, region: "kr" });
    expect(decideHello(text, settings).accepted).toBe(true);
  });

  it.each([
    { name: "text that is not JSON", text: "hello", detail: "not valid JSON" },
    {
      name: "another message first",
      text: JSON.stringify({ type: "metrics", seq: 0, ts: 1, values: [] }),
      detail: "got metrics",
    },
    {
      name: "a hello without pod",
      text: JSON.stringify(helloWithoutPod),
      detail: "property 'pod'",
    },
    {
      name: "a protocol that is not an integer",
      text: JSON.stringify({ ...hello, protocol: "1" }),
      detail: "message/protocol",
    },
  ])("rejects $name as invalid-hello", ({ text, detail }) => {
    const decision = decideHello(text, settings);
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.reason).toBe("invalid-hello");
      expect(decision.detail).toContain(detail);
    }
  });

  it("rejects another protocol version before checking the v1 shape", () => {
    // v2 hello는 v1 스키마에 맞지 않을 수 있지만, 이유는 unsupported-protocol이어야 합니다.
    const decision = decideHello(
      JSON.stringify({ ...helloWithoutSdk, protocol: 2 }),
      settings,
    );
    expect(decision).toMatchObject({
      accepted: false,
      reason: "unsupported-protocol",
    });
  });
});
