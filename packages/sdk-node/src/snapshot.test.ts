import { validateSnapshotData } from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import { answerRequest, buildSnapshot, describeAnswer } from "./snapshot.js";
import type { SnapshotSources } from "./snapshot.js";

const sources: SnapshotSources = {
  states: () => ({ "app.mode": "draining" }),
  inFlight: () => [{ route: "GET /orders/:id", elapsedMs: 8200 }],
};

describe("answerRequest", () => {
  it("answers snapshot with data that passes the protocol schema", () => {
    const content = answerRequest("snapshot", () => buildSnapshot(sources));
    expect(content.ok).toBe(true);
    expect(validateSnapshotData(content.data).ok).toBe(true);
    expect(content.data).toMatchObject({
      state: { "app.mode": "draining" },
      inFlight: [{ route: "GET /orders/:id", elapsedMs: 8200 }],
    });
    const { uptimeSec, heapUsedBytes } = buildSnapshot(sources).process;
    expect(uptimeSec).toBeGreaterThan(0);
    expect(Number.isInteger(heapUsedBytes)).toBe(true);
    expect(describeAnswer(content)).toBe("ok=true inFlight=1");
  });

  it("answers ok: false for an unknown action, with the action capped", () => {
    const content = answerRequest("threadDump", () => buildSnapshot(sources));
    expect(content).toEqual({
      ok: false,
      error: 'unknown action: "threadDump"',
    });
    expect(describeAnswer(content)).toBe(
      'ok=false error="unknown action: \\"threadDump\\""',
    );
    const long = answerRequest("x".repeat(500), () => buildSnapshot(sources));
    expect(long.error).toBe(`unknown action: "${"x".repeat(100)}..."`);
  });

  it("answers ok: false without internal details when building fails", () => {
    const content = answerRequest("snapshot", () => {
      throw new Error("secret detail");
    });
    expect(content).toEqual({ ok: false, error: "snapshot failed" });
  });
});
