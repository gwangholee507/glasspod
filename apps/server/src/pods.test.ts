import type {
  EventMessage,
  HelloMessage,
  MetricValue,
  MetricsMessage,
  PodRef,
} from "@glasspod/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PodSummary } from "./cluster.js";
import { AppStates, MAX_METRIC_NAMES_PER_POD } from "./pods.js";
import type { AppConnection } from "./pods.js";
import { MemoryStore } from "./store/memory.js";
import { RETENTION_MS } from "./store/store.js";
import type { StoredMetric } from "./store/store.js";

const POD: PodRef = { namespace: "shop", name: "orders-1" };

function connection(instanceId: string, seq = 0): AppConnection {
  const hello: HelloMessage = {
    type: "hello",
    seq,
    ts: 1,
    protocol: 1,
    sdk: { lang: "node", version: "0.1.0" },
    pod: POD,
    instanceId,
    app: { name: "orders" },
  };
  return { hello };
}

function metrics(seq: number, values: MetricValue[]): MetricsMessage {
  return { type: "metrics", seq, ts: 1_000 + seq, values };
}

function counter(name: string, value: number): MetricValue {
  return { name, kind: "counter", value };
}

function event(seq: number, ts: number): EventMessage {
  return {
    type: "event",
    seq,
    ts,
    level: "error",
    name: "exception",
    message: "boom",
    count: 1,
    data: { errorType: "Error" },
  };
}

// 가짜 시계와 메모리 저장소를 쓰는 AppStates입니다.
function setup(): {
  apps: AppStates;
  store: MemoryStore;
  clock: { now: number };
} {
  const clock = { now: 10_000 };
  const store = new MemoryStore();
  return { apps: new AppStates(store, () => clock.now), store, clock };
}

async function storedMetrics(store: MemoryStore): Promise<StoredMetric[][]> {
  const records = await store.podRecords(POD, 0);
  return records.metrics.map((record) => record.values);
}

function warnLines(): string[] {
  return vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
}

function infoLines(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
}

