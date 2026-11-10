import { parseSdkMessage } from "@glasspod/protocol";
import type { MetricValue } from "@glasspod/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeSampler } from "./runtime.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 이벤트 루프를 ms 동안 막습니다.
function block(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 일부러 아무것도 하지 않습니다.
  }
}

function valueOf(values: MetricValue[], name: string): number | undefined {
  return values.find((value) => value.name === name)?.value;
}

describe("RuntimeSampler", () => {
  const sampler = new RuntimeSampler();

  afterEach(() => {
    sampler.stop();
  });

  it("reports the runtime metrics as a valid metrics message", async () => {
    sampler.start();
    await wait(100);
    const values = sampler.collect();

    // 컨테이너 메모리 한도는 알 수 있을 때만 들어갑니다.
    expect(
      values
        .map(({ name, kind }) => `${kind} ${name}`)
        .filter((entry) => !entry.endsWith("runtime.memory.limit_bytes")),
    ).toEqual([
      "gauge runtime.event_loop.lag_p50_ms",
      "gauge runtime.event_loop.lag_p99_ms",
      "gauge runtime.event_loop.lag_max_ms",
      "gauge runtime.event_loop.utilization",
      "gauge runtime.heap.used_bytes",
      "gauge runtime.heap.total_bytes",
      "gauge runtime.heap.limit_bytes",
      "gauge runtime.memory.rss_bytes",
      "counter runtime.cpu.user_ms",
      "counter runtime.cpu.system_ms",
    ]);
    const message = { type: "metrics", seq: 1, ts: Date.now(), values };
    expect(parseSdkMessage(JSON.stringify(message)).ok).toBe(true);
  });

  it("catches an event loop block that starts right after collect()", async () => {
    sampler.start();
    await wait(60);
    sampler.collect();
    block(150);
    await wait(60);
    const values = sampler.collect();

    // 측정 간격(20ms)만큼은 덜 보일 수 있습니다.
    expect(valueOf(values, "runtime.event_loop.lag_max_ms")).toBeGreaterThan(
      120,
    );
    expect(valueOf(values, "runtime.event_loop.utilization")).toBeGreaterThan(
      0.5,
    );
  });
});
