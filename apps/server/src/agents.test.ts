import type { HelloMessage, ResponseMessage } from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, AgentSession } from "./agents.js";
import { MAX_PENDING_REQUESTS } from "./requests.js";

function hello(fields: Partial<HelloMessage> = {}): HelloMessage {
  return {
    type: "hello",
    seq: 0,
    ts: 1,
    protocol: 1,
    sdk: { lang: "node", version: "0.0.0" },
    pod: { namespace: "shop", name: "orders-1" },
    instanceId: "a",
    capabilities: ["snapshot"],
    ...fields,
  };
}

// 보낸 텍스트 프레임을 모으는 연결입니다. open이 false면 보내지 못합니다.
function session(options: { hello?: HelloMessage; open?: boolean } = {}): {
  session: AgentSession;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const created = new AgentSession({
    hello: options.hello ?? hello(),
    fields: { pod: "shop/orders-1" },
    send: (text) => {
      if (options.open === false) {
        return false;
      }
      sent.push(JSON.parse(text));
      return true;
    },
  });
  return { session: created, sent };
}

function answer(replyTo: string): ResponseMessage {
  return { type: "response", seq: 1, ts: 1, replyTo, ok: true, data: {} };
}

describe("AgentSession", () => {
  beforeEach(() => {
    // 서버 로그가 테스트 출력에 섞이지 않게 합니다.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a request and resolves with the matching response", async () => {
    const { session: agent, sent } = session();
    const waiting = agent.request("snapshot");
    expect(sent).toEqual([
      {
        type: "request",
        id: expect.stringMatching(/^r-\d+$/),
        action: "snapshot",
      },
    ]);
    const id = (sent[0] as { id: string }).id;
    expect(agent.receive(answer("r-unknown"))).toBe(false);
    expect(agent.receive(answer(id))).toBe(true);
    await expect(waiting).resolves.toMatchObject({ status: "answered" });
  });

  it("gives every request its own id", () => {
    const { session: agent, sent } = session();
    void agent.request("snapshot");
    void agent.request("snapshot");
    const [first, second] = sent as { id: string }[];
    expect(first?.id).not.toBe(second?.id);
  });

  it(`does not send more than ${MAX_PENDING_REQUESTS} requests at once`, async () => {
    const { session: agent, sent } = session();
    for (let i = 0; i < MAX_PENDING_REQUESTS; i += 1) {
      void agent.request("snapshot");
    }
    await expect(agent.request("snapshot")).resolves.toEqual({
      status: "busy",
    });
    expect(sent).toHaveLength(MAX_PENDING_REQUESTS);
  });

  it("reports disconnected when the socket is not open or closes", async () => {
    const closed = session({ open: false });
    await expect(closed.session.request("snapshot")).resolves.toEqual({
      status: "disconnected",
    });
    const { session: agent } = session();
    const waiting = agent.request("snapshot");
    agent.close();
    await expect(waiting).resolves.toEqual({ status: "disconnected" });
  });

  it("supports only the actions listed in capabilities", () => {
    expect(session().session.supports("snapshot")).toBe(true);
    expect(session().session.supports("threadDump")).toBe(false);
    const { capabilities: _capabilities, ...withoutCapabilities } = hello();
    expect(
      session({ hello: withoutCapabilities }).session.supports("snapshot"),
    ).toBe(false);
  });
});

describe("AgentRegistry", () => {
  it("keeps the newest connection of a pod", () => {
    const agents = new AgentRegistry();
    const older = session({ hello: hello({ instanceId: "a" }) }).session;
    const newer = session({ hello: hello({ instanceId: "b" }) }).session;
    expect(agents.add(older)).toBeUndefined();
    expect(agents.add(newer)).toBe(older);
    // 예전 연결이 나중에 닫혀도 새 연결은 남습니다.
    agents.remove(older);
    expect(agents.get({ namespace: "shop", name: "orders-1" })).toBe(newer);
    agents.remove(newer);
    expect(agents.get({ namespace: "shop", name: "orders-1" })).toBeUndefined();
  });

  it("does not mix up pods whose names contain a slash", () => {
    const agents = new AgentRegistry();
    const first = session({
      hello: hello({ pod: { namespace: "a/b", name: "c" } }),
    }).session;
    agents.add(first);
    expect(agents.get({ namespace: "a", name: "b/c" })).toBeUndefined();
    expect(agents.get({ namespace: "a/b", name: "c" })).toBe(first);
  });
});
