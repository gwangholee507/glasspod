import type { ActionItem, PodItem, PodListChanges } from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import {
  MAX_STREAM_ACTIONS,
  MAX_STREAM_STATUS_CHANGES,
  applyPodChanges,
  applyPodList,
  reopenDelayMs,
} from "./podStream.js";
import type { PodStreamState } from "./podStream.js";

function pod(name: string, status: PodItem["status"] = "ok"): PodItem {
  return {
    pod: { namespace: "shop", name },
    status,
    severity: "none",
    since: 1,
    metrics: {},
  };
}

function changes(fields: Partial<PodListChanges>): PodListChanges {
  return {
    serverTime: 2,
    pods: [],
    removedPods: [],
    deployments: [],
    removedDeployments: [],
    statusChanges: [],
    actions: [],
    ...fields,
  };
}

const STATE: PodStreamState = {
  list: {
    serverTime: 1,
    namespaces: ["shop"],
    actionNamespaces: ["shop"],
    deployments: [
      { namespace: "shop", name: "orders", desired: 2, ready: 2, available: 2 },
    ],
    pods: [pod("orders-1"), pod("orders-3")],
  },
  statusChanges: [],
  actions: [],
};

function action(id: string): ActionItem {
  return {
    id,
    action: "restart-pod",
    target: { kind: "pod", namespace: "shop", name: "orders-1", uid: "u" },
    actor: { kind: "user" },
    requestedAt: 1,
    finishedAt: 2,
    result: "succeeded",
  };
}

describe("applyPodChanges", () => {
  it("replaces, adds and removes pods in name order", () => {
    const next = applyPodChanges(
      STATE,
      changes({
        pods: [pod("orders-3", "stalled"), pod("orders-2")],
        removedPods: [{ namespace: "shop", name: "orders-1" }],
      }),
    );
    expect(next.list.pods.map((item) => [item.pod.name, item.status])).toEqual([
      ["orders-2", "ok"],
      ["orders-3", "stalled"],
    ]);
    expect(next.list.serverTime).toBe(2);
    // 바뀌지 않은 부분은 같은 배열입니다.
    expect(next.list.deployments).toBe(STATE.list.deployments);
    expect(next.statusChanges).toBe(STATE.statusChanges);
    expect(STATE.list.pods).toHaveLength(2);
  });

  it("updates deployments, namespaces and keeps recent status changes", () => {
    const change = {
      pod: { namespace: "shop", name: "orders-1" },
      at: 2,
      status: "stalled" as const,
      severity: "critical" as const,
      previous: "ok" as const,
    };
    const many: PodStreamState = {
      ...STATE,
      statusChanges: Array.from(
        { length: MAX_STREAM_STATUS_CHANGES },
        (_, index) => ({ ...change, at: -index }),
      ),
    };
    const next = applyPodChanges(
      many,
      changes({
        deployments: [
          {
            namespace: "shop",
            name: "orders",
            desired: 3,
            ready: 2,
            available: 2,
          },
        ],
        namespaces: ["shop", "pay"],
        statusChanges: [change],
      }),
    );
    expect(next.list.deployments).toMatchObject([{ desired: 3 }]);
    expect(next.list.namespaces).toEqual(["shop", "pay"]);
    expect(next.statusChanges).toHaveLength(MAX_STREAM_STATUS_CHANGES);
    expect(next.statusChanges.at(-1)).toBe(change);
  });

  it("keeps recent actions in the order received", () => {
    const next = applyPodChanges(STATE, changes({ actions: [action("a")] }));
    expect(next.actions.map((item) => item.id)).toEqual(["a"]);
    expect(applyPodChanges(next, changes({})).actions).toBe(next.actions);
    const full: PodStreamState = {
      ...STATE,
      actions: Array.from({ length: MAX_STREAM_ACTIONS }, (_, index) =>
        action(`old-${index}`),
      ),
    };
    const last = applyPodChanges(full, changes({ actions: [action("new")] }));
    expect(last.actions).toHaveLength(MAX_STREAM_ACTIONS);
    expect(last.actions[0]?.id).toBe("old-1");
    expect(last.actions.at(-1)?.id).toBe("new");
  });
});

describe("applyPodList", () => {
  it("starts over with the new list and no status changes after a reconnect", () => {
    const list = { ...STATE.list, pods: [] };
    expect(applyPodList(list)).toEqual({
      list,
      statusChanges: [],
      actions: [],
    });
  });
});

describe("reopenDelayMs", () => {
  it("waits 3 seconds and doubles up to 30 seconds", () => {
    expect([1, 2, 3, 4, 5, 10].map(reopenDelayMs)).toEqual([
      3_000, 6_000, 12_000, 24_000, 30_000, 30_000,
    ]);
  });
});
