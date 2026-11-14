import type {
  V1Deployment,
  V1Pod,
  V1ReplicaSet,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
  ClusterState,
  changedFields,
  summarizeDeployment,
  summarizePod,
  summarizeReplicaSet,
} from "./cluster.js";

// watch로 온 객체처럼 날짜는 문자열로 둡니다(list 결과는 Date).
function pod(fields: { metadata?: object; status?: object } = {}): V1Pod {
  return {
    metadata: {
      namespace: "shop",
      name: "orders-7d9f8-x2kq1",
      uid: "u-1",
      creationTimestamp: "2026-11-14T08:00:00Z",
      ownerReferences: [
        {
          apiVersion: "apps/v1",
          kind: "ReplicaSet",
          name: "orders-7d9f8",
          uid: "rs-1",
          controller: true,
        },
      ],
      ...fields.metadata,
    },
    status: {
      phase: "Running",
      podIP: "10.1.0.12",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "app",
          image: "orders:1",
          imageID: "",
          ready: true,
          restartCount: 0,
          state: { running: {} },
        },
      ],
      ...fields.status,
    },
  } as unknown as V1Pod;
}

function replicaSet(name: string, deployment?: string): V1ReplicaSet {
  return {
    metadata: {
      namespace: "shop",
      name,
      uid: `rs-${name}`,
      annotations: { "deployment.kubernetes.io/revision": "3" },
      ownerReferences:
        deployment === undefined
          ? []
          : [
              {
                apiVersion: "apps/v1",
                kind: "Deployment",
                name: deployment,
                uid: "d-1",
                controller: true,
              },
            ],
    },
    spec: { replicas: 2, selector: {} },
  } as unknown as V1ReplicaSet;
}

describe("summarizePod", () => {
  it("요약 필드를 채움", () => {
    expect(summarizePod(pod())).toEqual({
      namespace: "shop",
      name: "orders-7d9f8-x2kq1",
      uid: "u-1",
      phase: "Running",
      ready: true,
      terminating: false,
      restarts: 0,
      waiting: undefined,
      lastTermination: undefined,
      ip: "10.1.0.12",
      replicaSet: "orders-7d9f8",
      createdAt: "2026-11-14T08:00:00Z",
    });
  });

  it("list 결과의 Date도 ISO 문자열로 바꿈", () => {
    const summary = summarizePod(
      pod({
        metadata: { creationTimestamp: new Date("2026-11-14T08:00:00Z") },
      }),
    );
    expect(summary.createdAt).toBe("2026-11-14T08:00:00.000Z");
  });

  it("재시작 횟수를 더하고 가장 최근에 끝난 컨테이너를 고름", () => {
    const summary = summarizePod(
      pod({
        status: {
          conditions: [{ type: "Ready", status: "False" }],
          containerStatuses: [
            {
              name: "app",
              restartCount: 2,
              state: { waiting: { reason: "CrashLoopBackOff" } },
              lastState: {
                terminated: {
                  reason: "OOMKilled",
                  exitCode: 137,
                  finishedAt: "2026-11-14T08:05:00Z",
                },
              },
            },
            {
              name: "sidecar",
              restartCount: 1,
              state: { running: {} },
              lastState: {
                terminated: {
                  reason: "Error",
                  exitCode: 1,
                  finishedAt: "2026-11-14T08:01:00Z",
                },
              },
            },
          ],
        },
      }),
    );
    expect(summary.ready).toBe(false);
    expect(summary.restarts).toBe(3);
    expect(summary.waiting).toBe("CrashLoopBackOff");
    expect(summary.lastTermination).toEqual({
      container: "app",
      reason: "OOMKilled",
      exitCode: 137,
      finishedAt: "2026-11-14T08:05:00Z",
    });
  });

  it("지금 끝나 있는 컨테이너(state)도 마지막 종료로 봄", () => {
    const summary = summarizePod(
      pod({
        status: {
          phase: "Failed",
          containerStatuses: [
            {
              name: "app",
              restartCount: 0,
              state: {
                terminated: {
                  reason: "Error",
                  exitCode: 3,
                  finishedAt: "2026-11-14T08:02:00Z",
                },
              },
            },
          ],
        },
      }),
    );
    expect(summary.lastTermination?.exitCode).toBe(3);
  });

  it("deletionTimestamp가 있으면 종료 중, status가 비어도 기본값", () => {
    const summary = summarizePod({
      metadata: {
        namespace: "shop",
        name: "x",
        deletionTimestamp: "2026-11-14T08:03:00Z",
      },
    } as unknown as V1Pod);
    expect(summary).toMatchObject({
      phase: "Unknown",
      ready: false,
      terminating: true,
      restarts: 0,
      ip: undefined,
      replicaSet: undefined,
    });
  });
});

