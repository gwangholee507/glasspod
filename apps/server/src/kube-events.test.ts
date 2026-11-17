import type { CoreV1Event } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { kubeEventRecord } from "./kube-events.js";

function event(overrides: Partial<CoreV1Event> = {}): CoreV1Event {
  return {
    metadata: { namespace: "shop", uid: "uid-1" },
    involvedObject: { kind: "Pod", name: "orders-1", namespace: "shop" },
    type: "Warning",
    reason: "Unhealthy",
    message: "Readiness probe failed: connection refused\n",
    count: 3,
    firstTimestamp: new Date("2026-11-17T04:00:00Z"),
    lastTimestamp: new Date("2026-11-17T04:00:30Z"),
    ...overrides,
  };
}

describe("kubeEventRecord", () => {
  it("turns a pod event into a record", () => {
    expect(kubeEventRecord(event(), 99)).toEqual({
      pod: { namespace: "shop", name: "orders-1" },
      uid: "uid-1",
      type: "Warning",
      reason: "Unhealthy",
      message: "Readiness probe failed: connection refused",
      count: 3,
      firstAt: Date.parse("2026-11-17T04:00:00Z"),
      lastAt: Date.parse("2026-11-17T04:00:30Z"),
      receivedAt: 99,
    });
  });

  it("skips events about other objects", () => {
    expect(
      kubeEventRecord(
        event({ involvedObject: { kind: "ReplicaSet", name: "orders-5f7c9" } }),
        1,
      ),
    ).toBeUndefined();
  });

  it("uses series and event time when the old fields are missing", () => {
    // events.k8s.io/v1로 만든 Event입니다. 시각이 문자열로 올 때도 있습니다.
    const record = kubeEventRecord(
      event({
        count: undefined,
        firstTimestamp: undefined,
        lastTimestamp: undefined,
        eventTime: "2026-11-17T04:01:00.000000Z" as unknown as Date,
        series: {
          count: 7,
          lastObservedTime: "2026-11-17T04:02:00.000000Z" as unknown as Date,
        },
      }),
      1,
    );
    expect(record).toMatchObject({
      count: 7,
      firstAt: Date.parse("2026-11-17T04:01:00Z"),
      lastAt: Date.parse("2026-11-17T04:02:00Z"),
    });
  });

  it("falls back to the received time and namespace of the event", () => {
    const record = kubeEventRecord(
      event({
        involvedObject: { kind: "Pod", name: "orders-1" },
        count: undefined,
        firstTimestamp: undefined,
        lastTimestamp: undefined,
        message: "  ",
      }),
      42,
    );
    expect(record).toMatchObject({
      pod: { namespace: "shop", name: "orders-1" },
      count: 1,
      lastAt: 42,
    });
    expect(record).not.toHaveProperty("message");
    expect(record).not.toHaveProperty("firstAt");
  });
});
