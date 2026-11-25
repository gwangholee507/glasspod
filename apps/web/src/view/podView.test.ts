import type {
  ActionItem,
  DeploymentItem,
  PodItem,
  PodOutlier,
  PodSeverity,
  PodStatus,
  PodStatusChange,
} from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import {
  ISOLATED_GROUP_KEY,
  TIMELINE_WINDOW_MS,
  attentionSeverity,
  attentionTone,
  filterPods,
  groupPods,
  needsAttention,
  mergeOverviewTimeline,
  isNamespaceName,
  mergeStatusChanges,
  summarizeDeployments,
} from "./podView.js";

const SEVERITY: Record<PodStatus, PodSeverity> = {
  terminated: "none",
  "pod-failing": "critical",
  stalled: "critical",
  disconnected: "critical",
  restarted: "warning",
  "not-ready": "warning",
  starting: "none",
  "no-sdk": "none",
  ok: "none",
};

function pod(
  name: string,
  status: PodStatus = "ok",
  // null이면 Deployment가 없는 Pod입니다.
  deployment: string | null = "web",
  namespace = "shop",
): PodItem {
  return {
    pod: { namespace, name },
    ...(deployment === null ? {} : { deployment }),
    status,
    severity: SEVERITY[status],
    since: 1,
    metrics: {},
  };
}

function names(items: readonly PodItem[]): string[] {
  return items.map((item) => item.pod.name);
}

describe("isNamespaceName", () => {
  it("DNS-1123 label만", () => {
    expect(isNamespaceName("glasspod-demo")).toBe(true);
    expect(isNamespaceName("a")).toBe(true);
    expect(isNamespaceName("Bad_Name")).toBe(false);
    expect(isNamespaceName("-demo")).toBe(false);
    expect(isNamespaceName("")).toBe(false);
    expect(isNamespaceName("a".repeat(63))).toBe(true);
    expect(isNamespaceName("a".repeat(64))).toBe(false);
  });
});

describe("filterPods", () => {
  it("이름에 들어 있는 글자, 대소문자 무시, 앞뒤 공백 뺌", () => {
    const pods = [pod("demo-app-1"), pod("demo-load-1"), pod("Other")];
    expect(names(filterPods(pods, " LOAD "))).toEqual(["demo-load-1"]);
    expect(names(filterPods(pods, "other"))).toEqual(["Other"]);
    expect(names(filterPods(pods, "  "))).toEqual([
      "demo-app-1",
      "demo-load-1",
      "Other",
    ]);
  });
});

describe("groupPods", () => {
  const pods = [
    pod("e-ok"),
    pod("a-ok"),
    pod("r-restarted", "restarted"),
    pod("n-not-ready", "not-ready"),
    pod("s-stalled", "stalled"),
    pod("d-disconnected", "disconnected"),
    pod("l-load", "no-sdk", "load"),
    pod("t-term", "terminated"),
    pod("c-start", "starting"),
  ];

  it("전체: '지금 볼 것'(위험 먼저, 판단 표 순서) 뒤에 정상 → 시작 중 → SDK 없음 → 종료됨", () => {
    const groups = groupPods(pods, "all");
    expect(groups.map((group) => group.title)).toEqual([
      "지금 볼 것",
      "정상",
      "시작 중",
      "SDK 없음",
      "종료됨",
    ]);
    expect(names(groups[0]!.pods)).toEqual([
      "s-stalled",
      "d-disconnected",
      "r-restarted",
      "n-not-ready",
    ]);
    expect(names(groups[1]!.pods)).toEqual(["a-ok", "e-ok"]);
    expect(groups.map((group) => group.tone)).toEqual([
      "critical",
      "ok",
      "neutral",
      "neutral",
      "neutral",
    ]);
  });

  it("빈 묶음은 감춤", () => {
    expect(groupPods([pod("a")], "all").map((group) => group.title)).toEqual([
      "정상",
    ]);
    expect(groupPods([], "all")).toEqual([]);
  });

  it("문제: '지금 볼 것'만, 없으면 빈 배열", () => {
    expect(groupPods(pods, "problems").map((group) => group.title)).toEqual([
      "지금 볼 것",
    ]);
    expect(groupPods([pod("a")], "problems")).toEqual([]);
  });

  it("Deployment별: 이름순, Deployment 없는 Pod는 맨 뒤, 안은 위험 먼저", () => {
    const groups = groupPods(
      [
        pod("w-ok", "ok", "web"),
        pod("w-stalled", "stalled", "web"),
        pod("loose", "ok", null),
        pod("a-ok", "ok", "api"),
      ],
      "deployments",
    );
    expect(groups.map((group) => group.title)).toEqual([
      "api",
      "web",
      "Deployment 없음",
    ]);
    expect(names(groups[1]!.pods)).toEqual(["w-stalled", "w-ok"]);
    expect(groups.map((group) => group.tone)).toEqual(["ok", "critical", "ok"]);
  });

  it("Deployment별에서 namespace를 함께 보면 묶음 이름에 붙임", () => {
    const groups = groupPods(
      [pod("a", "ok", "web", "b-ns"), pod("b", "ok", "web", "a-ns")],
      "deployments",
      true,
    );
    expect(groups.map((group) => group.title)).toEqual([
      "a-ns / web",
      "b-ns / web",
    ]);
  });
});

