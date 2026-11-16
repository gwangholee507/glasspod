import type { EventMessage, HelloMessage, PodRef } from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterState } from "./cluster.js";
import type { PodSummary } from "./cluster.js";
import { AppStates } from "./pods.js";
import type { AppConnection } from "./pods.js";
import { StatusMonitor } from "./status-monitor.js";
import { MemoryStore } from "./store/memory.js";

const POD: PodRef = { namespace: "shop", name: "orders-1" };

function connection(instanceId: string, pod: PodRef = POD): AppConnection {
  const hello: HelloMessage = {
    type: "hello",
    seq: 0,
    ts: 1,
    protocol: 1,
    sdk: { lang: "node", version: "0.1.0" },
    pod,
    instanceId,
  };
  return { hello };
}

function summary(name: string, fields: Partial<PodSummary> = {}): PodSummary {
  return {
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
    replicaSet: undefined,
    createdAt: undefined,
    ...fields,
  };
}

function event(seq: number, fields: Partial<EventMessage>): EventMessage {
  return {
    type: "event",
    seq,
    ts: 9_000 + seq,
    level: "info",
    name: "state",
    count: 1,
    ...fields,
  };
}

function setup() {
  const clock = { now: 10_000 };
  const store = new MemoryStore();
  const apps = new AppStates(store, () => clock.now);
  const cluster = new ClusterState();
  const monitor = new StatusMonitor({
    apps,
    cluster,
    store,
    metricsIntervalMs: 5000,
    now: () => clock.now,
  });
  return { clock, store, apps, cluster, monitor };
}

function lines(): string[] {
  return [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ].map((call) => String(call[0]));
}

function statusLines(): string[] {
  return lines().filter((line) => / pod status /.test(line));
}

