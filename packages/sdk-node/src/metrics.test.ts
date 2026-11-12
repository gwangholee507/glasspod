import type { MetricValue } from "@glasspod/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpCollector } from "./http.js";
import {
  MAX_TIMER_MS,
  MIN_METRICS_INTERVAL_MS,
  MetricsReporter,
  effectiveInterval,
} from "./metrics.js";
import { Registry } from "./registry.js";
import type { RuntimeSampler } from "./runtime.js";

describe("effectiveInterval", () => {
  it("keeps the server's interval within what the SDK and Node timers allow", () => {
    expect(effectiveInterval(5000)).toBe(5000);
    expect(effectiveInterval(1)).toBe(MIN_METRICS_INTERVAL_MS);
    expect(effectiveInterval(MIN_METRICS_INTERVAL_MS)).toBe(1000);
    expect(effectiveInterval(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_MS);
  });
});

describe("MetricsReporter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends runtime, http and app values every interval until end()", () => {
    vi.useFakeTimers();
    const runtime = {
      start: vi.fn(),
      stop: vi.fn(),
      collect: (): MetricValue[] => [
        { name: "runtime.heap.used_bytes", kind: "gauge", value: 100 },
      ],
    };
    const registry = new Registry();
    let queue = 0;
    registry.gauge("app.queue.length", () => queue++);
    // express()를 부른 앱처럼 미들웨어를 만들어 둡니다. 요청이 없으므로 counter와 in_flight만 나갑니다.
    const http = new HttpCollector();
    http.middleware();
    const httpValues: MetricValue[] = [
      { name: "http.requests.total", kind: "counter", value: 0 },
      { name: "http.requests.errors_total", kind: "counter", value: 0 },
      { name: "http.requests.aborted_total", kind: "counter", value: 0 },
      { name: "http.requests.in_flight", kind: "gauge", value: 0 },
    ];
    const sent: MetricValue[][] = [];
    const reporter = new MetricsReporter(
      runtime as unknown as RuntimeSampler,
      http,
      registry,
      (values) => sent.push(values),
    );

    // 서버가 준 10ms는 1000ms로 올리고, 첫 묶음은 한 주기 뒤에 보냅니다.
    reporter.begin(10);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([
      [
        { name: "runtime.heap.used_bytes", kind: "gauge", value: 100 },
        ...httpValues,
        { name: "app.queue.length", kind: "gauge", value: 0 },
      ],
      [
        { name: "runtime.heap.used_bytes", kind: "gauge", value: 100 },
        ...httpValues,
        { name: "app.queue.length", kind: "gauge", value: 1 },
      ],
      [
        { name: "runtime.heap.used_bytes", kind: "gauge", value: 100 },
        ...httpValues,
        { name: "app.queue.length", kind: "gauge", value: 2 },
      ],
    ]);

    reporter.end();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(3);
  });
});
