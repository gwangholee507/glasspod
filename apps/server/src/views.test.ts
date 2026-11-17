import { describe, expect, it } from "vitest";
import type { PodSummary } from "./cluster.js";
import type { AppState, CounterIncrease, LatestValue } from "./pods.js";
import type { PodStatusEntry } from "./status-monitor.js";
import type {
  EventRecord,
  MetricsRecord,
  PodRecords,
  StoredMetric,
} from "./store/store.js";
import {
  MAX_SERIES_SIBLINGS,
  listMetrics,
  metricSeriesBody,
  parseMetricsQuery,
  parseNamespaceQuery,
  podDetail,
  podItem,
  podSeries,
  seriesPods,
} from "./views.js";

const NOW = 1_000_000;
const POD = { namespace: "shop", name: "orders-1" };

function gauge(value: number): LatestValue {
  return { kind: "gauge", value, ts: NOW - 900, receivedAt: NOW - 1_000 };
}

function app(
  values: Record<string, LatestValue> = {},
  increases: Record<string, CounterIncrease[]> = {},
  fields: Partial<AppState> = {},
): AppState {
  return {
    pod: POD,
    instanceId: "b",
    sdk: "node@0.1.0",
    app: { name: "orders" },
    instanceSince: NOW - 60_000,
    previousInstanceId: "a",
    deletedAt: undefined,
    connected: true,
    connectedAt: NOW - 60_000,
    disconnectedAt: undefined,
    lastMessageAt: NOW - 1_000,
    lastMetricsAt: NOW - 1_000,
    lastSeq: 12,
    missed: 0,
    values: new Map(Object.entries(values)),
    increases: new Map(Object.entries(increases)),
    ...fields,
  };
}

function summary(fields: Partial<PodSummary> = {}): PodSummary {
  return {
    namespace: "shop",
    name: "orders-1",
    uid: "uid-1",
    phase: "Running",
    ready: true,
    terminating: false,
    restarts: 1,
    waiting: undefined,
    lastTermination: {
      container: "app",
      reason: "OOMKilled",
      exitCode: 137,
      finishedAt: "2026-11-16T00:00:00Z",
    },
    ip: "10.1.0.5",
    replicaSet: "orders-5f7c9",
    createdAt: "2026-11-15T00:00:00Z",
    ...fields,
  };
}

function entry(fields: Partial<PodStatusEntry> = {}): PodStatusEntry {
  return {
    pod: POD,
    status: "restarted",
    severity: "warning",
    reason: "OOMKilled",
    since: NOW - 30_000,
    deployment: "orders",
    restart: {
      at: NOW - 31_000,
      reason: "OOMKilled",
      exitCode: 137,
      previousInstanceId: "a",
    },
    ...fields,
  };
}

function event(
  instanceId: string,
  ts: number,
  level: EventRecord["level"],
): EventRecord {
  return {
    pod: POD,
    instanceId,
    seq: ts,
    ts,
    receivedAt: ts,
    level,
    name: level === "error" ? "exception" : "state",
    count: 1,
  };
}

describe("listMetrics", () => {
  it("reads the last values and sums 5xx of the last minute", () => {
    const metrics = listMetrics(
      app(
        {
          "runtime.event_loop.lag_p99_ms": gauge(10.6),
          "runtime.heap.used_bytes": gauge(21_000_000),
          "runtime.heap.limit_bytes": gauge(540_000_000),
          "http.requests.duration_p99_ms": gauge(31.2),
          "http.requests.errors_total": { ...gauge(9), kind: "counter" },
        },
        {
          "http.requests.errors_total": [
            { at: NOW - 61_000, increase: 100 },
            { at: NOW - 60_000, increase: 2 },
            { at: NOW - 5_000, increase: 3 },
          ],
        },
      ),
      NOW,
    );
    expect(metrics).toEqual({
      eventLoopP99Ms: 10.6,
      heapUsedBytes: 21_000_000,
      heapLimitBytes: 540_000_000,
      httpP99Ms: 31.2,
      http5xxPerMinute: 5,
    });
  });

  it("leaves out metrics the instance does not send", () => {
    expect(listMetrics(undefined, NOW)).toEqual({});
    expect(
      listMetrics(app({ "runtime.heap.used_bytes": gauge(1) }), NOW),
    ).toEqual({ heapUsedBytes: 1 });
    // counter가 있으면 최근 1분에 늘어난 것이 없어도 0입니다.
    expect(
      listMetrics(
        app({ "http.requests.errors_total": { ...gauge(0), kind: "counter" } }),
        NOW,
      ),
    ).toEqual({ http5xxPerMinute: 0 });
  });
});

