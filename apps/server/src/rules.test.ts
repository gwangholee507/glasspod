import type { PodOutlier } from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import type { AppState, LatestValue } from "./pods.js";
import {
  evaluateCondition,
  healthyPeers,
  metricValue,
  neededHealthy,
  scaleTarget,
} from "./rules.js";
import type { ConditionInput } from "./rules.js";

const NOW = 1_000_000;
const FRESH_MS = 15_000;

function gauge(value: number, receivedAt = NOW - 1_000): LatestValue {
  return { kind: "gauge", value, ts: receivedAt, receivedAt };
}

function counter(value: number, receivedAt = NOW - 1_000): LatestValue {
  return { kind: "counter", value, ts: receivedAt, receivedAt };
}

export function appState(fields: Partial<AppState> = {}): AppState {
  return {
    pod: { namespace: "shop", name: "orders-1" },
    instanceId: "i-1",
    sdk: "node@0.1.0",
    app: undefined,
    instanceSince: 0,
    previousInstanceId: undefined,
    deletedAt: undefined,
    connected: true,
    connectedAt: 0,
    disconnectedAt: undefined,
    lastMessageAt: NOW - 1_000,
    lastMetricsAt: NOW - 1_000,
    lastSeq: 1,
    missed: 0,
    values: new Map(),
    increases: new Map(),
    errorEvents: [],
    ...fields,
  };
}

function input(fields: Partial<ConditionInput> = {}): ConditionInput {
  return {
    status: "ok",
    app: appState(),
    outliers: [],
    now: NOW,
    freshMs: FRESH_MS,
    ...fields,
  };
}

describe("metricValue", () => {
  const app = appState({
    values: new Map([
      ["app.queue.length", gauge(120)],
      ["app.old", gauge(5, NOW - 20_000)],
      ["http.requests.errors_total", counter(900)],
    ]),
    increases: new Map([
      [
        "http.requests.errors_total",
        [
          { at: NOW - 70_000, increase: 50 },
          { at: NOW - 30_000, increase: 4 },
          { at: NOW - 5_000, increase: 3 },
        ],
      ],
    ]),
    errorEvents: [
      { at: NOW - 90_000, count: 9 },
      { at: NOW - 10_000, count: 6 },
    ],
  });

  it("reads the last gauge value", () => {
    expect(metricValue(app, "app.queue.length", NOW, FRESH_MS)).toBe(120);
  });

  it("reads a counter as its increase in the last 60 seconds", () => {
    expect(metricValue(app, "http.requests.errors_total", NOW, FRESH_MS)).toBe(
      7,
    );
  });

  it("reads event:error as error events in the last 60 seconds", () => {
    expect(metricValue(app, "event:error", NOW, FRESH_MS)).toBe(6);
    expect(
      metricValue(
        appState({ ...app, lastMetricsAt: NOW - 20_000 }),
        "event:error",
        NOW,
        FRESH_MS,
      ),
    ).toBeUndefined();
  });

  it("has no value when it is old, unknown or there is no SDK", () => {
    expect(metricValue(app, "app.old", NOW, FRESH_MS)).toBeUndefined();
    expect(metricValue(app, "app.none", NOW, FRESH_MS)).toBeUndefined();
    expect(
      metricValue(undefined, "app.queue.length", NOW, FRESH_MS),
    ).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  it("checks the status against the list", () => {
    const condition = {
      signal: "status" as const,
      statuses: ["stalled" as const, "disconnected" as const],
      forMs: 30_000,
    };
    expect(evaluateCondition(condition, input({ status: "stalled" }))).toEqual({
      holds: true,
      status: "stalled",
    });
    expect(evaluateCondition(condition, input({ status: "ok" }))).toEqual({
      holds: false,
      status: "ok",
    });
  });

  it("holds an outlier condition while the pod has that outlier", () => {
    const outlier: PodOutlier = {
      metric: "http.requests.duration_p99_ms",
      value: 1003,
      peerMedian: 31,
      peers: 2,
      since: NOW - 20_000,
    };
    const condition = {
      signal: "outlier" as const,
      metric: "http.requests.duration_p99_ms",
      forMs: 30_000,
    };
    expect(
      evaluateCondition(condition, input({ outliers: [outlier] })),
    ).toEqual({ holds: true, value: 1003, peerMedian: 31 });
    expect(evaluateCondition(condition, input())).toEqual({ holds: false });
  });

  it("compares a metric above or below the threshold", () => {
    const app = appState({
      values: new Map([["app.queue.length", gauge(50)]]),
    });
    const above = {
      signal: "metric" as const,
      metric: "app.queue.length",
      compare: "above" as const,
      threshold: 50,
      forMs: 0,
    };
    // 기준과 같으면 넘은 것이 아닙니다.
    expect(evaluateCondition(above, input({ app }))).toEqual({
      holds: false,
      value: 50,
    });
    expect(
      evaluateCondition({ ...above, threshold: 49 }, input({ app })).holds,
    ).toBe(true);
    expect(
      evaluateCondition(
        { ...above, compare: "below", threshold: 51 },
        input({ app }),
      ).holds,
    ).toBe(true);
    // 값이 없으면 below도 맞지 않습니다.
    expect(
      evaluateCondition(
        { ...above, compare: "below", threshold: 51 },
        input({ app: undefined }),
      ),
    ).toEqual({ holds: false });
  });
});

describe("healthyPeers and neededHealthy", () => {
  it("counts ready, not critical, not matching pods other than the target", () => {
    expect(
      healthyPeers(
        [
          { key: "a", ready: true, severity: "none", matching: true },
          { key: "b", ready: true, severity: "warning", matching: false },
          { key: "c", ready: false, severity: "none", matching: false },
          { key: "d", ready: true, severity: "critical", matching: false },
          { key: "e", ready: true, severity: "none", matching: true },
          { key: "f", ready: true, severity: "none", matching: false },
        ],
        "a",
      ),
    ).toBe(2);
  });

  it("needs half of the desired replicas, at least one", () => {
    expect(neededHealthy(0)).toBe(1);
    expect(neededHealthy(1)).toBe(1);
    expect(neededHealthy(2)).toBe(1);
    expect(neededHealthy(3)).toBe(2);
    expect(neededHealthy(4)).toBe(2);
    expect(neededHealthy(5)).toBe(3);
  });
});

describe("scaleTarget", () => {
  it("adds by and keeps the result between min and max", () => {
    expect(scaleTarget(3, { kind: "scale", by: 1, max: 5 })).toBe(4);
    expect(scaleTarget(5, { kind: "scale", by: 2, max: 5 })).toBe(5);
    expect(scaleTarget(3, { kind: "scale", by: -2, min: 2 })).toBe(2);
    // 범위 밖에서 시작해도 범위 안으로 옵니다.
    expect(scaleTarget(8, { kind: "scale", by: 1, max: 5 })).toBe(5);
    expect(scaleTarget(19, { kind: "scale", by: 5, max: 20 })).toBe(20);
  });
});
