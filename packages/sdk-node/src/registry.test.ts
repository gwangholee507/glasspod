import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { MAX_APP_METRICS, Registry } from "./registry.js";

describe("Registry", () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("collects gauges and counters in registration order", () => {
    const registry = new Registry();
    let length = 3;
    registry.gauge("app.queue.length", () => length);
    const created = registry.counter("app.orders.created");
    created.inc();
    created.inc(2.5);
    length = 7;

    expect(registry.collect()).toEqual([
      { name: "app.queue.length", kind: "gauge", value: 7 },
      { name: "app.orders.created", kind: "counter", value: 3.5 },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores names outside the app.* rule without throwing", () => {
    const registry = new Registry();
    const names = [
      "queue.length",
      "app",
      "app.Queue",
      "app..length",
      "app.1st",
      "runtime.heap.used_bytes",
      "app.queue-length",
    ];
    for (const name of names) {
      registry.gauge(name, () => 1);
      expect(() => registry.counter(name).inc()).not.toThrow();
    }
    // 타입을 어긴 JavaScript 호출도 예외 없이 무시합니다.
    const untyped = registry as unknown as {
      gauge(name: unknown, read: unknown): void;
      counter(name: unknown): { inc(amount?: unknown): void };
    };
    untyped.gauge(42, () => 1);
    untyped.gauge("app.queue.length", 42);
    expect(() => untyped.counter(undefined).inc()).not.toThrow();

    expect(registry.collect()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(names.length * 2 + 3);
    expect(warnSpy).toHaveBeenCalledWith(
      '[glasspod] metric ignored: "queue.length" must start with "app." and use lowercase letters, digits and _ in each level',
    );
  });

  it("shares a counter by name, replaces a gauge, and refuses a kind change", () => {
    const registry = new Registry();
    registry.counter("app.jobs.done").inc();
    registry.counter("app.jobs.done").inc(4);
    registry.gauge("app.queue.length", () => 1);
    registry.gauge("app.queue.length", () => 2);
    registry.gauge("app.jobs.done", () => 99);
    registry.counter("app.queue.length").inc(10);

    expect(registry.collect()).toEqual([
      { name: "app.jobs.done", kind: "counter", value: 5 },
      { name: "app.queue.length", kind: "gauge", value: 2 },
    ]);
    expect(warnSpy.mock.calls).toEqual([
      [
        '[glasspod] metric ignored: "app.jobs.done" is already registered as a counter',
      ],
      [
        '[glasspod] metric ignored: "app.queue.length" is already registered as a gauge',
      ],
    ]);
  });

  it("skips a gauge whose callback fails and warns once per name", () => {
    const registry = new Registry();
    registry.gauge("app.throws", () => {
      throw new Error("boom");
    });
    registry.gauge("app.not_a_number", () => Number.NaN);
    registry.gauge("app.infinite", () => Number.POSITIVE_INFINITY);
    registry.gauge("app.text", () => "12" as unknown as number);
    registry.gauge("app.async", (async () => 1) as unknown as () => number);
    registry.gauge("app.ok", () => 1);

    expect(registry.collect()).toEqual([
      { name: "app.ok", kind: "gauge", value: 1 },
    ]);
    expect(registry.collect()).toHaveLength(1);
    expect(warnSpy.mock.calls).toEqual([
      ['[glasspod] gauge "app.throws" skipped: callback threw (boom)'],
      [
        '[glasspod] gauge "app.not_a_number" skipped: callback returned NaN, not a finite number',
      ],
      [
        '[glasspod] gauge "app.infinite" skipped: callback returned Infinity, not a finite number',
      ],
      [
        '[glasspod] gauge "app.text" skipped: callback returned a string, not a finite number',
      ],
      [
        '[glasspod] gauge "app.async" skipped: callback returned a Promise, not a finite number',
      ],
    ]);
  });

  it("ignores counter amounts that would not keep the total growing", () => {
    const registry = new Registry();
    const counter = registry.counter("app.orders.created");
    counter.inc(-1);
    counter.inc(Number.NaN);
    counter.inc(Number.POSITIVE_INFINITY);
    (counter.inc as (amount: unknown) => void)("3");
    counter.inc(0);
    counter.inc();

    expect(registry.collect()).toEqual([
      { name: "app.orders.created", kind: "counter", value: 1 },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[glasspod] counter "app.orders.created" ignored inc(-1): the amount must be a finite number >= 0',
    );
  });

  it(`stops at ${MAX_APP_METRICS} app metrics and warns once`, () => {
    const registry = new Registry();
    for (let i = 0; i < MAX_APP_METRICS + 5; i++) {
      registry.gauge(`app.user_${i}`, () => i);
    }
    // 이미 있는 이름은 상한과 상관없이 그대로 쓸 수 있습니다.
    registry.gauge("app.user_0", () => -1);

    const values = registry.collect();
    expect(values).toHaveLength(MAX_APP_METRICS);
    expect(values[0]).toEqual({ name: "app.user_0", kind: "gauge", value: -1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[glasspod] metric ignored: "app.user_${MAX_APP_METRICS}": at most ${MAX_APP_METRICS} app metrics can be registered`,
    );
  });
});
