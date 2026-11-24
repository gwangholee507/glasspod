import { ApiException } from "@kubernetes/client-node";
import type { ActionItem, ActionRequest, PodRef } from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionService,
  MAX_SCALE_REPLICAS,
  kubeFailure,
  parseActionRequest,
} from "./actions.js";
import { ClusterState } from "./cluster.js";
import type { PodSummary } from "./cluster.js";
import { scalePatch } from "./kube-actions.js";
import type { KubeActions } from "./kube-actions.js";
import { MemoryStore } from "./store/memory.js";

const POD: PodRef = { namespace: "shop", name: "orders-1" };

function summary(overrides: Partial<PodSummary> = {}): PodSummary {
  return {
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
    replicaSet: "orders-7d9f8",
    createdAt: undefined,
    ...overrides,
  };
}

const DEPLOYMENT: PodRef = { namespace: "shop", name: "orders" };

function scaleRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action: "scale-deployment",
    target: DEPLOYMENT,
    expectedUid: "dep-uid",
    replicas: 5,
    ...overrides,
  };
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action: "restart-pod",
    target: POD,
    expectedUid: "uid-1",
    ...overrides,
  };
}

// 가짜 쿠버네티스입니다. 데모 앱처럼 Service와 ReplicaSet이 app 라벨을 함께 씁니다.
function fakeKube(overrides: Partial<KubeActions> = {}) {
  const kube = {
    deletePod: vi.fn<KubeActions["deletePod"]>(async () => {}),
    readPod: vi.fn<KubeActions["readPod"]>(async () => ({
      uid: "uid-1",
      resourceVersion: "42",
      labels: { app: "orders", "pod-template-hash": "7d9f8" },
      terminating: false,
      isolated: false,
      replicaSet: "orders-7d9f8",
    })),
    readReplicaSet: vi.fn<KubeActions["readReplicaSet"]>(async (_ns, name) => ({
      name,
      deployment: "orders",
      matchLabels: { app: "orders", "pod-template-hash": "7d9f8" },
    })),
    listServices: vi.fn<KubeActions["listServices"]>(async () => [
      { name: "orders", selector: { app: "orders" } },
      { name: "other", selector: { app: "payments" } },
    ]),
    patchPod: vi.fn<KubeActions["patchPod"]>(async () => {}),
    readDeploymentScale: vi.fn<KubeActions["readDeploymentScale"]>(
      async () => ({ uid: "dep-uid", replicas: 3 }),
    ),
    patchDeploymentScale: vi.fn<KubeActions["patchDeploymentScale"]>(
      async () => {},
    ),
  };
  return Object.assign(kube, overrides);
}

const ISOLATION = { labels: { app: "orders" }, deployment: "orders" };

function setup(
  options: {
    actionNamespaces?: string[];
    kube?: KubeActions | null;
  } = {},
) {
  const cluster = new ClusterState();
  cluster.pods.set(summary());
  cluster.replicaSets.set({
    namespace: "shop",
    name: "orders-7d9f8",
    uid: "rs",
    deployment: "orders",
    revision: "1",
    desired: 3,
  });
  cluster.deployments.set({
    namespace: "shop",
    name: "orders",
    uid: "dep-uid",
    desired: 3,
    ready: 3,
    available: 3,
  });
  const store = new MemoryStore();
  const kube = fakeKube();
  const deletePod = kube.deletePod;
  const recorded: ActionItem[] = [];
  let id = 0;
  const clock = { now: 1_000 };
  const service = new ActionService({
    actionNamespaces: options.actionNamespaces ?? ["shop"],
    cluster,
    kube: options.kube === null ? undefined : (options.kube ?? kube),
    store,
    onRecorded: (item) => recorded.push(item),
    statusOf: () => "stalled",
    now: () => (clock.now += 5),
    newId: () => `id-${(id += 1)}`,
  });
  return { cluster, store, kube, deletePod, recorded, service };
}

