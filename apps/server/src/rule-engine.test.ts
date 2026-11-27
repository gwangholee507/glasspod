import type {
  ActionActor,
  ActionItem,
  ActionRequest,
  PodOutlier,
  PodRef,
  PodSeverity,
  PodStatus,
  RuleDefinition,
  RuleFiring,
} from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionOutcome } from "./actions.js";
import { ClusterState } from "./cluster.js";
import type { PodSummary } from "./cluster.js";
import type { AppState } from "./pods.js";
import { RuleEngine } from "./rule-engine.js";
import type { PodStatusEntry } from "./status-monitor.js";
import { appState } from "./rules.test.js";

const PODS = ["orders-1", "orders-2", "orders-3"];
const SEVERITY: Partial<Record<PodStatus, PodSeverity>> = {
  stalled: "critical",
  disconnected: "critical",
  restarted: "warning",
};

function pod(name: string): PodRef {
  return { namespace: "shop", name };
}

function rule(fields: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    name: "stalled-restart",
    mode: "notify",
    target: { namespace: "shop", deployment: "orders" },
    when: [{ signal: "status", statuses: ["stalled"], forMs: 30_000 }],
    action: { kind: "restart" },
    cooldownMs: 600_000,
    ...fields,
  };
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
    replicaSet: "orders-5f7c9",
    createdAt: undefined,
    ...fields,
  };
}

// Deployment orders(원하는 수 3)의 Pod 3개입니다. 판단은 처음에 모두 ok, 지표 주기는 5초(3주기 15초)입니다.
function setup(rules: RuleDefinition[]) {
  const clock = { now: 100_000 };
  const cluster = new ClusterState();
  cluster.deployments.set({
    namespace: "shop",
    name: "orders",
    uid: "dep-orders",
    desired: 3,
    ready: 3,
    available: 3,
  });
  const statuses = new Map<string, PodStatus>();
  const entries = (): PodStatusEntry[] =>
    PODS.filter((name) => cluster.pods.get("shop", name) !== undefined).map(
      (name) => {
        const status = statuses.get(name) ?? "ok";
        return {
          pod: pod(name),
          status,
          severity: SEVERITY[status] ?? "none",
          since: 0,
          deployment: "orders",
        };
      },
    );
  for (const name of PODS) {
    cluster.pods.set(summary(name));
  }
  const apps = new Map<string, AppState>();
  const outliers = new Map<string, PodOutlier[]>();
  const source = { rules, state: {}, version: 1 };
  const calls: { request: ActionRequest; actor: ActionActor }[] = [];
  const pending: ((item: Partial<ActionItem>) => void)[] = [];
  const firings: RuleFiring[] = [];
  let ids = 0;
  const engine = new RuleEngine({
    source,
    statuses: { list: entries },
    apps: { get: (ref) => apps.get(ref.name) },
    cluster,
    outliers: { get: (ref) => outliers.get(ref.name) ?? [] },
    actions: {
      run: (request, actor) => {
        calls.push({ request, actor });
        return new Promise<ActionOutcome>((resolve) => {
          pending.push((fields) =>
            resolve({
              status: 200,
              item: {
                id: `action-${calls.length}`,
                action: request.action,
                target: {
                  kind:
                    request.action === "scale-deployment"
                      ? "deployment"
                      : "pod",
                  ...request.target,
                  uid: request.expectedUid,
                },
                actor,
                requestedAt: clock.now,
                finishedAt: clock.now,
                result: "succeeded",
                ...fields,
              },
            }),
          );
        });
      },
    },
    store: {
      addRuleFiring: async (firing) => {
        firings.push(firing);
      },
    },
    namespaces: ["shop"],
    actionNamespaces: ["shop"],
    metricsIntervalMs: 5000,
    now: () => clock.now,
    newId: () => `f${++ids}`,
  });
  // seconds초 동안 1초마다 판단합니다.
  const run = (seconds: number) => {
    for (let index = 0; index < seconds; index += 1) {
      clock.now += 1000;
      engine.evaluate();
    }
  };
  return {
    clock,
    cluster,
    statuses,
    apps,
    outliers,
    source,
    calls,
    pending,
    firings,
    engine,
    run,
  };
}