describe("AppStates", () => {
  beforeEach(() => {
    // 서버 로그가 테스트 출력에 섞이지 않게 하고, 내용을 확인합니다.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("tracks the current state of a connected pod", async () => {
    const { apps, store, clock } = setup();
    const first = connection("a");
    apps.connect(first);
    clock.now = 15_000;
    apps.receive(
      first,
      metrics(1, [
        { name: "runtime.heap.used_bytes", kind: "gauge", value: 42 },
      ]),
    );

    const state = apps.get(POD);
    expect(state).toMatchObject({
      instanceId: "a",
      sdk: "node@0.1.0",
      app: { name: "orders" },
      connected: true,
      connectedAt: 10_000,
      lastMessageAt: 15_000,
      lastMetricsAt: 15_000,
      lastSeq: 1,
      missed: 0,
    });
    expect(state?.values.get("runtime.heap.used_bytes")).toEqual({
      kind: "gauge",
      value: 42,
      ts: 1_001,
      receivedAt: 15_000,
    });

    clock.now = 20_000;
    apps.disconnect(first, 1006);
    expect(apps.get(POD)).toMatchObject({
      connected: false,
      disconnectedAt: 20_000,
    });
    const { connections, metrics: records } = await store.podRecords(POD, 0);
    expect(connections).toEqual([
      {
        pod: POD,
        instanceId: "a",
        change: "connected",
        at: 10_000,
        sdk: "node@0.1.0",
        app: { name: "orders" },
      },
      {
        pod: POD,
        instanceId: "a",
        change: "disconnected",
        at: 20_000,
        code: 1006,
      },
    ]);
    expect(records[0]).toMatchObject({
      instanceId: "a",
      seq: 1,
      ts: 1_001,
      receivedAt: 15_000,
    });
  });

  it("computes counter increases and detects resets", async () => {
    const { apps, store } = setup();
    const first = connection("a");
    apps.connect(first);
    apps.receive(first, metrics(1, [counter("http.requests.total", 10)]));
    apps.receive(first, metrics(2, [counter("http.requests.total", 15)]));
    // 같은 instance에서 값이 줄면 리셋으로 봅니다.
    apps.receive(first, metrics(3, [counter("http.requests.total", 4)]));
    apps.disconnect(first, 1006);
    // 컨테이너가 다시 시작되면 instance가 바뀌고 counter는 0부터 셉니다.
    const second = connection("b");
    apps.connect(second);
    apps.receive(second, metrics(1, [counter("http.requests.total", 20)]));
    apps.receive(second, metrics(2, [counter("http.requests.total", 26)]));

    expect(await storedMetrics(store)).toEqual([
      [{ name: "http.requests.total", kind: "counter", value: 10 }],
      [
        {
          name: "http.requests.total",
          kind: "counter",
          value: 15,
          increase: 5,
        },
      ],
      [
        {
          name: "http.requests.total",
          kind: "counter",
          value: 4,
          increase: 4,
          reset: true,
        },
      ],
      [
        {
          name: "http.requests.total",
          kind: "counter",
          value: 20,
          increase: 20,
          reset: true,
        },
      ],
      [
        {
          name: "http.requests.total",
          kind: "counter",
          value: 26,
          increase: 6,
        },
      ],
    ]);
    expect(warnLines().some((line) => line.includes("cause=decreased"))).toBe(
      true,
    );
    expect(
      infoLines().some(
        (line) =>
          line.includes("counter reset") && line.includes("cause=new-instance"),
      ),
    ).toBe(true);
    expect(
      infoLines().some(
        (line) =>
          line.includes("instance changed") && line.includes("previous=a"),
      ),
    ).toBe(true);
    // 새 instance가 붙으면 seq와 마지막 값은 새로 셉니다.
    expect(apps.get(POD)).toMatchObject({
      instanceId: "b",
      lastSeq: 2,
      missed: 0,
    });
  });

  it("counts seq gaps as missing messages, also across reconnects", async () => {
    const { apps, store } = setup();
    const first = connection("a", 0);
    apps.connect(first);
    apps.receive(first, metrics(1, []));
    apps.receive(first, metrics(4, []));
    apps.receive(first, event(5, 900));
    apps.disconnect(first, 1006);
    // 같은 instance가 다시 붙을 때 hello의 seq가 7이면 6을 잃은 것입니다.
    const again = connection("a", 7);
    apps.connect(again);

    expect(apps.get(POD)).toMatchObject({ lastSeq: 7, missed: 3 });
    expect(
      warnLines().filter((line) => line.includes("messages missing")),
    ).toHaveLength(2);
    const { connections, events } = await store.podRecords(POD, 0);
    expect(connections.map((record) => record.newInstance)).toEqual([
      undefined,
      undefined,
      false,
    ]);
    expect(events).toHaveLength(1);
  });

  it("warns about seq going backwards without moving lastSeq", () => {
    const { apps } = setup();
    const first = connection("a", 0);
    apps.connect(first);
    apps.receive(first, metrics(3, []));
    apps.receive(first, metrics(2, []));
    apps.receive(first, metrics(3, []));

    expect(apps.get(POD)).toMatchObject({ lastSeq: 3, missed: 2 });
    expect(
      warnLines().filter((line) => line.includes("message out of order")),
    ).toHaveLength(2);
  });

  it("drops new metric names over the per-pod limit", async () => {
    const { apps, store } = setup();
    const first = connection("a");
    apps.connect(first);
    const values: MetricValue[] = [];
    for (let index = 0; index <= MAX_METRIC_NAMES_PER_POD; index += 1) {
      values.push({ name: `app.m${index}`, kind: "gauge", value: index });
    }
    apps.receive(first, metrics(1, values));
    apps.receive(
      first,
      metrics(2, [{ name: "app.m0", kind: "gauge", value: 1 }]),
    );
    apps.receive(
      first,
      metrics(3, [{ name: "app.extra", kind: "gauge", value: 1 }]),
    );

    const stored = await storedMetrics(store);
    expect(stored[0]).toHaveLength(MAX_METRIC_NAMES_PER_POD);
    expect(stored[1]).toHaveLength(1);
    expect(stored[2]).toEqual([]);
    expect(
      warnLines().filter((line) => line.includes("metric names over limit")),
    ).toHaveLength(1);
  });

  it("records messages from a replaced connection without changing the current state", async () => {
    const { apps, store } = setup();
    const old = connection("a", 0);
    apps.connect(old);
    apps.receive(old, metrics(1, [counter("http.requests.total", 10)]));
    // 예전 연결이 닫히기 전에 새 instance가 붙음(같은 이름의 Pod를 다시 만든 경우).
    const replacement = connection("b", 0);
    apps.connect(replacement);
    apps.receive(replacement, metrics(1, [counter("http.requests.total", 3)]));
    apps.receive(old, metrics(2, [counter("http.requests.total", 12)]));
    apps.receive(old, event(3, 2_000));
    apps.disconnect(old, 1006);

    expect(apps.get(POD)).toMatchObject({
      instanceId: "b",
      connected: true,
      lastSeq: 1,
    });
    expect(apps.get(POD)?.values.get("http.requests.total")?.value).toBe(3);
    const records = await store.podRecords(POD, 0);
    expect(records.metrics.map((record) => record.instanceId)).toEqual([
      "a",
      "b",
      "a",
    ]);
    // 예전 연결의 counter는 증가량 없이 기록만 합니다.
    expect(records.metrics[2]?.values[0]).toEqual({
      name: "http.requests.total",
      kind: "counter",
      value: 12,
    });
    expect(records.events.map((record) => record.instanceId)).toEqual(["a"]);
    // 예전 연결이 닫힌 것은 기록하지 않습니다.
    expect(records.connections.map((record) => record.change)).toEqual([
      "connected",
      "connected",
    ]);
    expect(records.connections[1]?.newInstance).toBe(true);
  });

  it("keeps a deleted pod and prunes everything after the retention time", async () => {
    const { apps, store, clock } = setup();
    const first = connection("a");
    apps.connect(first);
    apps.receive(first, event(1, 9_000));
    apps.disconnect(first, 1001);
    const deleted: PodSummary = {
      namespace: POD.namespace,
      name: POD.name,
      uid: "uid-1",
      phase: "Running",
      ready: false,
      terminating: true,
      restarts: 0,
      waiting: undefined,
      lastTermination: undefined,
      ip: undefined,
      replicaSet: undefined,
      createdAt: undefined,
    };
    apps.podDeleted(deleted);
    expect(await store.deletedPods(0)).toEqual([
      { pod: deleted, deletedAt: 10_000 },
    ]);

    // 30분이 되기 전에는 남아 있습니다.
    clock.now = 10_000 + RETENTION_MS;
    await apps.prune();
    expect(apps.get(POD)).toBeDefined();
    expect((await store.stats()).pods).toBe(1);

    clock.now = 10_001 + RETENTION_MS;
    await apps.prune();
    expect(apps.get(POD)).toBeUndefined();
    expect(await store.stats()).toMatchObject({ pods: 0, deletedPods: 0 });
    expect(
      infoLines().some(
        (line) =>
          line.includes("pod history expired") &&
          line.includes("pod=shop/orders-1"),
      ),
    ).toBe(true);
  });

  it("keeps the state of a pod that is still connected", async () => {
    const { apps, clock } = setup();
    apps.connect(connection("a"));
    clock.now = 10_000 + 2 * RETENTION_MS;
    await apps.prune();
    expect(apps.get(POD)?.connected).toBe(true);
  });

  it("logs store stats in one line", async () => {
    const { apps } = setup();
    const first = connection("a");
    apps.connect(first);
    apps.receive(first, metrics(1, [counter("http.requests.total", 1)]));
    await apps.logStats();

    const line = infoLines().find((text) => text.includes("store stats"));
    expect(line).toContain(
      "store=memory pods=1 apps=1 connected=1 metrics=1 events=0 connections=1 deletedPods=0",
    );
    expect(line).toMatch(/heapUsedMb=\d/);
  });
});
