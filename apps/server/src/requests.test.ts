import type { ResponseMessage } from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PENDING_REQUESTS,
  PendingRequests,
  REQUEST_TIMEOUT_MS,
} from "./requests.js";

function answer(replyTo: string): ResponseMessage {
  return { type: "response", seq: 1, ts: 1, replyTo, ok: true, data: {} };
}

describe("PendingRequests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pairs an answer with its request", async () => {
    const pending = new PendingRequests();
    const waiting = pending.add("r-1");
    vi.advanceTimersByTime(30);
    expect(pending.settle(answer("r-1"))).toBe(true);
    await expect(waiting).resolves.toMatchObject({
      status: "answered",
      response: { replyTo: "r-1" },
      elapsedMs: 30,
    });
  });

  it(`gives up after ${REQUEST_TIMEOUT_MS}ms and ignores the late answer`, async () => {
    const pending = new PendingRequests();
    const waiting = pending.add("r-1");
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    expect(pending.full).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(waiting).resolves.toEqual({
      status: "no-response",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(pending.settle(answer("r-1"))).toBe(false);
    expect(pending.settle(answer("r-unknown"))).toBe(false);
  });

  it(`is full with ${MAX_PENDING_REQUESTS} requests waiting`, () => {
    const pending = new PendingRequests();
    for (let i = 1; i <= MAX_PENDING_REQUESTS; i += 1) {
      expect(pending.full).toBe(false);
      void pending.add(`r-${i}`);
    }
    expect(pending.full).toBe(true);
    pending.settle(answer("r-1"));
    expect(pending.full).toBe(false);
  });

  it("ends every waiting request when the connection closes", async () => {
    const pending = new PendingRequests();
    const first = pending.add("r-1");
    const second = pending.add("r-2");
    pending.close();
    await expect(first).resolves.toEqual({ status: "disconnected" });
    await expect(second).resolves.toEqual({ status: "disconnected" });
    await expect(pending.add("r-3")).resolves.toEqual({
      status: "disconnected",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
