import type { PodRef } from "@glasspod/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PodSummary } from "../cluster.js";
import {
  MAX_CONNECTIONS_PER_POD,
  MAX_EVENTS_PER_POD,
  MAX_METRICS_PER_POD,
  MemoryStore,
} from "./memory.js";
import type { EventRecord, MetricsRecord } from "./store.js";

const POD: PodRef = { namespace: "shop", name: "orders-1" };
const OTHER: PodRef = { namespace: "shop", name: "orders-2" };

function metrics(receivedAt: number, pod: PodRef = POD): MetricsRecord {
  return {
    pod,
    instanceId: "a",
    seq: receivedAt,
    ts: receivedAt,
    receivedAt,
    values: [{ name: "runtime.heap.used_bytes", kind: "gauge", value: 1 }],
  };
}

function event(ts: number, receivedAt: number, name = "app.x"): EventRecord {
  return {
    pod: POD,
    instanceId: "a",
    seq: receivedAt,
    ts,
    receivedAt,
    level: "info",
    name,
    count: 1,
  };
}

function summary(name: string): PodSummary {
  return {
    namespace: "shop",
    name,
    uid: `uid-${name}`,
    phase: "Running",
    ready: false,
    terminating: true,
    restarts: 1,
    waiting: undefined,
    lastTermination: {
      container: "app",
      reason: "OOMKilled",
      exitCode: 137,
      finishedAt: undefined,
    },
    ip: "10.1.0.9",
    replicaSet: "orders-5f7c9",
    createdAt: undefined,
  };
}

describe("MemoryStore", () => {
  beforeEach(() => {
    // 서버 로그가 테스트 출력에 섞이지 않게 합니다.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps records per pod and filters them by received time", async () => {
    const store = new MemoryStore();
    await store.addMetrics(metrics(1_000));
    await store.addMetrics(metrics(2_000));
    await store.addMetrics(metrics(3_000, OTHER));
    await store.addConnection({
      pod: POD,
      instanceId: "a",
      change: "connected",
      at: 500,
    });

    const records = await store.podRecords(POD, 2_000);
    expect(records.metrics.map((record) => record.receivedAt)).toEqual([2_000]);
    expect(records.connections).toEqual([]);
    expect((await store.podRecords(POD, 0)).connections).toHaveLength(1);
    expect((await store.podRecords(OTHER, 0)).metrics).toHaveLength(1);
    expect(
      await store.podRecords({ namespace: "shop", name: "nope" }, 0),
    ).toEqual({ metrics: [], events: [], connections: [], deletions: [] });
  });

  it("keeps pods apart even when names contain a slash", async () => {
    const store = new MemoryStore();
    await store.addMetrics(metrics(1, { namespace: "a/b", name: "c" }));
    await store.addMetrics(metrics(2, { namespace: "a", name: "b/c" }));
    expect((await store.stats()).pods).toBe(2);
  });

  it("returns events in the order they happened", async () => {
    const store = new MemoryStore();
    // 다시 연결한 뒤 받은 event는 ts가 앞선 event보다 이를 수 있습니다.
    await store.addEvent(event(5_000, 5_000, "app.first"));
    await store.addEvent(event(1_000, 6_000, "app.buffered"));
    await store.addEvent(event(5_000, 7_000, "app.same-ts"));

    const { events } = await store.podRecords(POD, 0);
    expect(events.map((record) => record.name)).toEqual([
      "app.buffered",
      "app.first",
      "app.same-ts",
    ]);
  });

  it("drops the oldest records over the per-pod limits and counts them", async () => {
    const store = new MemoryStore();
    for (let index = 0; index < MAX_EVENTS_PER_POD + 3; index += 1) {
      await store.addEvent(event(index, index));
    }
    for (let index = 0; index < MAX_METRICS_PER_POD + 2; index += 1) {
      await store.addMetrics(metrics(index));
    }
    for (let index = 0; index < MAX_CONNECTIONS_PER_POD + 1; index += 1) {
      await store.addConnection({
        pod: POD,
        instanceId: "a",
        change: "connected",
        at: index,
      });
    }

    const { events, metrics: kept } = await store.podRecords(POD, 0);
    expect(events).toHaveLength(MAX_EVENTS_PER_POD);
    expect(events[0]?.receivedAt).toBe(3);
    expect(kept[0]?.receivedAt).toBe(2);
    const stats = await store.stats();
    expect(stats).toMatchObject({
      events: MAX_EVENTS_PER_POD,
      metrics: MAX_METRICS_PER_POD,
      connections: MAX_CONNECTIONS_PER_POD,
      droppedEvents: 3,
      droppedMetrics: 2,
      droppedConnections: 1,
    });
    // 기록 종류마다 처음 한 번만 경고합니다.
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it("prunes records older than the cutoff and reports pods with nothing left", async () => {
    const store = new MemoryStore();
    await store.addMetrics(metrics(1_000));
    await store.addEvent(event(500, 1_500));
    await store.addMetrics(metrics(3_000));
    await store.addMetrics(metrics(1_000, OTHER));

    const result = await store.prune(2_000);
    expect(result.expiredPods).toEqual([OTHER]);
    const records = await store.podRecords(POD, 0);
    expect(records.metrics.map((record) => record.receivedAt)).toEqual([3_000]);
    expect(records.events).toEqual([]);
    expect(await store.stats()).toMatchObject({ pods: 1, metrics: 1 });
  });

  it("keeps deleted pods until they expire", async () => {
    const store = new MemoryStore();
    await store.addDeletedPod({ pod: summary("orders-2"), deletedAt: 2_000 });
    await store.addDeletedPod({ pod: summary("orders-1"), deletedAt: 1_000 });

    const deleted = await store.deletedPods(0);
    expect(deleted.map((record) => record.pod.name)).toEqual([
      "orders-1",
      "orders-2",
    ]);
    expect(deleted[0]?.pod.lastTermination?.reason).toBe("OOMKilled");
    expect((await store.podRecords(POD, 0)).deletions).toHaveLength(1);
    expect((await store.stats()).deletedPods).toBe(2);

    const result = await store.prune(1_500);
    expect(result.expiredPods).toEqual([POD]);
    expect((await store.deletedPods(0)).map((r) => r.pod.name)).toEqual([
      "orders-2",
    ]);
  });
});
