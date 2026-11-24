import type { ActionItem, DeploymentItem, PodItem } from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import {
  NO_ACTION_FILTER,
  actionSentence,
  errorSentence,
  filterActions,
  formatActionTime,
  mergeActions,
  actionBlockReason,
  hpaRange,
  isActionOn,
  isReplicaCount,
  isolateSteps,
  isolatedPods,
  restartImpact,
  scaleBlockReason,
  scalePlan,
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

// restart-pod의 끄는 이유입니다(T21과 같음).
function restartBlockReason(
  ...args: Parameters<typeof actionBlockReason> extends [unknown, ...infer R]
    ? R
    : never
) {
  return actionBlockReason("restart-pod", ...args);
}

describe("actionBlockReason", () => {
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

// 트래픽에서 뺀 Pod입니다. ReplicaSet이 놓아주어 Deployment가 없습니다.
function isolated(name: string, at?: number): PodItem {
  const { deployment: _deployment, ...rest } = pod(name);
  return {
    ...rest,
    kube: {
      ...rest.kube!,
      isolation: {
        labels: { app: "orders" },
        status: "stalled",
        deployment: "orders",
        ...(at === undefined ? {} : { at }),
      },
    },
  };
}

describe("isolation", () => {
  it("lets only isolated pods be deleted, and only others be restarted or isolated", () => {
    const normal = pod("orders-1");
    const out = isolated("orders-x");
    expect(
      actionBlockReason("isolate-pod", normal.pod, normal, ["shop"]),
    ).toBeUndefined();
    expect(
      actionBlockReason("delete-pod", normal.pod, normal, ["shop"]),
    ).toMatch(/격리된 Pod만/);
    expect(actionBlockReason("delete-pod", out.pod, out, ["shop"])).toBe(
      undefined,
    );
    expect(actionBlockReason("restart-pod", out.pod, out, ["shop"])).toBe(
      "이미 트래픽에서 뺀 Pod입니다.",
    );
    expect(actionBlockReason("delete-pod", out.pod, out, [])).toMatch(
      /조치가 꺼져/,
    );
  });

  it("describes isolate and delete results", () => {
    expect(
      actionSentence(
        action({
          action: "isolate-pod",
          replicaSet: "orders-7d9f8",
          isolation: { labels: { app: "orders" }, services: ["orders"] },
        }),
      ),
    ).toBe(
      "Service orders에서 뺐습니다(뗀 라벨 app=orders). ReplicaSet orders-7d9f8이 대신할 새 Pod를 만듭니다.",
    );
    expect(actionSentence(action({ action: "delete-pod" }))).toBe(
      "격리된 Pod를 지웠습니다.",
    );
    expect(errorSentence("cannot-isolate")).toMatch(/뺄 수 없습니다/);
  });

  it("lists the plan as steps", () => {
    expect(isolateSteps(undefined)).toHaveLength(1);
    const steps = isolateSteps({
      labels: { app: "orders", tier: "web" },
      services: ["orders", "web"],
      replicaSet: "orders-7d9f8",
    });
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBe(
      "Pod 라벨을 바꿉니다. 떼는 라벨: app=orders, tier=web · 붙이는 라벨: glasspod/isolated=true",
    );
    expect(steps[1]).toBe(
      "Service orders, web이 이 Pod로 트래픽을 보내지 않습니다.",
    );
    expect(
      isolateSteps({ labels: { app: "a" }, services: ["a"] }),
    ).toHaveLength(3);
  });

  it("leaves isolated pods out of the traffic impact and words it for isolation", () => {
    const target = pod("orders-1");
    const impact = restartImpact(
      target,
      [
        target,
        pod("orders-2"),
        { ...isolated("orders-x"), deployment: "orders" },
      ],
      "isolate-pod",
    );
    expect(impact.others.map((row) => row.pod.name)).toEqual(["orders-2"]);
    const { replicaSet: _rs, ...noRs } = target.kube!;
    const loose = pod("debug", { kube: noRs });
    expect(restartImpact(loose, [loose], "isolate-pod").warnings[0]).toMatch(
      /대신할 Pod를 만들 컨트롤러가 없습니다/,
    );
    const stalled = pod("orders-3", {
      kube: { ...target.kube!, ready: false },
    });
    expect(
      restartImpact(target, [target, pod("orders-2"), stalled], "isolate-pod")
        .warnings[0],
    ).toMatch(/지금 빼면 새 Pod가 준비될 때까지 Pod 1개가/);
  });

  it("orders isolated pods by the latest isolation first", () => {
    expect(
      isolatedPods([
        pod("orders-1"),
        isolated("b", 1_000),
        isolated("c"),
        isolated("a", 2_000),
      ]).map((item) => item.pod.name),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("shortPodName", () => {
  it("takes the last part", () => {
    expect(shortPodName("demo-app-7c9f8b6d5-9kd2p")).toBe("9kd2p");
    expect(shortPodName("debug")).toBe("debug");
  });
});

describe("scale-deployment", () => {
  const deployment: DeploymentItem = {
    namespace: "shop",
    name: "orders",
    uid: "dep",
    desired: 3,
    ready: 3,
    available: 3,
  };
  const hpa = { name: "orders-hpa", minReplicas: 3, maxReplicas: 5 };
  const scaled = action({
    action: "scale-deployment",
    target: {
      kind: "deployment",
      namespace: "shop",
      name: "orders",
      uid: "dep",
    },
    scale: { from: 3, to: 5 },
  });

  it("describes the result with the hpa and deployment failures", () => {
    expect(actionSentence(scaled)).toBe(
      "Deployment orders의 replica 수를 3개에서 5개로 바꿨습니다.",
    );
    expect(
      actionSentence({
        ...scaled,
        scale: { from: 5, to: 2, hpa: "orders-hpa" },
      }),
    ).toBe(
      "Deployment orders의 replica 수를 5개에서 2개로 바꿨습니다. HPA가 다시 바꿀 수 있습니다(orders-hpa).",
    );
    expect(
      actionSentence({
        ...scaled,
        result: "failed",
        error: "target-not-found",
        kubeStatus: 404,
        scale: { to: 5 },
      }),
    ).toBe("HTTP 404 · Deployment가 이미 지워져 있습니다.");
    expect(errorSentence("target-changed", "deployment")).toBe(
      "같은 이름의 다른 Deployment로 바뀌었습니다. 목록을 다시 보고 실행합니다.",
    );
  });

  it("keeps deployment actions out of a pod with the same name", () => {
    const pod = { namespace: "shop", name: "orders" };
    expect(isActionOn(scaled, pod)).toBe(false);
    expect(
      isActionOn(action({ target: { kind: "pod", ...pod, uid: "u" } }), pod),
    ).toBe(true);
  });

  it("accepts whole counts from 0 to 20", () => {
    expect([0, 20].map(isReplicaCount)).toEqual([true, true]);
    expect([-1, 21, 2.5, Number.NaN].map(isReplicaCount)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("turns the button off while loading or when actions are off", () => {
    expect(scaleBlockReason(deployment, ["shop"])).toBeUndefined();
    expect(scaleBlockReason(deployment, undefined)).toBe(
      "서버에서 목록을 받는 중입니다.",
    );
    expect(scaleBlockReason(deployment, [])).toBe(
      "서버에서 조치가 꺼져 있습니다(GLASSPOD_ACTION_NAMESPACES).",
    );
    expect(hpaRange(hpa)).toBe("HPA 3~5");
  });

  it("plans scaling up with the current pods and leaves isolated pods out", () => {
    const pods = [
      pod("orders-b"),
      pod("orders-a"),
      pod("orders-gone", {
        kube: { ...pod("x").kube!, terminating: true },
      }),
      pod("orders-old", {
        deployment: undefined,
        kube: {
          ...pod("x").kube!,
          isolation: { labels: { app: "orders" }, deployment: "orders" },
        },
      }),
      pod("payments-1", { deployment: "payments" }),
    ];
    const plan = scalePlan(deployment, pods, 5);
    expect(plan.pods.map((row) => row.pod.name)).toEqual([
      "orders-a",
      "orders-b",
    ]);
    expect(plan).toMatchObject({ from: 3, to: 5, added: 2, removed: 0 });
    expect(plan.steps).toEqual([
      "Deployment orders의 replica 수를 3개에서 5개로 바꿉니다.",
      "ReplicaSet이 새 Pod 2개를 만듭니다. 준비되면 트래픽을 받습니다.",
      "격리된 Pod 1개는 Deployment가 관리하지 않아 이 수에 들지 않고 그대로 남습니다.",
    ]);
    expect(plan.warnings).toEqual([]);
    expect(plan.notice).toBe(
      "새 Pod는 readiness probe를 통과한 뒤에 트래픽을 받습니다.",
    );
  });

  it("plans scaling down, to zero, and to the same count", () => {
    const down = scalePlan(deployment, [], 1);
    expect(down).toMatchObject({ added: 0, removed: 2 });
    expect(down.steps).toEqual([
      "Deployment orders의 replica 수를 3개에서 1개로 바꿉니다.",
      "ReplicaSet이 Pod 2개를 지웁니다. 준비 안 된 Pod와 늦게 만든 Pod를 먼저 고릅니다.",
      "지운 Pod의 기록은 이 화면에 30분 남습니다.",
    ]);

    const zero = scalePlan(deployment, [], 0);
    expect(zero.steps[1]).toBe("ReplicaSet이 Pod 3개를 모두 지웁니다.");
    expect(zero.warnings).toEqual([
      "replica를 0개로 하면 이 Deployment의 Pod가 모두 지워져 트래픽을 받을 Pod가 없습니다.",
    ]);

    const same = scalePlan(deployment, [], 3);
    expect(same.steps).toEqual(["바꿀 replica 수를 고릅니다."]);
    expect(same.notice).toBe("replica 수는 0~20개로 고릅니다.");
  });

  it("warns about the hpa and when the count is outside its range", () => {
    const withHpa = { ...deployment, hpa };
    const note =
      "HPA orders-hpa(최소 3 · 최대 5)가 이 Deployment의 replica 수를 관리합니다. 바꾼 값은 HPA가 다시 바꿀 수 있습니다.";
    expect(scalePlan(withHpa, [], 4).warnings).toEqual([note]);
    expect(scalePlan(withHpa, [], 2).warnings).toEqual([
      `${note} 2개는 범위 밖이라 HPA가 곧 3개로 되돌립니다.`,
    ]);
    expect(scalePlan(withHpa, [], 7).warnings).toEqual([
      `${note} 7개는 범위 밖이라 HPA가 곧 5개로 되돌립니다.`,
    ]);
    expect(scalePlan(withHpa, [], 0).warnings[0]).toBe(
      `${note} 0개면 HPA가 이 Deployment를 조정하지 않습니다.`,
    );
  });
});
