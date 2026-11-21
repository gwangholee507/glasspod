import type { ActionItem, PodItem } from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import {
  NO_ACTION_FILTER,
  actionSentence,
  errorSentence,
  filterActions,
  formatActionTime,
  mergeActions,
  restartBlockReason,
  restartImpact,
  shortPodName,
} from "./actionText.js";

function action(fields: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a",
    action: "restart-pod",
    target: { kind: "pod", namespace: "shop", name: "orders-1", uid: "u" },
    actor: { kind: "user" },
    requestedAt: 1_000,
    finishedAt: 1_100,
    result: "succeeded",
    ...fields,
  };
}

function pod(name: string, fields: Partial<PodItem> = {}): PodItem {
  return {
    pod: { namespace: "shop", name },
    deployment: "orders",
    status: "ok",
    severity: "none",
    since: 1,
    kube: {
      uid: `uid-${name}`,
      phase: "Running",
      ready: true,
      terminating: false,
      restarts: 0,
      replicaSet: "orders-7d9f8",
    },
    metrics: {},
    ...fields,
  };
}

describe("actionSentence", () => {
  it("describes a restart and a failure with the kubernetes status", () => {
    expect(actionSentence(action({ replicaSet: "orders-7d9f8" }))).toBe(
      "Pod를 지웠습니다. ReplicaSet orders-7d9f8이 새 Pod를 만듭니다.",
    );
    expect(actionSentence(action())).toBe("Pod를 지웠습니다.");
    expect(
      actionSentence(
        action({
          result: "failed",
          error: "target-not-found",
          kubeStatus: 404,
        }),
      ),
    ).toBe("HTTP 404 · Pod가 이미 지워져 있습니다.");
    expect(
      actionSentence(action({ result: "failed", error: "action-not-allowed" })),
    ).toBe("이 namespace는 조치가 꺼져 있습니다(GLASSPOD_ACTION_NAMESPACES).");
  });

  it("falls back for codes the server does not record", () => {
    expect(errorSentence("network-error")).toBe(
      "조치를 보내지 못했습니다(network-error).",
    );
  });
});