// 트래픽에서 뺀 Pod입니다. ReplicaSet이 놓아주어 Deployment가 없습니다.
function isolatedPod(name: string, status: PodStatus = "stalled"): PodItem {
  return {
    ...pod(name, status, null),
    kube: {
      uid: `uid-${name}`,
      phase: "Running",
      ready: true,
      terminating: false,
      restarts: 0,
      isolation: { labels: { app: "web" }, deployment: "web" },
    },
  };
}

describe("groupPods with isolated pods", () => {
  const pods = [
    pod("w-ok"),
    pod("w-stalled", "stalled"),
    isolatedPod("z-out", "stalled"),
    isolatedPod("b-out", "ok"),
  ];

  it("keeps isolated pods out of '지금 볼 것' and puts them last", () => {
    const groups = groupPods(pods, "all");
    expect(groups.map((group) => group.title)).toEqual([
      "지금 볼 것",
      "정상",
      "격리됨",
    ]);
    expect(names(groups[0]!.pods)).toEqual(["w-stalled"]);
    expect(names(groups[2]!.pods)).toEqual(["b-out", "z-out"]);
    expect(groups[2]!.key).toBe(ISOLATED_GROUP_KEY);
  });

  it("leaves them out of the problems tab and keeps them last by deployment", () => {
    expect(
      groupPods(pods, "problems").flatMap((group) => names(group.pods)),
    ).toEqual(["w-stalled"]);
    expect(groupPods(pods, "deployments").map((group) => group.title)).toEqual([
      "web",
      "격리됨",
    ]);
    expect(needsAttention(isolatedPod("x"))).toBe(false);
  });

  it("leaves them out of the deployment summary", () => {
    expect(
      summarizeDeployments([], [pod("w1"), isolatedPod("x")]).map(
        (summary) => summary.segments.length,
      ),
    ).toEqual([1]);
  });
});

// 같은 Deployment의 다른 Pod보다 요청 p99가 높은 Pod입니다(docs/guides/T34.md).
function outlierPod(
  name: string,
  status: PodStatus = "ok",
  deployment: string | null = "web",
): PodItem {
  const outlier: PodOutlier = {
    metric: "http.requests.duration_p99_ms",
    value: 1003,
    peerMedian: 31,
    peers: 2,
    since: 1,
  };
  return { ...pod(name, status, deployment), outliers: [outlier] };
}

describe("pods with outliers", () => {
  it("다른 Pod보다 높은 값이 있으면 판단 강조가 없어도 주의", () => {
    expect(attentionSeverity(outlierPod("o"))).toBe("warning");
    expect(attentionTone(outlierPod("o"))).toBe("warning");
    expect(needsAttention(outlierPod("o"))).toBe(true);
    // 판단의 강조가 더 세면 그대로입니다.
    expect(attentionSeverity(outlierPod("s", "stalled"))).toBe("critical");
    expect(attentionTone(outlierPod("s", "stalled"))).toBe("critical");
    // 빈 배열은 없는 것과 같습니다.
    expect(needsAttention({ ...pod("a"), outliers: [] })).toBe(false);
    expect(attentionTone(pod("a"))).toBe("ok");
    // 격리된 Pod는 강조하지 않습니다.
    expect(attentionSeverity({ ...isolatedPod("i", "ok"), outliers: [] })).toBe(
      "none",
    );
  });

  it("'지금 볼 것'에 주의로 들어가 위험 뒤, 같은 주의 안에서는 판단 표 순서", () => {
    const groups = groupPods(
      [
        pod("a-ok"),
        outlierPod("o-ok"),
        pod("r-restarted", "restarted"),
        pod("s-stalled", "stalled"),
      ],
      "all",
    );
    expect(groups.map((group) => group.title)).toEqual(["지금 볼 것", "정상"]);
    expect(names(groups[0]!.pods)).toEqual([
      "s-stalled",
      "r-restarted",
      "o-ok",
    ]);
    expect(names(groups[1]!.pods)).toEqual(["a-ok"]);
    expect(names(groupPods([outlierPod("o-ok")], "problems")[0]!.pods)).toEqual(
      ["o-ok"],
    );
  });

  it("Deployment별 묶음의 점은 주의 색", () => {
    const groups = groupPods(
      [pod("w-ok"), outlierPod("w-slow")],
      "deployments",
    );
    expect(groups.map((group) => group.tone)).toEqual(["warning"]);
    expect(names(groups[0]!.pods)).toEqual(["w-slow", "w-ok"]);
  });
});

