import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { WarnOnce } from "./log.js";
import {
  MAX_DATA_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_STACK_LINES,
  customEventContent,
  describeException,
  exceptionContent,
} from "./reports.js";

class TimeoutError extends Error {}

describe("describeException", () => {
  it("names errors by their name, then by their class", () => {
    expect(describeException(new TypeError("bad")).errorType).toBe("TypeError");
    expect(describeException(new TimeoutError("slow")).errorType).toBe(
      "TimeoutError",
    );
    expect(describeException(new Error("plain")).errorType).toBe("Error");

    const info = describeException(new RangeError("out of range"));
    expect(info.message).toBe("out of range");
    expect(info.stack).toMatch(/^RangeError: out of range\n\s+at /);
  });

  it("accepts values that are not errors", () => {
    expect(describeException("text")).toEqual({
      errorType: "string",
      message: "text",
    });
    expect(describeException(null)).toEqual({
      errorType: "null",
      message: "null",
    });
    expect(describeException(undefined)).toEqual({
      errorType: "undefined",
      message: "undefined",
    });
    // Error를 상속하지 않은 오류 객체도 예외로 봅니다.
    expect(describeException({ name: "AxiosError", message: "502" })).toEqual({
      errorType: "AxiosError",
      message: "502",
    });
    // 읽을 때 예외를 던지는 값도 SDK를 멈추지 않습니다.
    const hostile = new Error("x");
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("no stack");
      },
    });
    expect(describeException(hostile)).toEqual({
      errorType: "Error",
      message: "x",
    });
  });

  it("cuts long messages and stacks", () => {
    const error = new Error("m".repeat(MAX_MESSAGE_CHARS + 10));
    error.stack = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const info = describeException(error);
    expect(info.message).toBe(`${"m".repeat(MAX_MESSAGE_CHARS)}...`);
    expect(info.stack?.split("\n")).toHaveLength(MAX_STACK_LINES + 1);
    expect(info.stack?.endsWith("line 49\n...")).toBe(true);
  });
});

describe("event content", () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("builds an exception event with the app's data and the SDK's fields", () => {
    const content = exceptionContent(
      new TimeoutError("DB timeout after 5000ms"),
      { route: "GET /orders", errorType: "ignored" },
      { origin: "uncaughtException", fatal: true },
      new WarnOnce(),
    );
    expect(content).toMatchObject({
      level: "error",
      name: "exception",
      message: "DB timeout after 5000ms",
      data: {
        route: "GET /orders",
        errorType: "TimeoutError",
        origin: "uncaughtException",
        fatal: true,
      },
    });
    expect(Object.keys(content.data ?? {})).toEqual([
      "route",
      "errorType",
      "stack",
      "origin",
      "fatal",
    ]);
  });

  it("builds a custom event and copies its data", () => {
    const data = { keys: 1200 };
    const content = customEventContent(
      "app.cache.cleared",
      { level: "warn", message: "evicted", data },
      new WarnOnce(),
    );
    data.keys = 0;
    expect(content).toEqual({
      level: "warn",
      name: "app.cache.cleared",
      message: "evicted",
      data: { keys: 1200 },
    });
    expect(
      customEventContent("app.started", undefined, new WarnOnce()),
    ).toEqual({
      level: "info",
      name: "app.started",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores events with a bad name, level or message, warning once each", () => {
    const warnings = new WarnOnce();
    const bad: [unknown, unknown][] = [
      ["cache.cleared", undefined],
      ["exception", undefined],
      ["app.Cache", undefined],
      [42, undefined],
      ["app.cache.cleared", "warn"],
      ["app.cache.cleared", { level: "fatal" }],
      ["app.cache.cleared", { message: 42 }],
    ];
    for (const [name, options] of bad) {
      expect(customEventContent(name, options, warnings)).toBeUndefined();
      expect(customEventContent(name, options, warnings)).toBeUndefined();
    }
    expect(warnSpy).toHaveBeenCalledTimes(bad.length);
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      '[glasspod] event ignored: "cache.cleared" must start with "app." and use lowercase letters, digits and _ in each level',
    );
  });

  it("sends the event without data when data cannot be sent", () => {
    const warnings = new WarnOnce();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const cases: unknown[] = [
      [1, 2],
      "text",
      circular,
      { big: 1n },
      { text: "x".repeat(MAX_DATA_CHARS) },
    ];
    for (const data of cases) {
      expect(customEventContent("app.job.done", { data }, warnings)).toEqual({
        level: "info",
        name: "app.job.done",
      });
    }
    const messages = warnSpy.mock.calls.map((call) => call[0]);
    expect(messages).toEqual([
      '[glasspod] event "app.job.done" sent without data: data must be a plain object',
      '[glasspod] event "app.job.done" sent without data: data cannot be converted to JSON (Converting circular structure to JSON)',
      `[glasspod] event "app.job.done" sent without data: data is longer than ${MAX_DATA_CHARS} characters as JSON`,
    ]);
  });
});