describe("parseActionRequest", () => {
  it("accepts a restart request and ignores unknown fields", () => {
    expect(
      parseActionRequest({ ...request(), extra: true, target: { ...POD } }),
    ).toEqual({ ok: true, request: request() });
  });

  it.each([
    ["not an object", "restart"],
    ["unknown action", { ...request(), action: "delete-everything" }],
    ["no target", { action: "restart-pod", expectedUid: "u" }],
    [
      "bad namespace",
      { ...request(), target: { namespace: "Shop", name: "a" } },
    ],
    ["bad name", { ...request(), target: { namespace: "shop", name: "a/b" } }],
    ["no uid", { action: "restart-pod", target: POD }],
    ["empty uid", { ...request(), expectedUid: "" }],
    ["scale without replicas", scaleRequest({ replicas: undefined })],
    ["negative replicas", scaleRequest({ replicas: -1 })],
    ["too many replicas", scaleRequest({ replicas: MAX_SCALE_REPLICAS + 1 })],
    ["fractional replicas", scaleRequest({ replicas: 2.5 })],
    ["string replicas", { ...scaleRequest(), replicas: "3" }],
  ])("rejects %s", (_label, body) => {
    expect(parseActionRequest(body).ok).toBe(false);
  });

  it("accepts replicas only for scaling, from 0 to the limit", () => {
    expect(parseActionRequest(scaleRequest({ replicas: 0 }))).toEqual({
      ok: true,
      request: scaleRequest({ replicas: 0 }),
    });
    expect(
      parseActionRequest(scaleRequest({ replicas: MAX_SCALE_REPLICAS })).ok,
    ).toBe(true);
    // 다른 조치의 replicas는 무시합니다.
    expect(parseActionRequest({ ...request(), replicas: 99 })).toEqual({
      ok: true,
      request: request(),
    });
  });
});

describe("kubeFailure", () => {
  it("maps kubernetes status codes", () => {
    const body = JSON.stringify({ kind: "Status", message: "pods not found" });
    expect(kubeFailure(new ApiException(404, "", body, {}))).toEqual({
      status: 404,
      error: "target-not-found",
      detail: "pods not found",
      kubeStatus: 404,
    });
    expect(kubeFailure(new ApiException(409, "", "", {}))).toMatchObject({
      status: 409,
      error: "target-changed",
      detail: "http 409",
    });
    expect(kubeFailure(new ApiException(403, "", body, {}))).toMatchObject({
      status: 502,
      error: "kube-forbidden",
      kubeStatus: 403,
    });
    expect(kubeFailure(new ApiException(500, "", body, {}))).toMatchObject({
      status: 502,
      error: "kube-error",
      kubeStatus: 500,
    });
  });

  it("maps a timeout and other errors", () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    expect(kubeFailure(timeout, 10_000)).toEqual({
      status: 504,
      error: "kube-timeout",
      detail: "kubernetes did not answer in 10000ms",
    });
    expect(kubeFailure(new Error("socket hang up"))).toMatchObject({
      status: 502,
      error: "kube-error",
      detail: "socket hang up",
    });
  });
});