describe("summarizeDeployment, summarizeReplicaSet", () => {
  it("replicas가 없으면 1, 상태 값이 없으면 0", () => {
    const deployment = {
      metadata: { namespace: "shop", name: "orders", uid: "d-1" },
      spec: { selector: {}, template: {} },
    } as unknown as V1Deployment;
    expect(summarizeDeployment(deployment)).toEqual({
      namespace: "shop",
      name: "orders",
      uid: "d-1",
      desired: 1,
      ready: 0,
      available: 0,
    });
  });

  it("ReplicaSet의 Deployment와 revision", () => {
    expect(summarizeReplicaSet(replicaSet("orders-7d9f8", "orders"))).toEqual({
      namespace: "shop",
      name: "orders-7d9f8",
      uid: "rs-orders-7d9f8",
      deployment: "orders",
      revision: "3",
      desired: 2,
    });
  });
});

describe("changedFields", () => {
  it("값이 다른 필드만, 객체는 내용으로 비교", () => {
    const before = summarizePod(pod());
    const same = { ...before, lastTermination: undefined };
    expect(changedFields(before, same, ["phase", "lastTermination"])).toEqual(
      [],
    );
    const after = {
      ...before,
      ready: false,
      restarts: 1,
      lastTermination: {
        container: "app",
        reason: "Error",
        exitCode: 3,
        finishedAt: undefined,
      },
    };
    expect(
      changedFields(before, after, [
        "phase",
        "ready",
        "restarts",
        "lastTermination",
      ]),
    ).toEqual(["ready", "restarts", "lastTermination"]);
  });
});

describe("ClusterState", () => {
  it("처음은 added, 요약이 같으면 unchanged, 다르면 changed", () => {
    const state = new ClusterState();
    expect(state.pods.set(summarizePod(pod()))).toEqual({ kind: "added" });
    expect(state.pods.set(summarizePod(pod()))).toEqual({ kind: "unchanged" });
    expect(
      state.pods.set(summarizePod(pod({ status: { phase: "Succeeded" } }))),
    ).toEqual({ kind: "changed", fields: ["phase"] });
    expect(state.pods.delete("shop", "orders-7d9f8-x2kq1")?.phase).toBe(
      "Succeeded",
    );
    expect(state.pods.list()).toEqual([]);
  });

  it("Pod → ReplicaSet → Deployment. ReplicaSet이 늦게 와도 물어볼 때 찾음", () => {
    const state = new ClusterState();
    const summary = summarizePod(pod());
    state.pods.set(summary);
    expect(state.deploymentOf(summary)).toBeUndefined();
    state.replicaSets.set(
      summarizeReplicaSet(replicaSet("orders-7d9f8", "orders")),
    );
    expect(state.deploymentOf(summary)).toBe("orders");
  });

  it("Deployment가 만들지 않은 ReplicaSet이면 없음", () => {
    const state = new ClusterState();
    state.replicaSets.set(summarizeReplicaSet(replicaSet("orders-7d9f8")));
    expect(state.deploymentOf(summarizePod(pod()))).toBeUndefined();
  });
});
