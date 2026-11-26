import type {
  MetricSeriesBody,
  PodDetailBody,
  PodEvent,
  PodItem,
  PodMetricValue,
} from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import {
  chartSeries,
  chooseFourthChart,
  formatDisplayValue,
  metricUnit,
  nearestValueIndex,
  podFacts,
  refreshDelayMs,
  restartMarks,
  shortInstance,
  whatHappened,
} from "./detailView.js";

const POD = { namespace: "shop", name: "orders-1" };
const OLD = "3f9c0000-0000-0000-0000-000000000a21";
const NEW = "7b1d0000-0000-0000-0000-000000000c44";

function item(fields: Partial<PodItem> = {}): PodItem {
  return {
    pod: POD,
    deployment: "orders",
    status: "restarted",
    severity: "warning",
    since: 50_000,
    restart: {
      at: 40_000,
      reason: "OOMKilled",
      exitCode: 137,
      previousInstanceId: OLD,
    },
    kube: {
      uid: "u",
      phase: "Running",
      ready: true,
      terminating: false,
      restarts: 1,
      ip: "10.1.0.47",
      createdAt: "1970-01-01T00:00:00Z",
    },
    sdk: {
      connected: true,
      instanceId: NEW,
      sdk: "node@0.1.0",
      instanceSince: 45_000,
      connectedAt: 45_000,
      missed: 0,
    },
    metrics: {},
    ...fields,
  };
}

function event(fields: Partial<PodEvent>): PodEvent {
  return {
    instanceId: OLD,
    seq: 1,
    ts: 30_000,
    receivedAt: 30_000,
    level: "error",
    name: "exception",
    count: 1,
    ...fields,
  };
}

function detail(fields: Partial<PodDetailBody> = {}): PodDetailBody {
  return {
    serverTime: 60_000,
    item: item(),
    values: [],
    events: [],
    restartCauses: [],
    connections: [],
    statusChanges: [],
    kubeEvents: [],
    actions: [],
    ...fields,
  };
}

describe("refreshDelayMs", () => {
  it("waits until five seconds passed since the last start", () => {
    expect(refreshDelayMs(undefined, 1_000)).toBe(0);
    expect(refreshDelayMs(1_000, 2_000)).toBe(4_000);
    expect(refreshDelayMs(1_000, 6_000)).toBe(0);
    expect(refreshDelayMs(1_000, 9_000)).toBe(0);
  });
});

describe("shortInstance", () => {
  it("keeps the head and tail of long ids", () => {
    expect(shortInstance(OLD)).toBe("3f9c…a21");
    expect(shortInstance("abc")).toBe("abc");
  });
});