describe("podItem", () => {
  it("combines the judgment, Kubernetes and the SDK without silentMs", () => {
    const item = podItem(
      entry({ silentMs: 15_000 }),
      summary(),
      app({ "runtime.heap.used_bytes": gauge(5) }),
      NOW,
    );
    expect(item).toEqual({
      pod: POD,
      deployment: "orders",
      status: "restarted",
      severity: "warning",
      reason: "OOMKilled",
      since: NOW - 30_000,
      restart: {
        at: NOW - 31_000,
        reason: "OOMKilled",
        exitCode: 137,
        previousInstanceId: "a",
      },
      kube: {
        uid: "uid-1",
        phase: "Running",
        ready: true,
        terminating: false,
        restarts: 1,
        lastTermination: {
          container: "app",
          reason: "OOMKilled",
          exitCode: 137,
          finishedAt: "2026-11-16T00:00:00Z",
        },
        ip: "10.1.0.5",
        replicaSet: "orders-5f7c9",
        createdAt: "2026-11-15T00:00:00Z",
      },
      sdk: {
        connected: true,
        instanceId: "b",
        sdk: "node@0.1.0",
        app: { name: "orders" },
        instanceSince: NOW - 60_000,
        connectedAt: NOW - 60_000,
        lastMetricsAt: NOW - 1_000,
        missed: 0,
      },
      metrics: { heapUsedBytes: 5 },
    });
    // JSON으로 바꿔도 undefined 필드가 남지 않습니다(바뀐 것 비교가 흔들리지 않음).
    expect(JSON.stringify(item)).not.toContain("undefined");
  });

  it("leaves out kube and sdk when the pod is only on one side", () => {
    const item = podItem(
      entry({
        status: "no-sdk",
        severity: "none",
        reason: undefined,
        restart: undefined,
        deployment: undefined,
      }),
      summary({ lastTermination: undefined, ip: undefined }),
      undefined,
      NOW,
    );
    expect(item).not.toHaveProperty("sdk");
    expect(item).not.toHaveProperty("deployment");
    expect(item.kube).not.toHaveProperty("lastTermination");
    expect(item.metrics).toEqual({});
  });
});

describe("podDetail", () => {
  it("returns values by name and restart causes of the previous instance", () => {
    const records: PodRecords = {
      metrics: [],
      events: [
        event("a", 1, "info"),
        event("a", 2, "error"),
        event("b", 3, "error"),
      ],
      connections: [],
      deletions: [],
      statusChanges: [
        {
          pod: POD,
          at: NOW - 30_000,
          status: "restarted",
          severity: "warning",
          previous: "disconnected",
        },
      ],
      kubeEvents: [
        {
          pod: POD,
          uid: "e1",
          type: "Warning",
          reason: "BackOff",
          count: 2,
          lastAt: NOW - 20_000,
          receivedAt: NOW - 20_000,
        },
      ],
    };
    const item = podItem(entry(), summary(), undefined, NOW);
    const detail = podDetail(
      item,
      app({
        "runtime.heap.used_bytes": gauge(5),
        "app.queue.length": gauge(2),
      }),
      records,
      NOW,
    );
    expect(detail.values.map((value) => value.name)).toEqual([
      "app.queue.length",
      "runtime.heap.used_bytes",
    ]);
    expect(detail.events.map((value) => value.ts)).toEqual([1, 2, 3]);
    expect(detail.events[0]).not.toHaveProperty("pod");
    expect(
      detail.restartCauses.map((value) => [value.instanceId, value.ts]),
    ).toEqual([
      ["a", 2],
      ["a", 1],
    ]);
    expect(detail.statusChanges).toHaveLength(1);
    expect(detail.kubeEvents).toEqual([
      {
        uid: "e1",
        type: "Warning",
        reason: "BackOff",
        count: 2,
        lastAt: NOW - 20_000,
      },
    ]);
  });

  it("has no restart causes without a previous instance", () => {
    const item = podItem(
      entry({ restart: undefined }),
      undefined,
      undefined,
      NOW,
    );
    const detail = podDetail(
      item,
      undefined,
      {
        metrics: [],
        events: [event("a", 1, "error")],
        connections: [],
        deletions: [],
        statusChanges: [],
        kubeEvents: [],
      },
      NOW,
    );
    expect(detail.restartCauses).toEqual([]);
    expect(detail.values).toEqual([]);
  });
});

describe("parseNamespaceQuery", () => {
  it.each([
    [undefined, { ok: true, namespace: undefined }],
    ["glasspod-demo", { ok: true, namespace: "glasspod-demo" }],
  ])("accepts %o", (value, expected) => {
    expect(parseNamespaceQuery(value)).toEqual(expected);
  });

  it.each([["Bad_Name"], [""], [["a", "b"]], ["a".repeat(64)]])(
    "rejects %o",
    (value) => {
      expect(parseNamespaceQuery(value)).toMatchObject({ ok: false });
    },
  );
});

describe("parseMetricsQuery", () => {
  it("splits names, trims and drops repeats", () => {
    expect(
      parseMetricsQuery(
        "runtime.heap.used_bytes, app.queue.length,app.queue.length",
      ),
    ).toEqual({
      ok: true,
      names: ["runtime.heap.used_bytes", "app.queue.length"],
    });
  });

  it.each([
    [undefined],
    [""],
    [["a.b", "c.d"]],
    ["Bad.Name"],
    ["heap"],
    ["a.b,"],
    [Array.from({ length: 9 }, (_, index) => `app.m${index}`).join(",")],
  ])("rejects %o", (value) => {
    expect(parseMetricsQuery(value).ok).toBe(false);
  });
});