describe("ActionService", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the pod with its uid and records the success", async () => {
    const { service, deletePod, store, recorded } = setup();
    const outcome = await service.run(request(), { kind: "user" });
    expect(deletePod).toHaveBeenCalledWith(POD, "uid-1");
    expect(outcome).toEqual({
      status: 200,
      item: {
        id: "id-1",
        action: "restart-pod",
        target: { kind: "pod", ...POD, uid: "uid-1" },
        actor: { kind: "user" },
        requestedAt: 1_005,
        finishedAt: 1_010,
        result: "succeeded",
        replicaSet: "orders-7d9f8",
        deployment: "orders",
      },
    });
    expect(await store.actions()).toEqual([outcome.item]);
    expect(recorded).toEqual([outcome.item]);
  });

  it("checks in order and records each failure without calling kubernetes", async () => {
    const cases: [ReturnType<typeof setup>, ActionRequest, number, string][] =
      [];
    cases.push([
      setup({ actionNamespaces: [] }),
      request(),
      403,
      "action-not-allowed",
    ]);
    cases.push([setup({ kube: null }), request(), 503, "kube-unavailable"]);
    cases.push([
      setup(),
      request({ target: { namespace: "shop", name: "gone" } }),
      404,
      "target-not-found",
    ]);
    cases.push([
      setup(),
      request({ expectedUid: "uid-0" }),
      409,
      "target-changed",
    ]);
    const terminating = setup();
    terminating.cluster.pods.set(summary({ terminating: true }));
    cases.push([terminating, request(), 409, "target-terminating"]);

    for (const [context, body, status, error] of cases) {
      const outcome = await context.service.run(body, { kind: "user" });
      expect(outcome.status).toBe(status);
      expect(outcome.item).toMatchObject({ result: "failed", error });
      expect(outcome.item.detail).toBeTypeOf("string");
      expect(context.deletePod).not.toHaveBeenCalled();
      expect(await context.store.actions()).toHaveLength(1);
    }
  });

  it("rejects a second action on the same pod while the first is running", async () => {
    let finish: () => void = () => {};
    // 첫 호출만 끝나지 않고 기다리고, 그 뒤 호출은 바로 끝납니다.
    const deletePod = vi
      .fn<KubeActions["deletePod"]>(async () => {})
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
    const { service, store } = setup({ kube: fakeKube({ deletePod }) });
    const first = service.run(request(), { kind: "user" });
    const second = await service.run(request(), { kind: "user" });
    expect(second.status).toBe(409);
    expect(second.item.error).toBe("action-in-progress");
    finish();
    expect((await first).status).toBe(200);
    expect(deletePod).toHaveBeenCalledTimes(1);
    expect(await store.actions()).toHaveLength(2);
    // 끝난 뒤에는 다시 실행할 수 있습니다.
    expect((await service.run(request(), { kind: "user" })).status).toBe(200);
  });

  it("records a kubernetes failure with its status code", async () => {
    const deletePod = vi.fn<KubeActions["deletePod"]>(async () => {
      throw new ApiException(
        409,
        "",
        JSON.stringify({ message: "Precondition failed: UID" }),
        {},
      );
    });
    const { service } = setup({ kube: fakeKube({ deletePod }) });
    const outcome = await service.run(request(), { kind: "user" });
    expect(outcome.status).toBe(409);
    expect(outcome.item).toMatchObject({
      result: "failed",
      error: "target-changed",
      kubeStatus: 409,
      detail: "Precondition failed: UID",
      replicaSet: "orders-7d9f8",
    });
  });
  it("isolates a pod by removing the shared label and annotating it", async () => {
    const { service, kube, recorded } = setup();
    const outcome = await service.run(request({ action: "isolate-pod" }), {
      kind: "user",
    });
    expect(outcome.status).toBe(200);
    expect(kube.readPod).toHaveBeenCalledWith(POD);
    expect(kube.readReplicaSet).toHaveBeenCalledWith("shop", "orders-7d9f8");
    expect(kube.patchPod).toHaveBeenCalledWith(POD, {
      metadata: {
        resourceVersion: "42",
        labels: { app: null, "glasspod/isolated": "true" },
        annotations: {
          "glasspod/isolated-at": new Date(1_010).toISOString(),
          "glasspod/isolated-labels": '{"app":"orders"}',
          "glasspod/isolated-by": "user",
          "glasspod/isolated-status": "stalled",
          "glasspod/isolated-deployment": "orders",
          "glasspod/isolated-replicaset": "orders-7d9f8",
        },
      },
    });
    expect(kube.deletePod).not.toHaveBeenCalled();
    expect(outcome.item).toMatchObject({
      action: "isolate-pod",
      result: "succeeded",
      replicaSet: "orders-7d9f8",
      deployment: "orders",
      isolation: { labels: { app: "orders" }, services: ["orders"] },
    });
    expect(recorded).toEqual([outcome.item]);
  });

  it("checks isolation before calling kubernetes", async () => {
    const isolated = setup();
    isolated.cluster.pods.set(summary({ isolation: ISOLATION }));
    for (const action of ["isolate-pod", "restart-pod"] as const) {
      const outcome = await isolated.service.run(request({ action }), {
        kind: "user",
      });
      expect(outcome.status).toBe(409);
      expect(outcome.item.error).toBe("target-isolated");
    }
    const deleted = await isolated.service.run(
      request({ action: "delete-pod" }),
      { kind: "user" },
    );
    expect(deleted.status).toBe(200);
    expect(isolated.kube.deletePod).toHaveBeenCalledTimes(1);
    expect(isolated.kube.readPod).not.toHaveBeenCalled();
    expect(isolated.kube.patchPod).not.toHaveBeenCalled();

    const normal = setup();
    const outcome = await normal.service.run(
      request({ action: "delete-pod" }),
      { kind: "user" },
    );
    expect(outcome.status).toBe(409);
    expect(outcome.item).toMatchObject({
      result: "failed",
      error: "target-not-isolated",
    });
    expect(normal.kube.deletePod).not.toHaveBeenCalled();
    expect(await normal.store.actions()).toHaveLength(1);
  });

  it("re-checks the fresh pod and records why it cannot isolate", async () => {
    const fresh = await fakeKube().readPod(POD);
    const cases: [Partial<KubeActions>, number, string][] = [
      [
        { readPod: async () => ({ ...fresh, uid: "uid-2" }) },
        409,
        "target-changed",
      ],
      [
        { readPod: async () => ({ ...fresh, isolated: true }) },
        409,
        "target-isolated",
      ],
      [
        { readPod: async () => ({ ...fresh, terminating: true }) },
        409,
        "target-terminating",
      ],
      [{ listServices: async () => [] }, 409, "cannot-isolate"],
      [
        {
          patchPod: async () => {
            throw new ApiException(409, "", "", {});
          },
        },
        409,
        "target-changed",
      ],
    ];
    for (const [overrides, status, error] of cases) {
      const kube = fakeKube(overrides);
      const { service, store } = setup({ kube });
      const outcome = await service.run(request({ action: "isolate-pod" }), {
        kind: "user",
      });
      expect(outcome.status).toBe(status);
      expect(outcome.item).toMatchObject({ result: "failed", error });
      expect(outcome.item.isolation).toBeUndefined();
      expect(await store.actions()).toHaveLength(1);
      if (error !== "target-changed" || overrides.patchPod === undefined) {
        expect(kube.patchPod).not.toHaveBeenCalled();
      }
    }
  });

  it("previews the isolation plan without recording", async () => {
    const { service, store, kube } = setup();
    expect(await service.previewIsolation(POD)).toEqual({
      ok: true,
      uid: "uid-1",
      plan: {
        labels: { app: "orders" },
        services: ["orders"],
        replicaSet: "orders-7d9f8",
        deployment: "orders",
      },
    });
    expect(kube.patchPod).not.toHaveBeenCalled();
    expect(await store.actions()).toEqual([]);

    // ReplicaSet이 막 지워졌으면 컨트롤러가 없는 Pod로 계획합니다.
    const gone = setup({
      kube: fakeKube({
        readReplicaSet: async () => {
          throw new ApiException(404, "", "", {});
        },
      }),
    });
    expect(await gone.service.previewIsolation(POD)).toMatchObject({
      ok: true,
      plan: { labels: { app: "orders" }, services: ["orders"] },
    });

    const forbidden = setup({
      kube: fakeKube({
        listServices: async () => {
          throw new ApiException(403, "", "", {});
        },
      }),
    });
    expect(await forbidden.service.previewIsolation(POD)).toMatchObject({
      ok: false,
      failure: { status: 502, error: "kube-forbidden", kubeStatus: 403 },
    });
    expect(
      await setup({ actionNamespaces: [] }).service.previewIsolation(POD),
    ).toMatchObject({ ok: false, failure: { error: "action-not-allowed" } });
    expect(
      await setup().service.previewIsolation({ namespace: "shop", name: "x" }),
    ).toMatchObject({ ok: false, failure: { error: "target-not-found" } });
  });
});