describe("whatHappened", () => {
  it("merges every kind of row, latest first, and numbers restart causes", () => {
    const timeout = event({
      seq: 7,
      ts: 39_000,
      message: "fake DB timed out after 1000ms",
      count: 7,
      data: { route: "POST /orders", errorType: "TimeoutError" },
    });
    const retry = event({
      seq: 5,
      ts: 35_000,
      level: "warn",
      name: "app.orders.retry",
      message: "DB 재시도",
      count: 24,
    });
    const body = detail({
      events: [
        retry,
        timeout,
        event({
          instanceId: NEW,
          seq: 1,
          ts: 47_000,
          level: "info",
          name: "state",
          message: "app.mode: ready",
          data: { name: "app.mode", to: "ready" },
        }),
      ],
      restartCauses: [timeout, retry],
      connections: [
        { instanceId: OLD, change: "disconnected", at: 40_500, code: 1006 },
        { instanceId: NEW, change: "connected", at: 45_000, newInstance: true },
      ],
      statusChanges: [
        {
          pod: POD,
          at: 46_000,
          status: "restarted",
          severity: "warning",
          reason: "OOMKilled",
          previous: "disconnected",
        },
      ],
      kubeEvents: [
        {
          uid: "k1",
          type: "Warning",
          reason: "BackOff",
          message: "Back-off restarting failed container",
          count: 2,
          lastAt: 42_000,
        },
      ],
    });
    const { rows, truncated } = whatHappened(body, item());
    expect(truncated).toBe(false);
    expect(rows.map((row) => [row.at, row.kind, row.label, row.title])).toEqual(
      [
        [47_000, "event", "info", "app.mode: ready"],
        [
          46_000,
          "status",
          "판단",
          "Pod가 재시작했습니다. 쿠버네티스 종료 이유 OOMKilled.",
        ],
        [45_000, "connection", "SDK", "새 instance로 연결됨"],
        [42_000, "kube", "쿠버네티스", "BackOff"],
        [40_500, "connection", "SDK", "연결 끊김"],
        [
          40_000,
          "restart",
          "쿠버네티스",
          "OOMKilled (exit 137) → 컨테이너 재시작",
        ],
        [
          39_000,
          "event",
          "error",
          "TimeoutError: fake DB timed out after 1000ms",
        ],
        [35_000, "event", "warn", "app.orders.retry"],
      ],
    );
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    expect(byTitle.get("OOMKilled (exit 137) → 컨테이너 재시작")).toMatchObject(
      {
        tone: "critical",
        detail: "새 instance 7b1d…c44로 다시 붙음",
      },
    );
    expect(
      byTitle.get("TimeoutError: fake DB timed out after 1000ms"),
    ).toMatchObject({
      tone: "critical",
      cause: 1,
      detail: "POST /orders · 7번 · 이전 instance 3f9c…a21",
    });
    expect(byTitle.get("app.orders.retry")).toMatchObject({
      tone: "warning",
      cause: 2,
      detail: "DB 재시도 · 24번 · 이전 instance 3f9c…a21",
    });
    expect(byTitle.get("BackOff")).toMatchObject({
      tone: "warning",
      detail: "Back-off restarting failed container · 2번",
    });
    expect(byTitle.get("app.mode: ready")).not.toHaveProperty("detail");
    expect(rows.find((row) => row.kind === "status")?.status).toEqual({
      previous: "disconnected",
      next: "restarted",
    });
  });

  it("skips the restart row without a kubernetes reason and caps rows", () => {
    const body = detail({
      events: Array.from({ length: 5 }, (_, index) =>
        event({ instanceId: NEW, seq: index, ts: index }),
      ),
    });
    const { rows, truncated } = whatHappened(
      body,
      item({ restart: { at: 1, previousInstanceId: OLD } }),
      3,
    );
    expect(rows.map((row) => row.at)).toEqual([4, 3, 2]);
    expect(truncated).toBe(true);
  });

  it("adds a row for each action on this pod", () => {
    const body = detail({
      actions: [
        {
          id: "a1",
          action: "restart-pod",
          target: {
            kind: "pod",
            namespace: "shop",
            name: "orders-1",
            uid: "u",
          },
          actor: { kind: "user" },
          requestedAt: 50_000,
          finishedAt: 50_100,
          result: "failed",
          error: "target-changed",
          kubeStatus: 409,
        },
      ],
    });
    const [row] = whatHappened(body, item()).rows;
    expect(row).toEqual({
      key: "action/a1",
      at: 50_000,
      kind: "action",
      tone: "warning",
      label: "조치",
      title: "Pod 재시작 · 개발자",
      detail:
        "HTTP 409 · 같은 이름의 다른 Pod로 바뀌었습니다. 목록을 다시 보고 실행합니다.",
    });
  });
});

describe("chooseFourthChart", () => {
  function value(name: string, kind: PodMetricValue["kind"] = "gauge") {
    return { name, kind, value: 1, ts: 1, receivedAt: 1 };
  }
  const values = [
    value("runtime.heap.used_bytes"),
    value("runtime.heap.limit_bytes"),
    value("http.requests.errors_total", "counter"),
    value("app.orders.processed", "counter"),
    value("app.queue.length"),
    value("runtime.rss_bytes"),
  ];

  it("picks the first app gauge by default and keeps a valid choice", () => {
    expect(chooseFourthChart(values, undefined)).toEqual({
      name: "app.queue.length",
      title: "app.queue.length",
      unit: "number",
    });
    expect(chooseFourthChart(values, "app.orders.processed")).toEqual({
      name: "app.orders.processed",
      title: "app.orders.processed",
      unit: "perMinute",
    });
    // 고정 그래프와 힙 한도는 고를 수 없습니다.
    expect(chooseFourthChart(values, "runtime.heap.used_bytes")?.name).toBe(
      "app.queue.length",
    );
  });

  it("prefers a metric that is higher than the other pods", () => {
    // 다른 Pod보다 높은 값 가운데 고를 수 있는 것(그래프가 있는 것)을 순서대로 봅니다(docs/guides/T34.md 결정 16).
    expect(
      chooseFourthChart(values, undefined, [
        "http.requests.duration_p99_ms",
        "event:error",
        "http.requests.errors_total",
      ])?.name,
    ).toBe("http.requests.errors_total");
    // 개발자가 고른 것이 먼저입니다.
    expect(
      chooseFourthChart(values, "runtime.rss_bytes", [
        "http.requests.errors_total",
      ])?.name,
    ).toBe("runtime.rss_bytes");
    // 고를 수 있는 것이 없으면 원래 기본값입니다.
    expect(chooseFourthChart(values, undefined, ["event:error"])?.name).toBe(
      "app.queue.length",
    );
    // 높은 값에 app.* gauge가 있으면 서버가 보낸 순서와 상관없이 먼저입니다(docs/guides/T26.md).
    expect(
      chooseFourthChart(values, undefined, [
        "http.requests.errors_total",
        "event:error",
        "app.queue.length",
      ])?.name,
    ).toBe("app.queue.length");
  });

  it("falls back to 5xx, then the first metric, then nothing", () => {
    const noApp = values.filter((entry) => !entry.name.startsWith("app."));
    expect(chooseFourthChart(noApp, undefined)).toEqual({
      name: "http.requests.errors_total",
      title: "5xx",
      unit: "perMinute",
    });
    expect(
      chooseFourthChart([value("runtime.rss_bytes")], undefined)?.unit,
    ).toBe("megabytes");
    expect(
      chooseFourthChart([value("runtime.heap.used_bytes")], undefined),
    ).toBe(undefined);
  });
});

