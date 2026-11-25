import type {
  EventMessage,
  HelloMessage,
  MetricValue,
  PodRef,
} from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterState } from "./cluster.js";
import type { PodSummary } from "./cluster.js";
import {
  ERROR_EVENTS_METRIC,
  OutlierMonitor,
  comparableValues,
  compareSubjects,
  isComparable,
  isHigh,
  median,
} from "./outliers.js";
import type { OutlierSubject } from "./outliers.js";
import { AppStates } from "./pods.js";
import type { AppConnection, AppState, LatestValue } from "./pods.js";
import { StatusMonitor } from "./status-monitor.js";
import type { PodStatusEntry } from "./status-monitor.js";
import { MemoryStore } from "./store/memory.js";

const NOW = 1_000_000;
const FRESH_MS = 15_000;
const LAG = "runtime.event_loop.lag_p99_ms";
const HEAP = "runtime.heap.used_bytes";
const HTTP_P99 = "http.requests.duration_p99_ms";
const HTTP_ERRORS = "http.requests.errors_total";
const QUEUE = "app.queue.length";
const MIB = 1024 * 1024;

describe("median", () => {
  it("takes the middle value, or the mean of the two middle values", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 10])).toBe(3.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeUndefined();
  });
});

describe("isHigh", () => {
  it("needs twice the peer median and the minimum difference", () => {
    // 요청 p99: 최소 차이 100 ms
    expect(isHigh(HTTP_P99, 1003, 31)).toBe(true);
    expect(isHigh(HTTP_P99, 120, 30)).toBe(false); // 4배지만 차이 90
    expect(isHigh(HTTP_P99, 290, 150)).toBe(false); // 차이 140이지만 2배가 안 됨
    expect(isHigh(HTTP_P99, 200, 100)).toBe(true); // 딱 2배, 딱 최소 차이
    // 루프 p99: 50 ms
    expect(isHigh(LAG, 60, 10)).toBe(true);
    expect(isHigh(LAG, 40, 10)).toBe(false);
    // 힙: 50 MiB
    expect(isHigh(HEAP, 70 * MIB, 16 * MIB)).toBe(true);
    expect(isHigh(HEAP, 60 * MIB, 16 * MIB)).toBe(false);
  });

  it("uses only the minimum difference when the peers are at zero", () => {
    expect(isHigh(HTTP_ERRORS, 5, 0)).toBe(true);
    expect(isHigh(HTTP_ERRORS, 4, 0)).toBe(false);
    expect(isHigh(ERROR_EVENTS_METRIC, 3000, 0)).toBe(true);
    // app.* gauge: 10
    expect(isHigh(QUEUE, 12, 0)).toBe(true);
    expect(isHigh(QUEUE, 9, 0)).toBe(false);
  });
});

describe("compareSubjects", () => {
  function subject(
    key: string,
    values: Record<string, number>,
    group = "orders",
  ): OutlierSubject {
    return { key, group, values: new Map(Object.entries(values)) };
  }

  it("compares each pod with the median of the other pods in its group", () => {
    const result = compareSubjects([
      subject("a", { [HTTP_P99]: 1003, [QUEUE]: 12 }),
      subject("b", { [HTTP_P99]: 30, [QUEUE]: 0 }),
      subject("c", { [HTTP_P99]: 32 }),
      // 다른 Deployment는 섞지 않습니다.
      subject("x", { [HTTP_P99]: 5 }, "payments"),
    ]);
    expect(result.get("a")).toEqual([
      { metric: HTTP_P99, value: 1003, peerMedian: 31, peers: 2, high: true },
      { metric: QUEUE, value: 12, peerMedian: 0, peers: 1, high: true },
    ]);
    // 높은 Pod 하나가 다른 Pod의 기준을 끌어올려도 높게 보이지 않습니다.
    expect(result.get("b")).toEqual([
      {
        metric: HTTP_P99,
        value: 30,
        peerMedian: 517.5,
        peers: 2,
        high: false,
      },
      { metric: QUEUE, value: 0, peerMedian: 12, peers: 1, high: false },
    ]);
    // c는 큐 길이를 보내지 않으므로 그 값은 비교하지 않습니다.
    expect(result.get("c")?.map((comparison) => comparison.metric)).toEqual([
      HTTP_P99,
    ]);
    // 같은 Deployment의 다른 Pod가 없으면 비교하지 않습니다.
    expect(result.get("x")).toEqual([]);
  });

  it("orders the fixed values first and app gauges by name", () => {
    const values = {
      "app.zeta": 1,
      [ERROR_EVENTS_METRIC]: 0,
      "app.alpha": 1,
      [HEAP]: 1,
      [HTTP_ERRORS]: 0,
      [LAG]: 1,
    };
    const result = compareSubjects([
      subject("a", values),
      subject("b", values),
    ]);
    expect(result.get("a")?.map((comparison) => comparison.metric)).toEqual([
      LAG,
      HEAP,
      HTTP_ERRORS,
      ERROR_EVENTS_METRIC,
      "app.alpha",
      "app.zeta",
    ]);
  });
});

