import { describe, expect, it } from "vitest";
import { isolationPatch, planIsolation, readIsolation } from "./isolation.js";
import type { PlanInput } from "./isolation.js";

const DEMO_LABELS = { app: "demo-app", "pod-template-hash": "7c9f8b6d5" };
const DEMO_REPLICA_SET: PlanInput["replicaSet"] = {
  name: "demo-app-7c9f8b6d5",
  deployment: "demo-app",
  matchLabels: DEMO_LABELS,
};

describe("readIsolation", () => {
  it("reads the marker label and annotations", () => {
    expect(
      readIsolation({
        labels: { "glasspod/isolated": "true", "pod-template-hash": "7c9" },
        annotations: {
          "glasspod/isolated-at": "2026-11-23T04:13:20.000Z",
          "glasspod/isolated-labels": '{"app":"demo-app"}',
          "glasspod/isolated-status": "stalled",
          "glasspod/isolated-deployment": "demo-app",
          "glasspod/isolated-replicaset": "demo-app-7c9",
          "glasspod/isolated-by": "rule:queue-too-long",
          "glasspod/isolated-outliers":
            '["http.requests.duration_p99_ms","event:error"]',
        },
      }),
    ).toEqual({
      at: Date.parse("2026-11-23T04:13:20.000Z"),
      labels: { app: "demo-app" },
      status: "stalled",
      deployment: "demo-app",
      replicaSet: "demo-app-7c9",
      actor: { kind: "rule", name: "queue-too-long" },
      outliers: ["http.requests.duration_p99_ms", "event:error"],
    });
  });

  it("ignores an outliers annotation that is not a list of names", () => {
    for (const text of ["{", '"x"', "[]", "[1]"]) {
      expect(
        readIsolation({
          labels: { "glasspod/isolated": "true" },
          annotations: { "glasspod/isolated-outliers": text },
        })?.outliers,
      ).toBeUndefined();
    }
  });

  it("is undefined without the marker label", () => {
    expect(readIsolation(undefined)).toBeUndefined();
    expect(readIsolation({ labels: { app: "demo-app" } })).toBeUndefined();
    expect(
      readIsolation({ labels: { "glasspod/isolated": "false" } }),
    ).toBeUndefined();
  });

  it("drops broken annotations one by one", () => {
    expect(
      readIsolation({
        labels: { "glasspod/isolated": "true" },
        annotations: {
          "glasspod/isolated-at": "yesterday",
          "glasspod/isolated-labels": '{"app":"demo-app","n":1',
          "glasspod/isolated-status": "sleepy",
          "glasspod/isolated-deployment": "",
          "glasspod/isolated-by": "rule:",
        },
      }),
    ).toEqual({ labels: {} });
    expect(
      readIsolation({
        labels: { "glasspod/isolated": "true" },
        annotations: {
          "glasspod/isolated-labels": '{"app":"demo-app","n":1}',
          "glasspod/isolated-by": "user",
        },
      }),
    ).toEqual({ labels: { app: "demo-app" }, actor: { kind: "user" } });
  });
});