describe("metricUnit and formatDisplayValue", () => {
  it.each([
    ["app.orders.processed", "counter", "perMinute"],
    ["runtime.event_loop.lag_p99_ms", "gauge", "ms"],
    ["runtime.rss_bytes", "gauge", "megabytes"],
    ["app.queue.length", "gauge", "number"],
  ] as const)("%s is %s", (name, kind, unit) => {
    expect(metricUnit(name, kind)).toBe(unit);
  });

  it("formats drawn values", () => {
    expect(formatDisplayValue(92.4, "megabytes")).toBe("92 MB");
    expect(formatDisplayValue(1240, "ms")).toBe("1,240 ms");
    expect(formatDisplayValue(2.5, "perMinute")).toBe("2.5/분");
    expect(formatDisplayValue(600, "perMinute")).toBe("600/분");
    expect(formatDisplayValue(1.234, "number")).toBe("1.23");
    expect(formatDisplayValue(null, "number")).toBe("—");
  });
});

describe("chartSeries", () => {
  const body: MetricSeriesBody = {
    serverTime: 30_000,
    since: 0,
    metrics: [
      { name: "runtime.heap.used_bytes", kind: "gauge" },
      { name: "app.orders.processed", kind: "counter" },
    ],
    pods: [
      {
        pod: POD,
        times: [10_000, 10_001, 20_000],
        values: [
          [1024 * 1024, null, 2 * 1024 * 1024],
          [null, null, 0.5],
        ],
      },
      {
        pod: { namespace: "shop", name: "orders-2" },
        times: [12_000, 20_000],
        values: [
          [3 * 1024 * 1024, 4 * 1024 * 1024],
          [1, 1],
        ],
      },
    ],
  };

  it("joins pods on one x axis and converts units", () => {
    expect(chartSeries(body, "runtime.heap.used_bytes", "megabytes")).toEqual({
      data: [
        [10_000, 10_001, 12_000, 20_000],
        [1, null, undefined, 2],
        [undefined, undefined, 3, 4],
      ],
      hasOwnData: true,
      last: 2,
    });
    expect(chartSeries(body, "app.orders.processed", "perMinute")?.last).toBe(
      30,
    );
    expect(chartSeries(body, "app.none", "number")).toBeUndefined();
  });

  it("knows when only the other pods sent the metric", () => {
    const series = chartSeries(
      {
        ...body,
        pods: [
          { pod: POD, times: [1], values: [[null], [null]] },
          ...body.pods.slice(1),
        ],
      },
      "runtime.heap.used_bytes",
      "megabytes",
    );
    expect(series?.hasOwnData).toBe(false);
    expect(series?.last).toBeUndefined();
  });
});

describe("nearestValueIndex", () => {
  it("finds the closest number around the cursor", () => {
    const values = [undefined, 5, null, undefined, 7];
    expect(nearestValueIndex(values, 1)).toBe(1);
    expect(nearestValueIndex(values, 2)).toBe(1);
    expect(nearestValueIndex(values, 3)).toBe(4);
    expect(nearestValueIndex([null, undefined], 0)).toBeUndefined();
  });
});

describe("restartMarks", () => {
  it("returns new instance connections inside the period", () => {
    const body = detail({
      connections: [
        { instanceId: OLD, change: "connected", at: 1_000, newInstance: true },
        { instanceId: OLD, change: "disconnected", at: 2_000 },
        { instanceId: OLD, change: "connected", at: 3_000, newInstance: false },
        { instanceId: NEW, change: "connected", at: 4_000, newInstance: true },
      ],
    });
    expect(restartMarks(body, 2_000)).toEqual([4_000]);
  });
});

describe("podFacts", () => {
  it("lists deployment, ip and age", () => {
    expect(podFacts(item(), 90_000, (ms) => `${ms / 1000}초`)).toEqual([
      "orders",
      "10.1.0.47",
      "나이 90초",
    ]);
    expect(
      podFacts(item({ deployment: undefined, kube: undefined }), 1, String),
    ).toEqual([]);
  });
});