describe("summarizeDeployments", () => {
  const deployments: DeploymentItem[] = [
    {
      namespace: "shop",
      name: "web",
      uid: "web",
      desired: 3,
      ready: 2,
      available: 2,
    },
    {
      namespace: "shop",
      name: "load",
      uid: "load",
      desired: 1,
      ready: 1,
      available: 1,
    },
    {
      namespace: "shop",
      name: "idle",
      uid: "idle",
      desired: 0,
      ready: 0,
      available: 0,
    },
  ];

  it("Pod마다 한 칸(위험 → 주의 → 정상 → 그 밖), 0이 아닌 판단별 수", () => {
    const summaries = summarizeDeployments(deployments, [
      pod("w1", "ok", "web"),
      pod("w2", "restarted", "web"),
      pod("w3", "stalled", "web"),
      pod("l1", "no-sdk", "load"),
    ]);
    expect(summaries.map((summary) => summary.name)).toEqual([
      "idle",
      "load",
      "web",
    ]);
    const web = summaries[2]!;
    expect(web.kube?.ready).toBe(2);
    expect(web.segments).toEqual(["critical", "warning", "ok"]);
    expect(web.counts).toEqual([
      { label: "위험", tone: "critical", count: 1 },
      { label: "주의", tone: "warning", count: 1 },
      { label: "정상", tone: "ok", count: 1 },
    ]);
    expect(summaries[1]!.counts).toEqual([
      { label: "SDK 없음", tone: "neutral", count: 1 },
    ]);
    expect(summaries[0]!.segments).toEqual([]);
  });

  it("쿠버네티스 요약이 없는 Deployment와 Deployment 없는 Pod는 뒤에", () => {
    const summaries = summarizeDeployments(
      [],
      [pod("x", "ok", null), pod("g", "terminated", "gone")],
    );
    expect(summaries.map((summary) => summary.name ?? null)).toEqual([
      "gone",
      null,
    ]);
    expect(summaries[0]!.kube).toBeUndefined();
    expect(summaries[0]!.counts).toEqual([
      { label: "종료됨", tone: "neutral", count: 1 },
    ]);
  });
});

describe("mergeStatusChanges", () => {
  const NOW = 100_000_000;

  function change(
    name: string,
    at: number,
    status: PodStatus = "ok",
  ): PodStatusChange {
    return {
      pod: { namespace: "shop", name },
      at,
      status,
      severity: SEVERITY[status],
    };
  }

  it("같은 기록은 하나로, 늦은 것부터", () => {
    const fetched = [change("a", NOW - 3_000), change("b", NOW - 2_000)];
    const streamed = [
      change("b", NOW - 2_000),
      change("a", NOW - 1_000, "stalled"),
    ];
    const { changes, truncated } = mergeStatusChanges([fetched, streamed], NOW);
    expect(changes.map((item) => [item.pod.name, item.at])).toEqual([
      ["a", NOW - 1_000],
      ["b", NOW - 2_000],
      ["a", NOW - 3_000],
    ]);
    expect(truncated).toBe(false);
  });

  it("서버 시계로 30분이 지난 것은 뺌", () => {
    const { changes } = mergeStatusChanges(
      [
        [
          change("old", NOW - TIMELINE_WINDOW_MS - 1),
          change("edge", NOW - TIMELINE_WINDOW_MS),
        ],
      ],
      NOW,
    );
    expect(changes.map((item) => item.pod.name)).toEqual(["edge"]);
  });

  it("limit건까지, 넘으면 truncated", () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      change(`p${index}`, NOW - index * 1_000),
    );
    const { changes, truncated } = mergeStatusChanges([many], NOW, 3);
    expect(changes.map((item) => item.pod.name)).toEqual(["p0", "p1", "p2"]);
    expect(truncated).toBe(true);
  });
});

describe("mergeOverviewTimeline", () => {
  const NOW = 100_000_000;
  const change: PodStatusChange = {
    pod: { namespace: "shop", name: "a" },
    at: NOW - 2_000,
    status: "stalled",
    severity: "critical",
  };
  function action(id: string, requestedAt: number): ActionItem {
    return {
      id,
      action: "restart-pod",
      target: { kind: "pod", namespace: "shop", name: "a", uid: "u" },
      actor: { kind: "user" },
      requestedAt,
      finishedAt: requestedAt + 100,
      result: "succeeded",
    };
  }

  it("조치와 판단 변화를 늦은 것부터 섞고, 같은 시각이면 조치가 먼저, 30분 밖은 뺌", () => {
    const { entries, truncated } = mergeOverviewTimeline(
      [
        [change],
        [{ ...change, at: NOW - 1_000, status: "ok", severity: "none" }],
      ],
      [
        action("x", NOW - 1_000),
        action("old", NOW - TIMELINE_WINDOW_MS - 1),
        action("y", NOW - 3_000),
      ],
      NOW,
    );
    expect(
      entries.map((entry) =>
        entry.kind === "action"
          ? `action:${entry.action.id}`
          : `status:${entry.change.status}`,
      ),
    ).toEqual(["action:x", "status:ok", "status:stalled", "action:y"]);
    expect(truncated).toBe(false);
  });

  it("limit줄까지", () => {
    const { entries, truncated } = mergeOverviewTimeline(
      [[change]],
      [action("x", NOW - 1_000), action("y", NOW - 3_000)],
      NOW,
      2,
    );
    expect(entries).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});