function latest(
  value: number,
  kind: LatestValue["kind"] = "gauge",
  age = 1_000,
): LatestValue {
  return { kind, value, ts: NOW - age, receivedAt: NOW - age };
}

function appState(fields: Partial<AppState> = {}): AppState {
  return {
    pod: { namespace: "shop", name: "orders-1" },
    instanceId: "b",
    sdk: "node@0.1.0",
    app: undefined,
    instanceSince: NOW - 600_000,
    previousInstanceId: undefined,
    deletedAt: undefined,
    connected: true,
    connectedAt: NOW - 600_000,
    disconnectedAt: undefined,
    lastMessageAt: NOW - 1_000,
    lastMetricsAt: NOW - 1_000,
    lastSeq: 10,
    missed: 0,
    values: new Map(),
    increases: new Map(),
    errorEvents: [],
    ...fields,
  };
}

describe("comparableValues", () => {
  it("reads fresh gauges, 5xx and exceptions of the last minute", () => {
    const values = comparableValues(
      appState({
        values: new Map([
          [LAG, latest(12)],
          [HEAP, latest(16 * MIB)],
          [HTTP_P99, latest(31, "gauge", FRESH_MS + 1)],
          ["runtime.heap.limit_bytes", latest(500 * MIB)],
          [HTTP_ERRORS, latest(40, "counter")],
          [QUEUE, latest(3)],
          ["app.orders.created", latest(900, "counter")],
        ]),
        increases: new Map([
          [
            HTTP_ERRORS,
            [
              { at: NOW - 61_000, increase: 100 },
              { at: NOW - 30_000, increase: 4 },
              { at: NOW - 5_000, increase: 2 },
            ],
          ],
        ]),
        errorEvents: [
          { at: NOW - 70_000, count: 500 },
          { at: NOW - 10_000, count: 49 },
          { at: NOW - 1_000, count: 1 },
        ],
      }),
      NOW,
      FRESH_MS,
    );
    // 오래된 요청 p99, 비교하지 않는 gauge(힙 한도), app.* counter는 없습니다.
    expect(Object.fromEntries(values)).toEqual({
      [LAG]: 12,
      [HEAP]: 16 * MIB,
      [HTTP_ERRORS]: 6,
      [ERROR_EVENTS_METRIC]: 50,
      [QUEUE]: 3,
    });
  });

  it("has no 5xx without a fresh counter and no exceptions without fresh metrics", () => {
    const values = comparableValues(
      appState({
        lastMetricsAt: NOW - FRESH_MS - 1,
        values: new Map([[HTTP_ERRORS, latest(1, "counter", FRESH_MS + 1)]]),
        errorEvents: [{ at: NOW - 1_000, count: 9 }],
      }),
      NOW,
      FRESH_MS,
    );
    expect(values.size).toBe(0);
    // metrics가 새로우면 예외가 없어도 0으로 비교합니다.
    expect(
      Object.fromEntries(comparableValues(appState(), NOW, FRESH_MS)),
    ).toEqual({ [ERROR_EVENTS_METRIC]: 0 });
  });
});

