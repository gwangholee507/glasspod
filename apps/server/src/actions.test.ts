import { ApiException } from "@kubernetes/client-node";
import type { ActionItem, ActionRequest, PodRef } from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionService, kubeFailure, parseActionRequest } from "./actions.js";
import { ClusterState } from "./cluster.js";
import type { PodSummary } from "./cluster.js";
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

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action: "restart-pod",
    target: POD,
    expectedUid: "uid-1",
    ...overrides,
  };
}

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
  const store = new MemoryStore();
  const deletePod = vi.fn<KubeActions["deletePod"]>(async () => {});
  const recorded: ActionItem[] = [];
  let id = 0;
  const clock = { now: 1_000 };
  const service = new ActionService({
    actionNamespaces: options.actionNamespaces ?? ["shop"],
    cluster,
    kube: options.kube === null ? undefined : (options.kube ?? { deletePod }),
    store,
    onRecorded: (item) => recorded.push(item),
    now: () => (clock.now += 5),
    newId: () => `id-${(id += 1)}`,
  });
  return { cluster, store, deletePod, recorded, service };
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
  ])("rejects %s", (_label, body) => {
    expect(parseActionRequest(body).ok).toBe(false);
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
    const { service, store } = setup({ kube: { deletePod } });
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
    const { service } = setup({ kube: { deletePod } });
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
});
