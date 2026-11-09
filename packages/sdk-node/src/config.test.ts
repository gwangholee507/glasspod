import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

const valid = {
  GLASSPOD_SERVER: "ws://glasspod-server.glasspod.svc.cluster.local:8080/agent",
  POD_NAME: "orders-7d9f8-x2kq1",
  POD_NAMESPACE: "shop",
};

describe("readConfig", () => {
  it("reads the server address and pod from the environment", () => {
    expect(readConfig({ ...valid, POD_NAME: "  orders-1  " })).toEqual({
      ok: true,
      config: {
        serverUrl: valid.GLASSPOD_SERVER,
        pod: { namespace: "shop", name: "orders-1" },
      },
    });
  });

  it("accepts wss://", () => {
    const result = readConfig({
      ...valid,
      GLASSPOD_SERVER: "wss://g.example/agent",
    });
    expect(result.ok).toBe(true);
  });

  it("lists every missing or empty value", () => {
    expect(readConfig({ POD_NAME: " " })).toEqual({
      ok: false,
      problems: [
        "GLASSPOD_SERVER is not set",
        "POD_NAME is not set",
        "POD_NAMESPACE is not set",
      ],
    });
  });

  it.each([
    [
      "http://localhost:8080/agent",
      'GLASSPOD_SERVER must start with ws:// or wss:// (got "http:")',
    ],
    [
      "localhost:8080/agent",
      'GLASSPOD_SERVER must start with ws:// or wss:// (got "localhost:")',
    ],
    ["not a url", "GLASSPOD_SERVER is not a valid URL"],
    ["ws://localhost:8080/agent#", "GLASSPOD_SERVER must not contain #"],
  ])("rejects the server address %s", (server, problem) => {
    expect(readConfig({ ...valid, GLASSPOD_SERVER: server })).toEqual({
      ok: false,
      problems: [problem],
    });
  });
});
