import type { ActionItem, HelloMessage, PodRef } from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterState } from "./cluster.js";
import type { PodSummary } from "./cluster.js";
import { PodFeed, filterChanges } from "./feed.js";
import { AppStates } from "./pods.js";
import type { AppConnection } from "./pods.js";
import { StatusMonitor } from "./status-monitor.js";
import { MemoryStore } from "./store/memory.js";

function connection(pod: PodRef): AppConnection {
  const hello: HelloMessage = {
    type: "hello",
    seq: 0,
    ts: 1,
    protocol: 1,
    sdk: { lang: "node", version: "0.1.0" },
    pod,
    instanceId: `i-${pod.name}`,
  };
  return { hello };
}

function summary(namespace: string, name: string): PodSummary {
  return {
    namespace,
    name,
    uid: `uid-${name}`,
    phase: "Running",
    ready: true,
    terminating: false,
    restarts: 0,
    waiting: undefined,
    lastTermination: undefined,
    ip: undefined,
    replicaSet: undefined,
    createdAt: undefined,
  };
}

function setup(namespaces: string[] = ["shop"]) {
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
  const feed = new PodFeed({
    statuses,
    apps,
    cluster,
    namespaces,
    now: () => clock.now,
  });
  const tick = () => feed.refresh(statuses.evaluate());
  return { clock, apps, cluster, statuses, feed, tick };
}

describe("PodFeed", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends new pods once and then only what changed", () => {
    const { apps, cluster, clock, feed, tick } = setup();
    cluster.pods.set(summary("shop", "orders-2"));
    cluster.pods.set(summary("shop", "orders-1"));
    cluster.deployments.set({
      namespace: "shop",
      name: "orders",
      uid: "d",
      desired: 2,
      ready: 2,
      available: 2,
    });

    const first = tick();
    expect(first.pods.map((item) => item.pod.name)).toEqual([
      "orders-1",
      "orders-2",
    ]);
    expect(first.deployments).toHaveLength(1);
    expect(first.statusChanges.map((change) => change.status)).toEqual([
      "no-sdk",
      "no-sdk",
    ]);
    expect(first.namespaces).toBeUndefined();

    // 아무것도 바뀌지 않으면 빈 변화입니다.
    clock.now = 11_000;
    const quiet = tick();
    expect(quiet).toMatchObject({
      serverTime: 11_000,
      pods: [],
      removedPods: [],
      deployments: [],
      removedDeployments: [],
      statusChanges: [],
    });

    // HPA가 붙으면 그 Deployment 항목이 바뀝니다(docs/guides/T24.md 결정 10).
    clock.now = 11_500;
    cluster.hpas.set({
      namespace: "shop",
      name: "orders",
      uid: "h",
      target: "orders",
      minReplicas: 2,
      maxReplicas: 4,
    });
    expect(tick().deployments).toEqual([
      {
        namespace: "shop",
        name: "orders",
        uid: "d",
        desired: 2,
        ready: 2,
        available: 2,
        hpa: { name: "orders", minReplicas: 2, maxReplicas: 4 },
      },
    ]);

    // 한 Pod에 SDK가 붙고, 다른 Pod와 Deployment가 사라집니다.
    clock.now = 12_000;
    apps.connect(connection({ namespace: "shop", name: "orders-1" }));
    cluster.pods.delete("shop", "orders-2");
    cluster.deployments.delete("shop", "orders");
    const changed = tick();
    expect(changed.pods.map((item) => [item.pod.name, item.status])).toEqual([
      ["orders-1", "ok"],
    ]);
    expect(changed.removedPods).toEqual([
      { namespace: "shop", name: "orders-2" },
    ]);
    expect(changed.removedDeployments).toEqual([
      { namespace: "shop", name: "orders" },
    ]);
    expect(changed.statusChanges).toMatchObject([
      { pod: { name: "orders-1" }, status: "ok", previous: "no-sdk" },
    ]);

    expect(feed.list()).toMatchObject({
      serverTime: 12_000,
      namespaces: ["shop"],
      deployments: [],
      pods: [{ pod: { name: "orders-1" }, status: "ok" }],
    });
    expect(feed.item({ namespace: "shop", name: "orders-2" })).toBeUndefined();
  });

  it("lists watched namespaces first and reports new ones", () => {
    const { apps, cluster, clock, feed, tick } = setup(["shop", "billing"]);
    cluster.pods.set(summary("shop", "orders-1"));
    tick();
    expect(feed.list().namespaces).toEqual(["shop", "billing"]);

    // watch하지 않는 namespace의 SDK가 붙으면 목록 뒤에 이름순으로 붙습니다.
    clock.now = 11_000;
    apps.connect(connection({ namespace: "zeta", name: "z-1" }));
    apps.connect(connection({ namespace: "alpha", name: "a-1" }));
    const changes = tick();
    expect(changes.namespaces).toEqual(["shop", "billing", "alpha", "zeta"]);
    expect(feed.list("alpha").pods.map((item) => item.pod.name)).toEqual([
      "a-1",
    ]);
    expect(feed.list("alpha").namespaces).toEqual([
      "shop",
      "billing",
      "alpha",
      "zeta",
    ]);
    expect(feed.list("nowhere").pods).toEqual([]);
  });
});

function action(namespace: string, name: string): ActionItem {
  return {
    id: `a-${namespace}-${name}`,
    action: "restart-pod",
    target: { kind: "pod", namespace, name, uid: `uid-${name}` },
    actor: { kind: "user" },
    requestedAt: 1,
    finishedAt: 2,
    result: "succeeded",
  };
}

describe("PodFeed actions", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a finished action once in the next changes", () => {
    const { feed, tick } = setup();
    tick();
    feed.queueAction(action("shop", "orders-1"));
    expect(tick().actions.map((item) => item.id)).toEqual(["a-shop-orders-1"]);
    expect(tick().actions).toEqual([]);
  });

  it("lists the action namespaces", () => {
    const { statuses, apps, cluster } = setup();
    const feed = new PodFeed({
      statuses,
      apps,
      cluster,
      namespaces: ["shop", "pay"],
      actionNamespaces: ["shop"],
    });
    expect(feed.list().actionNamespaces).toEqual(["shop"]);
    expect(feed.list("pay").actionNamespaces).toEqual(["shop"]);
  });
});

describe("filterChanges", () => {
  const base = {
    serverTime: 1,
    pods: [],
    removedPods: [],
    deployments: [],
    removedDeployments: [],
    statusChanges: [],
    actions: [],
  };

  it("keeps only the namespace and drops empty changes", () => {
    const changes = {
      ...base,
      removedPods: [
        { namespace: "shop", name: "a" },
        { namespace: "pay", name: "b" },
      ],
    };
    expect(filterChanges(changes, "shop")?.removedPods).toEqual([
      { namespace: "shop", name: "a" },
    ]);
    expect(filterChanges(changes, "else")).toBeUndefined();
    expect(filterChanges(changes, undefined)).toBe(changes);
    expect(filterChanges(base, undefined)).toBeUndefined();
  });

  it("keeps only the actions of the namespace", () => {
    const changes = {
      ...base,
      actions: [action("shop", "a"), action("pay", "b")],
    };
    expect(
      filterChanges(changes, "shop")?.actions.map((item) => item.id),
    ).toEqual(["a-shop-a"]);
    expect(filterChanges(changes, "else")).toBeUndefined();
  });

  it("always passes a new namespace list", () => {
    expect(
      filterChanges({ ...base, namespaces: ["shop", "pay"] }, "else"),
    ).toEqual({ ...base, namespaces: ["shop", "pay"] });
  });
});