describe("seriesPods", () => {
  function listItem(name: string, deployment?: string, namespace = "shop") {
    return podItem(
      entry({
        pod: { namespace, name },
        deployment,
      }),
      undefined,
      undefined,
      NOW,
    );
  }

  it("puts the pod first and then pods of the same deployment by name", () => {
    const item = listItem("orders-b", "orders");
    const items = [
      listItem("orders-c", "orders"),
      item,
      listItem("orders-a", "orders"),
      listItem("other", "payments"),
      listItem("orders-z", "orders", "other-ns"),
      listItem("loose"),
    ];
    expect(seriesPods(item, items).map((pod) => pod.name)).toEqual([
      "orders-b",
      "orders-a",
      "orders-c",
    ]);
  });

  it("draws only the pod itself without a deployment and caps siblings", () => {
    const loose = listItem("loose");
    expect(seriesPods(loose, [loose, listItem("other")])).toEqual([
      { namespace: "shop", name: "loose" },
    ]);
    const item = listItem("orders-0", "orders");
    const many = Array.from({ length: MAX_SERIES_SIBLINGS + 5 }, (_, index) =>
      listItem(`orders-${index + 10}`, "orders"),
    );
    expect(seriesPods(item, [item, ...many])).toHaveLength(
      MAX_SERIES_SIBLINGS + 1,
    );
  });
});

describe("podSeries", () => {
  function record(
    receivedAt: number,
    values: StoredMetric[],
    instanceId = "a",
    ts = receivedAt - 100,
  ): MetricsRecord {
    return { pod: POD, instanceId, seq: receivedAt, ts, receivedAt, values };
  }
  const heap = (value: number): StoredMetric => ({
    name: "runtime.heap.used_bytes",
    kind: "gauge",
    value,
  });
  const processed = (
    value: number,
    increase?: number,
    reset?: true,
  ): StoredMetric => ({
    name: "app.orders.processed",
    kind: "counter",
    value,
    ...(increase === undefined ? {} : { increase }),
    ...(reset === undefined ? {} : { reset }),
  });
  const NAMES = ["runtime.heap.used_bytes", "app.orders.processed", "app.none"];

  it("turns records into columns and counters into per-second increases", () => {
    const series = podSeries(
      POD,
      [
        record(10_000, [heap(5), processed(3)]),
        record(15_000, [heap(6), processed(13, 10)]),
        record(20_000, [processed(23, 10)]),
      ],
      NAMES,
      15_000,
    );
    expect(series.times).toEqual([10_000, 15_000, 20_000]);
    expect(series.values).toEqual([
      [5, 6, null],
      // 앞 점이 없으면 null, 그 뒤는 10 / 5초
      [null, 2, 2],
      [null, null, null],
    ]);
  });

  it("breaks the line on a new instance and on a long silence", () => {
    const series = podSeries(
      POD,
      [
        record(10_000, [heap(5), processed(3)]),
        // 3주기(15초)보다 오래 빔
        record(40_000, [heap(6), processed(13, 10)]),
        // 새 instance: counter는 리셋이라 null, 앞 instance의 시각과 견주지 않음
        record(45_000, [heap(1), processed(2, 2, true)], "b"),
        record(50_000, [heap(2), processed(4, 2)], "b"),
      ],
      NAMES.slice(0, 2),
      15_000,
    );
    expect(series.times).toEqual([
      10_000, 10_001, 40_000, 40_001, 45_000, 50_000,
    ]);
    expect(series.values).toEqual([
      [5, null, 6, null, 1, 2],
      [null, null, 1 / 3, null, null, 0.4],
    ]);
  });
});

describe("metricSeriesBody", () => {
  it("reports the kind of each metric someone sent", () => {
    const body = metricSeriesBody(
      ["app.queue.length", "app.none"],
      [
        { pod: POD, records: [] },
        {
          pod: { namespace: "shop", name: "orders-2" },
          records: [
            {
              pod: POD,
              instanceId: "a",
              seq: 1,
              ts: 1,
              receivedAt: 1,
              values: [{ name: "app.queue.length", kind: "gauge", value: 3 }],
            },
          ],
        },
      ],
      15_000,
      NOW,
      NOW - 1_800_000,
    );
    expect(body.metrics).toEqual([
      { name: "app.queue.length", kind: "gauge" },
      { name: "app.none" },
    ]);
    expect(body.pods.map((pod) => pod.pod.name)).toEqual([
      "orders-1",
      "orders-2",
    ]);
    expect(body.pods[1]?.values).toEqual([[3], [null]]);
    expect(body).toMatchObject({ serverTime: NOW, since: NOW - 1_800_000 });
  });
});
