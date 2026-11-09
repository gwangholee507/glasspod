import { describe, expect, it } from "vitest";
import { MAX_DELAY_MS, reconnectDelay } from "./backoff.js";

describe("reconnectDelay", () => {
  it("doubles from 1s and stops at 30s", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 50].map((failures) =>
      reconnectDelay(failures, () => 0),
    );
    expect(delays).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  it("adds a random delay below 1s", () => {
    expect(reconnectDelay(1, () => 0.5)).toBe(1500);
    expect(reconnectDelay(1, () => 0.9999)).toBe(1999);
    expect(reconnectDelay(10, () => 0.9999)).toBe(MAX_DELAY_MS + 999);
  });

  it("does not overflow after many failures", () => {
    expect(reconnectDelay(5000, () => 0)).toBe(MAX_DELAY_MS);
  });
});