describe("mergeActions and filterActions", () => {
  it("keeps one of each id, latest first", () => {
    const merged = mergeActions([
      [
        action({ id: "a", requestedAt: 1 }),
        action({ id: "b", requestedAt: 3 }),
      ],
      [
        action({ id: "a", requestedAt: 1 }),
        action({ id: "c", requestedAt: 2 }),
      ],
    ]);
    expect(merged.map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("filters by result and target name", () => {
    const items = [
      action({ id: "a" }),
      action({
        id: "b",
        result: "failed",
        target: { kind: "pod", namespace: "shop", name: "Pay-1", uid: "u" },
      }),
    ];
    expect(
      filterActions(items, { ...NO_ACTION_FILTER, result: "failed" }).map(
        (item) => item.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterActions(items, { ...NO_ACTION_FILTER, query: " pay " }).map(
        (item) => item.id,
      ),
    ).toEqual(["b"]);
    expect(filterActions(items, NO_ACTION_FILTER)).toHaveLength(2);
  });
});

describe("formatActionTime", () => {
  it("adds the date when it is not today", () => {
    const now = new Date(2026, 10, 21, 13, 0, 0).getTime();
    expect(
      formatActionTime(new Date(2026, 10, 21, 9, 5, 7).getTime(), now),
    ).toBe("09:05:07");
    expect(
      formatActionTime(new Date(2026, 10, 20, 23, 59, 1).getTime(), now),
    ).toBe("11-20 23:59:01");
  });
});

describe("restartBlockReason", () => {
  const target = pod("orders-1");
  it("allows a running pod in an action namespace", () => {
    expect(restartBlockReason(target.pod, target, ["shop"])).toBeUndefined();
  });

  it("explains why the button is off", () => {
    expect(restartBlockReason(target.pod, target, [])).toMatch(
      /서버에서 조치가 꺼져/,
    );
    expect(restartBlockReason(target.pod, target, ["pay"])).toMatch(
      /이 namespace는 조치가 꺼져/,
    );
    expect(restartBlockReason(target.pod, target, undefined)).toMatch(
      /받는 중/,
    );
    const { kube: _kube, ...noKube } = target;
    expect(restartBlockReason(target.pod, noKube, ["shop"])).toBe(
      "쿠버네티스에 없는 Pod입니다.",
    );
    expect(
      restartBlockReason(
        target.pod,
        pod("orders-1", {
          kube: { ...target.kube!, terminating: true },
        }),
        ["shop"],
      ),
    ).toBe("Pod가 지워지는 중입니다.");
  });
});

describe("restartImpact", () => {
  it("lists the other pods of the deployment and warns about troubled ones", () => {
    const target = pod("orders-7c9f8b6d5-r2t8w", { status: "restarted" });
    const stalled = pod("orders-7c9f8b6d5-9kd2p", {
      status: "stalled",
      severity: "critical",
    });
    const healthy = pod("orders-7c9f8b6d5-4hx7m");
    const elsewhere = pod("pay-1", { deployment: "pay" });
    const leaving = pod("orders-7c9f8b6d5-zzzzz", {
      kube: { ...healthy.kube!, terminating: true },
    });
    const impact = restartImpact(target, [
      stalled,
      target,
      healthy,
      elsewhere,
      leaving,
    ]);
    expect(impact.replicaSet).toBe("orders-7d9f8");
    expect(impact.others.map((row) => [row.pod.name, row.note])).toEqual([
      ["orders-7c9f8b6d5-4hx7m", "정상"],
      ["orders-7c9f8b6d5-9kd2p", "응답이 없을 수 있음"],
    ]);
    expect(impact.serving).toBe(1);
    expect(impact.warnings).toEqual([
      "같은 Deployment의 9kd2p도 앱 멈춤 의심입니다. 지금 재시작하면 새 Pod가 준비될 때까지 Pod 1개가 트래픽을 받습니다.",
    ]);
  });

  it("warns when nothing else serves traffic or nothing recreates the pod", () => {
    const alone = pod("orders-1");
    expect(restartImpact(alone, [alone]).warnings).toEqual([
      "새 Pod가 준비될 때까지 트래픽을 받을 Pod가 없습니다.",
    ]);
    const bare = pod("debug", {
      kube: { ...alone.kube!, replicaSet: undefined },
    });
    const { deployment: _deployment, ...noDeployment } = bare;
    const impact = restartImpact(noDeployment, [noDeployment]);
    expect(impact.replicaSet).toBeUndefined();
    expect(impact.warnings[0]).toBe(
      "이 Pod를 다시 만들 컨트롤러가 없습니다. 지우면 다시 생기지 않습니다.",
    );
  });

  it("marks pods that are not ready as not serving traffic", () => {
    const target = pod("orders-1");
    const starting = pod("orders-2", {
      status: "not-ready",
      severity: "warning",
      kube: { ...target.kube!, ready: false },
    });
    const impact = restartImpact(target, [target, starting]);
    expect(impact.others[0]?.note).toBe("트래픽 받지 않음");
    expect(impact.serving).toBe(0);
    expect(impact.warnings[0]).toMatch(
      /2도 준비 안 됨입니다\. 새 Pod가 준비될 때까지 트래픽을 받을 Pod가 없습니다\./,
    );
  });

  it("counts ready pods with a warning (e.g. restarted) as serving traffic", () => {
    const target = pod("orders-1");
    const restarted = pod("orders-2", {
      status: "restarted",
      severity: "warning",
    });
    const impact = restartImpact(target, [target, restarted]);
    expect(impact.others[0]?.note).toBe("주의");
    expect(impact.serving).toBe(1);
    expect(impact.warnings).toEqual([]);
  });
});

describe("shortPodName", () => {
  it("takes the last part", () => {
    expect(shortPodName("demo-app-7c9f8b6d5-9kd2p")).toBe("9kd2p");
    expect(shortPodName("debug")).toBe("debug");
  });
});