describe("planIsolation", () => {
  it("removes the label the Service and ReplicaSet share (demo app)", () => {
    expect(
      planIsolation({
        podLabels: DEMO_LABELS,
        replicaSet: DEMO_REPLICA_SET,
        services: [
          { name: "demo-app", selector: { app: "demo-app" } },
          { name: "payments", selector: { app: "payments" } },
          { name: "manual" },
        ],
      }),
    ).toEqual({
      ok: true,
      plan: {
        labels: { app: "demo-app" },
        services: ["demo-app"],
        replicaSet: "demo-app-7c9f8b6d5",
        deployment: "demo-app",
      },
    });
  });

  it("covers every Service and the ReplicaSet with as few labels as it can", () => {
    const podLabels = {
      app: "shop",
      tier: "web",
      version: "v2",
      "pod-template-hash": "abc",
    };
    // web은 app·tier를 함께 고르므로 이미 뗀 app으로 빠집니다. canary는 ReplicaSet과 함께 쓰는 키가 없어 version을 뗍니다.
    expect(
      planIsolation({
        podLabels,
        replicaSet: {
          name: "shop-abc",
          matchLabels: { app: "shop", "pod-template-hash": "abc" },
        },
        services: [
          { name: "web", selector: { tier: "web", app: "shop" } },
          { name: "canary", selector: { version: "v2" } },
          { name: "api", selector: { app: "shop" } },
        ],
      }),
    ).toEqual({
      ok: true,
      plan: {
        labels: { app: "shop", version: "v2" },
        services: ["api", "canary", "web"],
        replicaSet: "shop-abc",
      },
    });
  });

  it("also removes a ReplicaSet key when no Service key is shared", () => {
    expect(
      planIsolation({
        podLabels: { ...DEMO_LABELS, tier: "web" },
        replicaSet: DEMO_REPLICA_SET,
        services: [{ name: "web", selector: { tier: "web" } }],
      }),
    ).toMatchObject({
      ok: true,
      plan: { labels: { app: "demo-app", tier: "web" } },
    });
    // app이 없으면 pod-template-hash를 뗍니다.
    expect(
      planIsolation({
        podLabels: { "pod-template-hash": "abc", tier: "web" },
        replicaSet: {
          name: "rs",
          matchLabels: { "pod-template-hash": "abc" },
        },
        services: [{ name: "web", selector: { tier: "web" } }],
      }),
    ).toMatchObject({
      ok: true,
      plan: { labels: { "pod-template-hash": "abc", tier: "web" } },
    });
  });

  it("allows a pod without a controller", () => {
    expect(
      planIsolation({
        podLabels: { app: "debug" },
        replicaSet: undefined,
        services: [{ name: "debug", selector: { app: "debug" } }],
      }),
    ).toEqual({
      ok: true,
      plan: { labels: { app: "debug" }, services: ["debug"] },
    });
  });

  it("refuses a pod no Service selects, and a ReplicaSet without matchLabels", () => {
    expect(
      planIsolation({
        podLabels: DEMO_LABELS,
        replicaSet: DEMO_REPLICA_SET,
        services: [
          { name: "other", selector: { app: "other" } },
          { name: "empty", selector: {} },
        ],
      }),
    ).toEqual({ ok: false, detail: "no service selects this pod" });
    expect(
      planIsolation({
        podLabels: { app: "demo-app", tier: "web" },
        replicaSet: { name: "rs" },
        services: [{ name: "web", selector: { tier: "web" } }],
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("isolationPatch", () => {
  it("nulls removed labels and adds the marker and annotations", () => {
    expect(
      isolationPatch({
        resourceVersion: "77",
        plan: {
          labels: { app: "demo-app" },
          services: ["demo-app"],
        },
        at: Date.parse("2026-11-23T04:13:20.000Z"),
        status: undefined,
        actor: { kind: "user" },
      }),
    ).toEqual({
      metadata: {
        resourceVersion: "77",
        labels: { app: null, "glasspod/isolated": "true" },
        annotations: {
          "glasspod/isolated-at": "2026-11-23T04:13:20.000Z",
          "glasspod/isolated-labels": '{"app":"demo-app"}',
          "glasspod/isolated-by": "user",
        },
      },
    });
  });

  it("keeps the outlier names of the moment as a JSON list", () => {
    const patch = isolationPatch({
      resourceVersion: "77",
      plan: { labels: { app: "demo-app" }, services: ["demo-app"] },
      at: 0,
      status: "ok",
      actor: { kind: "rule", name: "slow-pod-isolate" },
      outliers: ["http.requests.duration_p99_ms", "event:error"],
    }) as { metadata: { annotations: Record<string, string> } };
    expect(patch.metadata.annotations).toMatchObject({
      "glasspod/isolated-by": "rule:slow-pod-isolate",
      "glasspod/isolated-outliers":
        '["http.requests.duration_p99_ms","event:error"]',
    });
    const none = isolationPatch({
      resourceVersion: "77",
      plan: { labels: { app: "demo-app" }, services: ["demo-app"] },
      at: 0,
      status: "ok",
      actor: { kind: "user" },
      outliers: [],
    }) as { metadata: { annotations: Record<string, string> } };
    expect(none.metadata.annotations).not.toHaveProperty(
      "glasspod/isolated-outliers",
    );
  });
});