describe("isComparable", () => {
  const entry: PodStatusEntry = {
    pod: { namespace: "shop", name: "orders-1" },
    status: "ok",
    severity: "none",
    since: NOW - 60_000,
    deployment: "orders",
  };
  const summary: PodSummary = {
    namespace: "shop",
    name: "orders-1",
    uid: "uid-1",
    phase: "Running",
    ready: true,
    terminating: false,
    restarts: 0,
    waiting: undefined,
    lastTermination: undefined,
    ip: undefined,
    replicaSet: "orders-5f7c9",
    createdAt: undefined,
  };

  it("takes connected pods of a Deployment that are not isolated or terminating", () => {
    expect(isComparable(entry, summary, appState())).toBe(true);
    const { deployment: _, ...noDeployment } = entry;
    expect(isComparable(noDeployment, summary, appState())).toBe(false);
    expect(isComparable(entry, undefined, appState())).toBe(false);
    expect(
      isComparable(entry, { ...summary, terminating: true }, appState()),
    ).toBe(false);
    expect(
      isComparable(
        entry,
        { ...summary, isolation: { labels: { app: "orders" } } },
        appState(),
      ),
    ).toBe(false);
    expect(isComparable(entry, summary, undefined)).toBe(false);
    expect(isComparable(entry, summary, appState({ connected: false }))).toBe(
      false,
    );
    expect(isComparable(entry, summary, appState({ deletedAt: NOW }))).toBe(
      false,
    );
  });
});

