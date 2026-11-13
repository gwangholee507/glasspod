import type { HelloMessage, ResponseMessage } from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import { AgentRegistry, AgentSession } from "./agents.js";
import { requestSnapshot, snapshotReply } from "./snapshot.js";

const hello: HelloMessage = {
  type: "hello",
  seq: 0,
  ts: 1,
  protocol: 1,
  sdk: { lang: "node", version: "0.0.0" },
  pod: { namespace: "shop", name: "orders-1" },
  instanceId: "a",
  capabilities: ["snapshot"],
};

const data = {
  state: { "app.mode": "draining" },
  inFlight: [{ route: "GET /orders/:id", elapsedMs: 8200 }],
  process: { uptimeSec: 3600, heapUsedBytes: 48234496 },
};

function answered(fields: Partial<ResponseMessage>) {
  const response: ResponseMessage = {
    type: "response",
    seq: 5,
    ts: 1793873740020,
    replyTo: "r-1",
    ok: true,
    data,
    ...fields,
  };
  return { status: "answered" as const, response, elapsedMs: 3 };
}

describe("snapshotReply", () => {
  it("returns 200 with the pod, the instance and the snapshot", () => {
    expect(snapshotReply(hello, answered({}))).toEqual({
      status: 200,
      body: {
        pod: { namespace: "shop", name: "orders-1" },
        instanceId: "a",
        ts: 1793873740020,
        elapsedMs: 3,
        snapshot: data,
      },
    });
  });

  it.each([
    [{ status: "busy" as const }, 429, "busy"],
    [{ status: "no-response" as const, timeoutMs: 5000 }, 504, "no-response"],
    [{ status: "disconnected" as const }, 502, "disconnected"],
    [answered({ ok: false, error: "snapshot failed" }), 502, "sdk-error"],
    [answered({ data: { state: {} } }), 502, "invalid-response"],
  ])("maps %o to %i %s", (outcome, status, error) => {
    const reply = snapshotReply(hello, outcome);
    expect(reply.status).toBe(status);
    expect(reply.body).toMatchObject({ error });
  });

  it("explains each failure in detail", () => {
    expect(
      snapshotReply(hello, { status: "no-response", timeoutMs: 5000 }).body,
    ).toEqual({ error: "no-response", detail: "no response within 5000ms" });
    expect(
      snapshotReply(hello, answered({ ok: false, error: "snapshot failed" }))
        .body,
    ).toEqual({ error: "sdk-error", detail: "snapshot failed" });
  });
});

describe("requestSnapshot", () => {
  it("answers 404 when the pod has no SDK connection", async () => {
    const reply = await requestSnapshot(new AgentRegistry(), hello.pod);
    expect(reply).toMatchObject({
      status: 404,
      body: { error: "not-connected" },
    });
  });

  it("answers 501 without sending when the SDK does not list snapshot", async () => {
    const agents = new AgentRegistry();
    const sent: string[] = [];
    const { capabilities: _capabilities, ...oldHello } = hello;
    agents.add(
      new AgentSession({
        hello: oldHello,
        fields: {},
        send: (text) => {
          sent.push(text);
          return true;
        },
      }),
    );
    const reply = await requestSnapshot(agents, hello.pod);
    expect(reply).toMatchObject({
      status: 501,
      body: { error: "not-supported" },
    });
    expect(sent).toEqual([]);
  });
});
