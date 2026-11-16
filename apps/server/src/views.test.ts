import { describe, expect, it } from "vitest";
import type { PodSummary } from "./cluster.js";
import type { AppState, CounterIncrease, LatestValue } from "./pods.js";
import type { PodStatusEntry } from "./status-monitor.js";
import type { EventRecord, PodRecords } from "./store/store.js";
import {
  listMetrics,
  parseNamespaceQuery,
  podDetail,
  podItem,
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