describe("OutlierMonitor", () => {
  const PODS = ["orders-1", "orders-2", "orders-3"];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function pod(name: string): PodRef {
    return { namespace: "shop", name };
  }

  function connection(name: string): AppConnection {
    const hello: HelloMessage = {
      type: "hello",
      seq: 0,
      ts: 1,
      protocol: 1,
      sdk: { lang: "node", version: "0.1.0" },
      pod: pod(name),
      instanceId: `i-${name}`,
    };
    return { hello };
  }

  // Deployment orders의 Pod 3개가 SDK로 붙은 상태입니다. 지표 주기는 5초(3주기 15초)입니다.
  function setup() {
    const clock = { now: 10_000 };
    const store = new MemoryStore();
    const apps = new AppStates(store, () => clock.now);
    const cluster = new ClusterState();
    const statuses = new StatusMonitor({
      apps,
      cluster,
      store,
      metricsIntervalMs: 5000,
      now: () => clock.now,
    });
    const monitor = new OutlierMonitor({
      statuses,
      apps,
      cluster,
      metricsIntervalMs: 5000,
      now: () => clock.now,
    });
    cluster.replicaSets.set({
      namespace: "shop",
      name: "orders-5f7c9",
      uid: "rs-1",
      deployment: "orders",
      revision: "1",
      desired: 3,
    });
    const connections = new Map<string, AppConnection>();
    const seqs = new Map<string, number>();
    for (const name of PODS) {
      cluster.pods.set({
        namespace: "shop",
        name,
        uid: `uid-${name}`,
        phase: "Running",
        ready: true,
        terminating: false,
        restarts: 0,
        waiting: undefined,
        lastTermination: undefined,
        ip: undefined,
        replicaSet: "orders-5f7c9",
        createdAt: undefined,
      });
      const conn = connection(name);
      connections.set(name, conn);
      seqs.set(name, 0);
      apps.connect(conn);
    }
    const nextSeq = (name: string): number => {
      const seq = (seqs.get(name) ?? 0) + 1;
      seqs.set(name, seq);
      return seq;
    };
    // 요청 p99를 Pod마다 보냅니다.
    const send = (values: Record<string, number>) => {
      for (const [name, value] of Object.entries(values)) {
        const metric: MetricValue = { name: HTTP_P99, kind: "gauge", value };
        const seq = nextSeq(name);
        apps.receive(connections.get(name) as AppConnection, {
          type: "metrics",
          seq,
          ts: clock.now,
          values: [metric],
        });
      }
    };
    const sendEvent = (name: string, fields: Partial<EventMessage>) => {
      const seq = nextSeq(name);
      apps.receive(connections.get(name) as AppConnection, {
        type: "event",
        seq,
        ts: clock.now,
        level: "error",
        name: "exception",
        count: 1,
        ...fields,
      });
    };
    // 5초마다 지표를 보내며 1초씩 판단합니다.
    const run = (seconds: number, values: Record<string, number>) => {
      for (let second = 0; second < seconds; second += 1) {
        if (second % 5 === 0) {
          send(values);
        }
        statuses.evaluate();
        monitor.evaluate();
        clock.now += 1000;
      }
    };
    return { clock, cluster, statuses, monitor, run, sendEvent };
  }

  function outlierLines(): string[] {
    return [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
    ]
      .map((call) => String(call[0]))
      .filter((line) => / pod outlier/.test(line));
  }

  const SLOW = { "orders-1": 1003, "orders-2": 30, "orders-3": 32 };
  const NORMAL = { "orders-1": 33, "orders-2": 30, "orders-3": 32 };

  it("turns on after the value stays high for three periods", () => {
    const { clock, monitor, run } = setup();
    const start = clock.now;
    run(15, SLOW);
    // 15초째(0~14초)에는 아직 켜지지 않습니다.
    expect(monitor.get(pod("orders-1"))).toEqual([]);
    run(1, SLOW);
    expect(monitor.get(pod("orders-1"))).toEqual([
      {
        metric: HTTP_P99,
        value: 1003,
        peerMedian: 31,
        peers: 2,
        since: start,
      },
    ]);
    expect(monitor.get(pod("orders-2"))).toEqual([]);
    expect(outlierLines()).toHaveLength(1);
    expect(outlierLines()[0]).toMatch(
      /WARN +pod outlier pod=shop\/orders-1 metric=http\.requests\.duration_p99_ms value=1003 peerMedian=31 peers=2/,
    );
  });

  it("starts over when the value drops before turning on", () => {
    const { monitor, run } = setup();
    run(10, SLOW);
    run(5, NORMAL);
    run(10, SLOW);
    expect(monitor.get(pod("orders-1"))).toEqual([]);
  });

  it("stays on through a short dip and turns off after three periods", () => {
    const { monitor, run } = setup();
    run(20, SLOW);
    expect(monitor.get(pod("orders-1"))).toHaveLength(1);
    // 한 주기 낮아져도 켜진 채이고, 지금 값을 보입니다.
    run(5, NORMAL);
    expect(monitor.get(pod("orders-1"))).toEqual([
      expect.objectContaining({ metric: HTTP_P99, value: 33 }),
    ]);
    run(5, SLOW);
    run(14, NORMAL);
    expect(monitor.get(pod("orders-1"))).toHaveLength(1);
    run(2, NORMAL);
    expect(monitor.get(pod("orders-1"))).toEqual([]);
    expect(outlierLines().filter((line) => / cleared /.test(line))).toEqual([
      expect.stringMatching(
        /INFO +pod outlier cleared pod=shop\/orders-1 metric=http\.requests\.duration_p99_ms/,
      ),
    ]);
  });

  it("turns off at once when the pod is taken out of traffic", () => {
    const { cluster, monitor, run } = setup();
    run(20, SLOW);
    expect(monitor.get(pod("orders-1"))).toHaveLength(1);
    const summary = cluster.pods.get("shop", "orders-1") as PodSummary;
    cluster.pods.set({
      ...summary,
      replicaSet: undefined,
      isolation: { labels: { app: "orders" } },
    });
    run(1, SLOW);
    expect(monitor.get(pod("orders-1"))).toEqual([]);
    expect(outlierLines().filter((line) => / cleared /.test(line))).toEqual([
      expect.stringMatching(/ reason=not-compared/),
    ]);
  });

  it("compares exceptions per minute", () => {
    const { monitor, run, sendEvent } = setup();
    for (let second = 0; second < 20; second += 1) {
      if (second % 10 === 0) {
        sendEvent("orders-3", { count: 500 });
        // info event는 세지 않습니다.
        sendEvent("orders-2", { level: "info", count: 500 });
      }
      run(1, NORMAL);
    }
    expect(monitor.get(pod("orders-3"))).toEqual([
      expect.objectContaining({
        metric: ERROR_EVENTS_METRIC,
        value: 1000,
        peerMedian: 0,
        peers: 2,
      }),
    ]);
    expect(monitor.get(pod("orders-2"))).toEqual([]);
  });
});