describe("StatusMonitor", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("judges pods from Kubernetes and from SDK connections", () => {
    const { apps, cluster, monitor } = setup();
    cluster.pods.set(summary("load-1"));
    // 쿠버네티스에 없는 이름(노트북 데모)도 판단합니다.
    apps.connect(connection("a", { namespace: "shop", name: "demo-1" }));
    monitor.evaluate();

    expect(monitor.get({ namespace: "shop", name: "load-1" })).toMatchObject({
      status: "no-sdk",
      since: 10_000,
    });
    expect(monitor.get({ namespace: "shop", name: "demo-1" })).toMatchObject({
      status: "ok",
      since: 10_000,
    });
    expect(monitor.list()).toHaveLength(2);
    expect(statusLines()).toHaveLength(2);
    expect(statusLines()[0]).toContain("status=no-sdk severity=none");
  });

  it("logs only when the judgment changes and keeps since while it stays", () => {
    const { apps, cluster, clock, monitor } = setup();
    cluster.pods.set(summary(POD.name));
    apps.connect(connection("a"));
    monitor.evaluate();
    clock.now = 20_000;
    monitor.evaluate();
    expect(statusLines()).toHaveLength(1);

    // 연결한 뒤 15초 동안 metrics가 없습니다.
    clock.now = 25_000;
    monitor.evaluate();
    clock.now = 26_000;
    monitor.evaluate();
    expect(monitor.get(POD)).toMatchObject({
      status: "stalled",
      since: 25_000,
      silentMs: 16_000,
    });
    expect(statusLines()).toHaveLength(2);
    expect(statusLines()[1]).toMatch(
      /WARN {2}pod status pod=shop\/orders-1 status=stalled previous=ok severity=critical reason=no-metrics silentMs=15000$/,
    );
  });

  it("logs restart causes of the previous instance once", async () => {
    const { apps, cluster, clock, monitor } = setup();
    cluster.pods.set(summary(POD.name));
    const first = connection("a");
    apps.connect(first);
    apps.receive(
      first,
      event(1, { name: "state", message: "app.mode: ready" }),
    );
    apps.receive(
      first,
      event(2, {
        level: "error",
        name: "exception",
        message: "crash requested",
        data: { errorType: "Error", fatal: true, stack: "..." },
      }),
    );
    apps.disconnect(first, 1006);
    monitor.evaluate();
    expect(monitor.get(POD)?.status).toBe("disconnected");

    clock.now = 12_000;
    apps.connect(connection("b"));
    monitor.evaluate();
    expect(monitor.get(POD)).toMatchObject({
      status: "restarted",
      restart: { at: 12_000, previousInstanceId: "a" },
    });
    await vi.waitFor(() =>
      expect(lines().some((line) => line.includes("restart causes"))).toBe(
        true,
      ),
    );
    const causes = lines().filter((line) => line.includes("restart cause "));
    expect(causes).toHaveLength(2);
    expect(causes[0]).toContain(
      "previousInstance=a rank=1 level=error name=exception count=1",
    );
    expect(causes[0]).toContain(
      'errorType=Error fatal=true message="crash requested"',
    );
    expect(causes[1]).toContain("rank=2 level=info name=state");

    // 쿠버네티스가 재시작을 알리면 판단은 그대로이고 재시작 정보가 바뀌어 한 줄 남깁니다. 원인 후보는 다시 찾지 않습니다.
    cluster.pods.set(
      summary(POD.name, {
        restarts: 1,
        lastTermination: {
          container: "app",
          reason: "Error",
          exitCode: 1,
          finishedAt: new Date(11_000).toISOString(),
        },
      }),
    );
    monitor.evaluate();
    await new Promise((resolve) => setImmediate(resolve));
    expect(monitor.get(POD)).toMatchObject({
      status: "restarted",
      reason: "Error",
      since: 12_000,
    });
    expect(statusLines().at(-1)).toContain(
      "status=restarted previous=restarted severity=warning reason=Error restartAt=1970-01-01T00:00:11.000Z restartReason=Error exitCode=1 previousInstance=a",
    );
    expect(
      lines().filter((line) => line.includes("restart causes")),
    ).toHaveLength(1);
  });

  it("marks a deleted pod as terminated and drops pods that are gone everywhere", () => {
    const { apps, cluster, monitor } = setup();
    const deleted = summary(POD.name);
    cluster.pods.set(deleted);
    cluster.pods.set(summary("load-1"));
    apps.connect(connection("a"));
    monitor.evaluate();

    cluster.pods.delete("shop", POD.name);
    apps.podDeleted(deleted);
    cluster.pods.delete("shop", "load-1");
    monitor.evaluate();

    expect(monitor.get(POD)).toMatchObject({
      status: "terminated",
      reason: "deleted",
    });
    expect(monitor.get({ namespace: "shop", name: "load-1" })).toBeUndefined();
    expect(
      lines().some((line) =>
        line.includes("pod status removed pod=shop/load-1 previous=no-sdk"),
      ),
    ).toBe(true);
  });

  it("returns and stores status changes only when the status changes", async () => {
    const { apps, cluster, clock, store, monitor } = setup();
    cluster.replicaSets.set({
      namespace: "shop",
      name: "orders-5f7c9",
      uid: "rs",
      deployment: "orders",
      revision: "1",
      desired: 1,
    });
    cluster.pods.set(summary(POD.name, { replicaSet: "orders-5f7c9" }));
    // 서버가 처음 판단한 Pod는 previous가 없습니다.
    expect(monitor.evaluate()).toEqual([
      {
        pod: POD,
        at: 10_000,
        status: "no-sdk",
        severity: "none",
        deployment: "orders",
      },
    ]);
    // 판단이 그대로면 남기지 않습니다.
    clock.now = 11_000;
    expect(monitor.evaluate()).toEqual([]);

    clock.now = 12_000;
    apps.connect(connection("a"));
    expect(monitor.evaluate()).toEqual([
      {
        pod: POD,
        at: 12_000,
        status: "ok",
        severity: "none",
        previous: "no-sdk",
        deployment: "orders",
      },
    ]);
    await vi.waitFor(async () =>
      expect(
        (await store.statusChanges(0)).map((record) => record.status),
      ).toEqual(["no-sdk", "ok"]),
    );
  });

  it("keeps the deployment of a pod after Kubernetes forgets it", () => {
    const { apps, cluster, monitor } = setup();
    cluster.replicaSets.set({
      namespace: "shop",
      name: "orders-5f7c9",
      uid: "rs",
      deployment: "orders",
      revision: "1",
      desired: 1,
    });
    const deleted = summary(POD.name, { replicaSet: "orders-5f7c9" });
    cluster.pods.set(deleted);
    apps.connect(connection("a"));
    monitor.evaluate();
    expect(monitor.get(POD)?.deployment).toBe("orders");

    cluster.pods.delete("shop", POD.name);
    apps.podDeleted(deleted);
    const changes = monitor.evaluate();
    expect(monitor.get(POD)).toMatchObject({
      status: "terminated",
      deployment: "orders",
    });
    expect(changes).toMatchObject([
      { status: "terminated", reason: "deleted", deployment: "orders" },
    ]);
  });
});