describe("RuleEngine", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifies after the condition lasts for its duration, then cools down", () => {
    const { statuses, firings, calls, engine, run, clock } = setup([rule()]);
    engine.evaluate();
    statuses.set("orders-1", "stalled");
    run(30);
    expect(firings).toEqual([]);
    expect(engine.view().rules[0]?.state.matching).toEqual([
      { pod: pod("orders-1"), since: 101_000, readyAt: 131_000 },
    ]);
    run(1);
    expect(firings).toEqual([
      {
        id: "f1",
        rule: "stalled-restart",
        mode: "notify",
        at: 131_000,
        action: "restart-pod",
        target: {
          kind: "pod",
          namespace: "shop",
          name: "orders-1",
          uid: "uid-orders-1",
        },
        pod: pod("orders-1"),
        deployment: "orders",
        conditions: [
          {
            condition: {
              signal: "status",
              statuses: ["stalled"],
              forMs: 30_000,
            },
            since: 101_000,
            status: "stalled",
          },
        ],
        outcome: "notified",
      },
    ]);
    expect(calls).toEqual([]);
    expect(engine.view().rules[0]?.state).toMatchObject({
      lastFiredAt: 131_000,
      coolingUntil: 731_000,
      firedLastHour: 1,
    });
    // 쉬는 동안은 발동하지 않고, 쉬는 시간이 지나면 다시 발동합니다.
    clock.now = 730_000;
    engine.evaluate();
    expect(firings).toHaveLength(1);
    clock.now = 731_000;
    engine.evaluate();
    expect(firings).toHaveLength(2);
  });

  it("starts the duration again when the condition stops holding", () => {
    const { statuses, firings, run } = setup([rule()]);
    statuses.set("orders-1", "stalled");
    run(20);
    statuses.set("orders-1", "ok");
    run(1);
    statuses.set("orders-1", "stalled");
    run(30);
    expect(firings).toEqual([]);
    run(1);
    expect(firings).toHaveLength(1);
  });

  it("needs every condition for its own duration", () => {
    const { statuses, apps, firings, run, engine } = setup([
      rule({
        when: [
          { signal: "status", statuses: ["stalled"], forMs: 10_000 },
          {
            signal: "metric",
            metric: "app.queue.length",
            compare: "above",
            threshold: 100,
            forMs: 20_000,
          },
        ],
      }),
    ]);
    statuses.set("orders-1", "stalled");
    run(5);
    apps.set(
      "orders-1",
      appState({
        values: new Map([
          [
            "app.queue.length",
            { kind: "gauge", value: 150, ts: 0, receivedAt: 105_000 },
          ],
        ]),
        lastMetricsAt: 105_000,
      }),
    );
    run(1);
    expect(engine.view().rules[0]?.state.matching).toEqual([
      { pod: pod("orders-1"), since: 106_000, readyAt: 126_000 },
    ]);
    // 지표 값이 오래되기 전까지(15초) 받은 값을 씁니다. 그 뒤 새 값을 받은 것으로 합니다.
    run(10);
    apps.set(
      "orders-1",
      appState({
        values: new Map([
          [
            "app.queue.length",
            { kind: "gauge", value: 150, ts: 0, receivedAt: 116_000 },
          ],
        ]),
        lastMetricsAt: 116_000,
      }),
    );
    run(9);
    expect(firings).toEqual([]);
    run(1);
    expect(firings[0]?.conditions.map((match) => match.value)).toEqual([
      undefined,
      150,
    ]);
  });

  it("picks the pod that met the conditions first, then by name", () => {
    const { statuses, firings, run } = setup([rule()]);
    statuses.set("orders-3", "stalled");
    statuses.set("orders-2", "stalled");
    run(31);
    // 둘 다 같은 때 맞았으므로 이름순으로 orders-2입니다. 건강한 Pod는 orders-1 하나라 건너뜁니다.
    expect(firings[0]?.pod).toEqual(pod("orders-2"));
  });

  it("skips pod actions when too few healthy pods would remain", () => {
    const { statuses, firings, calls, run } = setup([rule({ mode: "auto" })]);
    statuses.set("orders-1", "stalled");
    statuses.set("orders-2", "stalled");
    run(31);
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({
      outcome: "skipped",
      skipReason: "too-few-healthy",
      healthy: 1,
      needed: 2,
    });
    expect(calls).toEqual([]);
  });

  it("does not count pods that are not ready or are critical as healthy", () => {
    const { statuses, cluster, firings, run } = setup([rule()]);
    cluster.pods.set(summary("orders-2", { ready: false }));
    statuses.set("orders-1", "stalled");
    run(31);
    expect(firings[0]).toMatchObject({
      skipReason: "too-few-healthy",
      healthy: 1,
    });
  });

  it("runs the action as the rule in auto mode and records the result", async () => {
    const { statuses, firings, calls, pending, run, engine } = setup([
      rule({ mode: "auto" }),
    ]);
    statuses.set("orders-1", "stalled");
    run(31);
    expect(calls).toEqual([
      {
        request: {
          action: "restart-pod",
          target: { namespace: "shop", name: "orders-1" },
          expectedUid: "uid-orders-1",
        },
        actor: { kind: "rule", name: "stalled-restart" },
      },
    ]);
    expect(engine.view().rules[0]?.state.running).toBe(true);
    expect(firings).toEqual([]);
    pending[0]?.({});
    await vi.waitFor(() => expect(firings).toHaveLength(1));
    expect(firings[0]).toMatchObject({
      mode: "auto",
      outcome: "executed",
      at: 131_000,
      actionId: "action-1",
      actionResult: "succeeded",
    });
    expect(engine.view().rules[0]?.state.running).toBeUndefined();
  });

  it("records a failed auto action with its error", async () => {
    const { statuses, firings, pending, run } = setup([rule({ mode: "auto" })]);
    statuses.set("orders-1", "stalled");
    run(31);
    pending[0]?.({ result: "failed", error: "action-not-allowed" });
    await vi.waitFor(() => expect(firings).toHaveLength(1));
    expect(firings[0]).toMatchObject({
      outcome: "executed",
      actionResult: "failed",
      actionError: "action-not-allowed",
    });
  });

  it("skips after maxPerHour firings in an hour", () => {
    const { statuses, firings, run, clock, engine } = setup([
      rule({ cooldownMs: 30_000, maxPerHour: 1 }),
    ]);
    statuses.set("orders-1", "stalled");
    run(31);
    clock.now += 30_000;
    engine.evaluate();
    expect(firings.map((firing) => firing.outcome)).toEqual([
      "notified",
      "skipped",
    ]);
    expect(firings[1]?.skipReason).toBe("max-per-hour");
    // 한 시간이 지나면 다시 셉니다.
    clock.now = 131_000 + 60 * 60_000 + 1;
    engine.evaluate();
    expect(firings[2]?.outcome).toBe("notified");
  });

  it("isolates only while the deployment has no isolated pod", () => {
    const { outliers, cluster, firings, run } = setup([
      rule({
        name: "slow-isolate",
        when: [
          {
            signal: "outlier",
            metric: "http.requests.duration_p99_ms",
            forMs: 10_000,
          },
        ],
        action: { kind: "isolate" },
      }),
    ]);
    cluster.pods.set(
      summary("orders-old", {
        isolation: { labels: { app: "orders" }, deployment: "orders" },
      }),
    );
    outliers.set("orders-1", [
      {
        metric: "http.requests.duration_p99_ms",
        value: 1003,
        peerMedian: 31,
        peers: 2,
        since: 0,
      },
    ]);
    run(11);
    expect(firings[0]).toMatchObject({
      action: "isolate-pod",
      outcome: "skipped",
      skipReason: "isolated-limit",
      conditions: [{ value: 1003, peerMedian: 31 }],
    });
  });

  it("does not look at terminating, isolated or other deployments' pods", () => {
    const { statuses, cluster, firings, run, engine } = setup([rule()]);
    cluster.pods.set(summary("orders-1", { terminating: true }));
    cluster.pods.set(
      summary("orders-2", { isolation: { labels: {}, deployment: "orders" } }),
    );
    statuses.set("orders-1", "stalled");
    statuses.set("orders-2", "stalled");
    run(30);
    expect(firings).toEqual([]);
    expect(engine.view().rules[0]?.state.matching).toEqual([]);
  });

  it("lets only one rule fire per deployment in one evaluation", () => {
    const { statuses, firings, run } = setup([
      rule({ name: "first" }),
      rule({ name: "second" }),
    ]);
    statuses.set("orders-1", "stalled");
    run(31);
    expect(firings.map((firing) => firing.rule)).toEqual(["first"]);
    run(1);
    expect(firings.map((firing) => firing.rule)).toEqual(["first", "second"]);
  });

  it("waits while a rule action runs on the same deployment", async () => {
    const { statuses, firings, calls, pending, run } = setup([
      rule({ name: "first", mode: "auto" }),
      rule({ name: "second" }),
    ]);
    statuses.set("orders-1", "stalled");
    run(35);
    expect(calls).toHaveLength(1);
    expect(firings).toEqual([]);
    // 끝나면 다음 주기에 뒤 규칙이 발동합니다.
    pending[0]?.({});
    return vi.waitFor(() => {
      run(1);
      expect(firings.map((firing) => firing.rule)).toEqual(["first", "second"]);
    });
  });

  describe("scale", () => {
    const scaleRule = rule({
      name: "queue-scale",
      mode: "auto",
      when: [
        {
          signal: "metric",
          metric: "app.queue.length",
          compare: "above",
          threshold: 50,
          forMs: 0,
        },
      ],
      action: { kind: "scale", by: 1, max: 4 },
    });

    function withQueue(context: ReturnType<typeof setup>) {
      context.apps.set(
        "orders-2",
        appState({
          values: new Map([
            [
              "app.queue.length",
              {
                kind: "gauge",
                value: 80,
                ts: 0,
                receivedAt: Number.MAX_SAFE_INTEGER,
              },
            ],
          ]),
        }),
      );
      return context;
    }

    it("adds by to the desired replicas of the deployment", () => {
      const { calls, run } = withQueue(setup([scaleRule]));
      run(1);
      expect(calls[0]?.request).toEqual({
        action: "scale-deployment",
        target: { namespace: "shop", name: "orders" },
        expectedUid: "dep-orders",
        replicas: 4,
      });
    });

    it("skips at the limit and when an HPA owns the deployment", () => {
      const context = withQueue(setup([{ ...scaleRule, mode: "notify" }]));
      context.cluster.deployments.set({
        namespace: "shop",
        name: "orders",
        uid: "dep-orders",
        desired: 4,
        ready: 4,
        available: 4,
      });
      context.run(1);
      expect(context.firings[0]).toMatchObject({
        outcome: "skipped",
        skipReason: "at-limit",
        scale: { from: 4, to: 4 },
        target: { kind: "deployment", name: "orders", uid: "dep-orders" },
        pod: pod("orders-2"),
      });

      const hpa = withQueue(setup([{ ...scaleRule, mode: "notify" }]));
      hpa.cluster.hpas.set({
        namespace: "shop",
        name: "orders",
        uid: "hpa-1",
        target: "orders",
        minReplicas: 3,
        maxReplicas: 5,
      });
      hpa.run(1);
      expect(hpa.firings[0]).toMatchObject({
        skipReason: "hpa",
        scale: { from: 3, to: 4 },
      });
      expect(hpa.engine.view().rules[0]?.notes).toEqual(["hpa"]);
    });

    it("skips when the deployment is not in the cluster", () => {
      const context = withQueue(setup([scaleRule]));
      context.cluster.deployments.delete("shop", "orders");
      context.run(1);
      expect(context.firings[0]?.skipReason).toBe("no-deployment");
      expect(context.engine.view().rules[0]?.notes).toEqual([
        "deployment-not-found",
      ]);
    });
  });

  it("ignores rules that are off", () => {
    const { statuses, firings, run, engine } = setup([rule({ mode: "off" })]);
    statuses.set("orders-1", "stalled");
    run(60);
    expect(firings).toEqual([]);
    expect(engine.view().rules[0]?.state).toEqual({
      matching: [],
      firedLastHour: 0,
    });
  });

  it("keeps state by name when the rules file changes", () => {
    const { statuses, firings, run, source, engine } = setup([rule()]);
    statuses.set("orders-1", "stalled");
    run(31);
    expect(firings).toHaveLength(1);
    // 모드만 바꾸면 쉬는 시간이 남아 바로 다시 발동하지 않습니다.
    source.rules = [rule({ mode: "auto" })];
    source.version = 2;
    run(5);
    expect(firings).toHaveLength(1);
    expect(engine.view().rules[0]?.state.coolingUntil).toBe(731_000);
    // 조건을 바꾸면 조건 시각을 처음부터 셉니다.
    source.rules = [
      rule({
        mode: "auto",
        when: [{ signal: "status", statuses: ["stalled"], forMs: 20_000 }],
      }),
    ];
    source.version = 3;
    run(1);
    expect(engine.view().rules[0]?.state.matching[0]?.since).toBe(137_000);
  });

  it("notes namespaces that are not watched or have actions off", () => {
    const { engine } = setup([
      rule({ target: { namespace: "pay", deployment: "api" } }),
      rule({ name: "auto", mode: "auto" }),
    ]);
    const view = engine.view();
    expect(view.rules[0]?.notes).toEqual(["namespace-not-watched"]);
    expect(view.rules[1]?.notes).toEqual([]);

    const off = setup([rule({ mode: "auto" })]);
    (
      off.engine as unknown as { options: { actionNamespaces: string[] } }
    ).options.actionNamespaces = [];
    expect(off.engine.view().rules[0]?.notes).toEqual(["actions-disabled"]);
  });
});