describe("ActionService scale-deployment", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the merge patch with the uid precondition", () => {
    expect(scalePatch("dep-uid", 5)).toEqual({
      metadata: { uid: "dep-uid" },
      spec: { replicas: 5 },
    });
  });

  it("reads the scale, patches it, and records from, to and the hpa", async () => {
    const { service, kube, store } = setup();
    const outcome = await service.run(scaleRequest(), { kind: "user" });
    expect(kube.readDeploymentScale).toHaveBeenCalledWith("shop", "orders");
    expect(kube.patchDeploymentScale).toHaveBeenCalledWith(
      "shop",
      "orders",
      "dep-uid",
      5,
    );
    expect(outcome).toEqual({
      status: 200,
      item: {
        id: "id-1",
        action: "scale-deployment",
        target: { kind: "deployment", ...DEPLOYMENT, uid: "dep-uid" },
        actor: { kind: "user" },
        requestedAt: 1_005,
        finishedAt: 1_010,
        result: "succeeded",
        scale: { from: 3, to: 5 },
      },
    });
    // Pod 상세의 조치 기록에는 Deployment 대상이 들어가지 않습니다.
    expect(await store.actions({ namespace: "shop" })).toHaveLength(1);
    expect(
      await store.actions({ pod: { namespace: "shop", name: "orders" } }),
    ).toEqual([]);

    const withHpa = setup();
    withHpa.cluster.hpas.set({
      namespace: "shop",
      name: "orders-hpa",
      uid: "hpa",
      target: "orders",
      minReplicas: 3,
      maxReplicas: 5,
    });
    const scaled = await withHpa.service.run(scaleRequest({ replicas: 0 }), {
      kind: "user",
    });
    expect(scaled.item.scale).toEqual({ from: 3, to: 0, hpa: "orders-hpa" });
  });

  it("checks the deployment in order without calling kubernetes", async () => {
    const cases: [ReturnType<typeof setup>, ActionRequest, number, string][] = [
      [
        setup({ actionNamespaces: [] }),
        scaleRequest(),
        403,
        "action-not-allowed",
      ],
      [setup({ kube: null }), scaleRequest(), 503, "kube-unavailable"],
      [
        setup(),
        scaleRequest({ target: { namespace: "shop", name: "gone" } }),
        404,
        "target-not-found",
      ],
      [setup(), scaleRequest({ expectedUid: "dep-0" }), 409, "target-changed"],
    ];
    // 이름이 Deployment와 같은 Pod가 있어도 Pod 요약은 보지 않습니다.
    cases[2]![0].cluster.pods.set(summary({ name: "gone" }));

    for (const [context, body, status, error] of cases) {
      const outcome = await context.service.run(body, { kind: "user" });
      expect(outcome.status).toBe(status);
      expect(outcome.item).toMatchObject({
        result: "failed",
        error,
        target: { kind: "deployment" },
        scale: { to: 5 },
      });
      expect(outcome.item.scale?.from).toBeUndefined();
      expect(context.kube.readDeploymentScale).not.toHaveBeenCalled();
      expect(context.kube.patchDeploymentScale).not.toHaveBeenCalled();
    }
  });

  it("refuses a recreated deployment and keeps from when kubernetes fails", async () => {
    const recreated = setup({
      kube: fakeKube({
        readDeploymentScale: async () => ({ uid: "dep-new", replicas: 1 }),
      }),
    });
    const changed = await recreated.service.run(scaleRequest(), {
      kind: "user",
    });
    expect(changed.status).toBe(409);
    expect(changed.item).toMatchObject({
      error: "target-changed",
      scale: { to: 5 },
    });
    expect(changed.item.scale?.from).toBeUndefined();

    const forbidden = setup({
      kube: fakeKube({
        patchDeploymentScale: async () => {
          throw new ApiException(403, "", "", {});
        },
      }),
    });
    const failed = await forbidden.service.run(scaleRequest(), {
      kind: "user",
    });
    expect(failed.status).toBe(502);
    expect(failed.item).toMatchObject({
      error: "kube-forbidden",
      kubeStatus: 403,
      scale: { from: 3, to: 5 },
    });
  });

  it("runs pod and deployment actions with the same name side by side", async () => {
    let finish: () => void = () => {};
    const patchDeploymentScale = vi
      .fn<KubeActions["patchDeploymentScale"]>(async () => {})
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
    const { service, cluster } = setup({
      kube: fakeKube({ patchDeploymentScale }),
    });
    cluster.pods.set(summary({ name: "orders" }));
    const first = service.run(scaleRequest(), { kind: "user" });
    // 같은 Deployment는 막고, 이름이 같은 Pod는 막지 않습니다.
    expect(
      (await service.run(scaleRequest(), { kind: "user" })).item.error,
    ).toBe("action-in-progress");
    expect(
      (
        await service.run(
          request({ target: { namespace: "shop", name: "orders" } }),
          { kind: "user" },
        )
      ).status,
    ).toBe(200);
    finish();
    expect((await first).status).toBe(200);
  });
});
