// 목록과 한눈에 보기의 묶기·정렬·요약을 하는 순수 함수입니다(docs/guides/T18.md 결정 6~10, 17, 18).
// 트래픽에서 뺀(격리된) Pod는 판단 묶음과 Deployment 요약에서 빼고 맨 아래 '격리됨' 묶음에 둡니다(docs/guides/T23.md 결정 4, 19).
import type {
  ActionItem,
  DeploymentItem,
  PodItem,
  PodSeverity,
  PodStatus,
  PodStatusChange,
} from "@glasspod/protocol";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  severityRank,
  statusTone,
} from "./podText.js";
import type { Tone } from "./podText.js";

// 쿠버네티스 namespace 이름 규칙(DNS-1123 label)입니다. 서버(apps/server/src/config.ts)와 같습니다.
const NAMESPACE_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_NAMESPACE_LENGTH = 63;

export function isNamespaceName(value: string): boolean {
  return value.length <= MAX_NAMESPACE_LENGTH && NAMESPACE_PATTERN.test(value);
}

// 트래픽에서 뺀(격리된) Pod입니다. 표시 라벨이 있는 Pod입니다(docs/guides/T23.md 결정 12).
export function isIsolated(item: PodItem | undefined): boolean {
  return item?.kube?.isolation !== undefined;
}

// 같은 Deployment의 다른 Pod보다 높은 값이 있는 Pod입니다(docs/guides/T34.md).
export function hasOutliers(item: PodItem): boolean {
  return (item.outliers?.length ?? 0) > 0;
}

// 목록에서 강조할 수준입니다. 판단의 강조가 없어도 다른 Pod보다 높은 값이 있으면 주의입니다(T34 결정 15).
// 일부러 뺀(격리된) Pod는 강조하지 않습니다.
export function attentionSeverity(item: PodItem): PodSeverity {
  if (isIsolated(item)) {
    return "none";
  }
  if (item.severity === "none" && hasOutliers(item)) {
    return "warning";
  }
  return item.severity;
}

// 항목의 강조 색입니다. 판단의 색에 강조가 없으면 다른 Pod보다 높은 값이 있을 때 주의 색입니다.
export function attentionTone(item: PodItem): Tone {
  const tone = statusTone(item.status);
  return (tone === "ok" || tone === "neutral") &&
    attentionSeverity(item) === "warning"
    ? "warning"
    : tone;
}

// '지금 볼 것'에 들어가는 Pod입니다(위험, 주의, 다른 Pod보다 높은 값). 일부러 뺀 Pod는 넣지 않습니다.
export function needsAttention(item: PodItem): boolean {
  return attentionSeverity(item) !== "none";
}

function compareNames(a: PodItem, b: PodItem): number {
  if (a.pod.namespace !== b.pod.namespace) {
    return a.pod.namespace < b.pod.namespace ? -1 : 1;
  }
  return a.pod.name < b.pod.name ? -1 : a.pod.name > b.pod.name ? 1 : 0;
}

// 위험 먼저, 같은 강조는 판단 표의 순서, 그다음 이름순입니다(결정 7). 다른 Pod보다 높은 값은 주의로 봅니다(T34).
export function compareBySeverity(a: PodItem, b: PodItem): number {
  return (
    severityRank(attentionSeverity(a)) - severityRank(attentionSeverity(b)) ||
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    compareNames(a, b)
  );
}

// 이름에 찾는 글자가 들어 있는 Pod만 남깁니다. 대소문자를 무시하고 앞뒤 공백은 뺍니다(결정 10).
export function filterPods(pods: readonly PodItem[], query: string): PodItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...pods];
  }
  return pods.filter((item) => item.pod.name.toLowerCase().includes(needle));
}

export type ListTab = "all" | "problems" | "deployments";

export interface PodGroup {
  key: string;
  title: string;
  // 묶음 이름 앞 점의 색입니다.
  tone: Tone;
  pods: PodItem[];
}

// '지금 볼 것' 아래 묶음의 순서입니다(결정 8). 강조가 없는 판단만 들어갑니다.
const CALM_GROUPS: readonly PodStatus[] = [
  "ok",
  "starting",
  "no-sdk",
  "terminated",
];

const ATTENTION_TITLE = "지금 볼 것";
const NO_DEPLOYMENT_TITLE = "Deployment 없음";
// '격리됨' 묶음의 key입니다. 목록은 이 묶음의 점을 '격리됨' 배지 색으로 그립니다.
export const ISOLATED_GROUP_KEY = "isolated";
const ISOLATED_TITLE = "격리됨";

// 묶음 안에서 가장 강한 강조입니다. Deployment별 묶음의 점 색에 씁니다.
function strongestTone(pods: readonly PodItem[]): Tone {
  const tones = pods.map(attentionTone);
  if (tones.includes("critical")) return "critical";
  if (tones.includes("warning")) return "warning";
  if (tones.includes("ok")) return "ok";
  return "neutral";
}

function attentionGroup(pods: readonly PodItem[]): PodGroup[] {
  const attention = pods.filter(needsAttention).sort(compareBySeverity);
  return attention.length === 0
    ? []
    : [
        {
          key: "attention",
          title: ATTENTION_TITLE,
          tone: "critical",
          pods: attention,
        },
      ];
}

// 탭에 맞게 묶습니다(결정 7~9). 빈 묶음은 돌려주지 않습니다.
// showNamespace는 여러 namespace를 함께 볼 때 Deployment 묶음 이름에 namespace를 붙입니다.
// 격리된 Pod는 '문제' 탭에서 빼고, 다른 탭에서는 맨 아래 '격리됨' 묶음(이름순)에 둡니다.
export function groupPods(
  pods: readonly PodItem[],
  tab: ListTab,
  showNamespace = false,
): PodGroup[] {
  const isolated = pods.filter(isIsolated).sort(compareNames);
  const active = pods.filter((item) => !isIsolated(item));
  if (tab === "problems") {
    return attentionGroup(active);
  }
  const groups = groupActivePods(active, tab, showNamespace);
  if (isolated.length > 0) {
    groups.push({
      key: ISOLATED_GROUP_KEY,
      title: ISOLATED_TITLE,
      tone: "ok",
      pods: isolated,
    });
  }
  return groups;
}

function groupActivePods(
  pods: readonly PodItem[],
  tab: "all" | "deployments",
  showNamespace: boolean,
): PodGroup[] {
  if (tab === "all") {
    const groups = attentionGroup(pods);
    for (const status of CALM_GROUPS) {
      const members = pods
        .filter((item) => !needsAttention(item) && item.status === status)
        .sort(compareNames);
      if (members.length > 0) {
        groups.push({
          key: `status:${status}`,
          title: STATUS_LABEL[status],
          tone: statusTone(status),
          pods: members,
        });
      }
    }
    return groups;
  }

  // Deployment별: Deployment 이름순, Deployment가 없는 Pod는 namespace마다 맨 뒤입니다.
  const byKey = new Map<
    string,
    { namespace: string; deployment?: string; pods: PodItem[] }
  >();
  for (const item of pods) {
    const key = JSON.stringify([item.pod.namespace, item.deployment ?? null]);
    const group = byKey.get(key) ?? {
      namespace: item.pod.namespace,
      ...(item.deployment === undefined ? {} : { deployment: item.deployment }),
      pods: [],
    };
    group.pods.push(item);
    byKey.set(key, group);
  }
  return [...byKey.entries()]
    .sort(([, a], [, b]) => compareDeploymentKeys(a, b))
    .map(([key, group]) => {
      const name = group.deployment ?? NO_DEPLOYMENT_TITLE;
      return {
        key: `deployment:${key}`,
        title: showNamespace ? `${group.namespace} / ${name}` : name,
        tone: strongestTone(group.pods),
        pods: [...group.pods].sort(compareBySeverity),
      };
    });
}

// namespace 순서, 그 안에서 Deployment 이름순, Deployment가 없는 것은 맨 뒤입니다.
function compareDeploymentKeys(
  a: { namespace: string; deployment?: string },
  b: { namespace: string; deployment?: string },
): number {
  if (a.namespace !== b.namespace) {
    return a.namespace < b.namespace ? -1 : 1;
  }
  if (a.deployment === undefined || b.deployment === undefined) {
    return a.deployment === b.deployment
      ? 0
      : a.deployment === undefined
        ? 1
        : -1;
  }
  return a.deployment < b.deployment ? -1 : a.deployment > b.deployment ? 1 : 0;
}

// ── 한눈에 보기: Deployment 요약(결정 17) ──

export interface SummaryCount {
  label: string;
  tone: Tone;
  count: number;
}

export interface DeploymentSummary {
  key: string;
  namespace: string;
  // 없으면 Deployment가 없는 Pod 묶음입니다.
  name?: string;
  // 쿠버네티스 Deployment 요약입니다. 목록에만 있는 Deployment면 없습니다.
  kube?: DeploymentItem;
  // Pod마다 한 칸, 위험 → 주의 → 정상 → 그 밖 순서입니다.
  segments: Tone[];
  // 0이 아닌 판단별 수입니다.
  counts: SummaryCount[];
}

interface Category {
  label: string;
  tone: Tone;
}

// 요약의 판단별 분류 순서입니다. 위험·주의는 강조로, 나머지는 판단 이름으로 셉니다.
const CATEGORIES: readonly Category[] = [
  { label: "위험", tone: "critical" },
  { label: "주의", tone: "warning" },
  { label: STATUS_LABEL.ok, tone: "ok" },
  { label: STATUS_LABEL.starting, tone: "neutral" },
  { label: STATUS_LABEL["no-sdk"], tone: "neutral" },
  { label: STATUS_LABEL.terminated, tone: "neutral" },
];

function categoryIndex(item: PodItem): number {
  if (item.severity === "critical") return 0;
  if (item.severity === "warning") return 1;
  const label = STATUS_LABEL[item.status];
  const index = CATEGORIES.findIndex((category) => category.label === label);
  // 강조 없는 판단은 모두 위 표에 있습니다. 혹시 모르는 값이면 맨 뒤로 셉니다.
  return index === -1 ? CATEGORIES.length - 1 : index;
}

export function summarizeDeployments(
  deployments: readonly DeploymentItem[],
  pods: readonly PodItem[],
): DeploymentSummary[] {
  const summaries = new Map<
    string,
    { namespace: string; name?: string; kube?: DeploymentItem; pods: PodItem[] }
  >();
  const keyOf = (namespace: string, name: string | undefined) =>
    JSON.stringify([namespace, name ?? null]);

  for (const kube of deployments) {
    summaries.set(keyOf(kube.namespace, kube.name), {
      namespace: kube.namespace,
      name: kube.name,
      kube,
      pods: [],
    });
  }
  // 격리된 Pod는 Deployment가 관리하지 않으므로 요약에서 뺍니다(docs/guides/T23.md 결정 13).
  for (const item of pods.filter((pod) => !isIsolated(pod))) {
    const key = keyOf(item.pod.namespace, item.deployment);
    const summary = summaries.get(key) ?? {
      namespace: item.pod.namespace,
      ...(item.deployment === undefined ? {} : { name: item.deployment }),
      pods: [],
    };
    summary.pods.push(item);
    summaries.set(key, summary);
  }

  return [...summaries.entries()]
    .sort(([, a], [, b]) =>
      compareDeploymentKeys(
        {
          namespace: a.namespace,
          ...(a.name === undefined ? {} : { deployment: a.name }),
        },
        {
          namespace: b.namespace,
          ...(b.name === undefined ? {} : { deployment: b.name }),
        },
      ),
    )
    .map(([key, summary]) => {
      const tally = CATEGORIES.map(() => 0);
      for (const item of summary.pods) {
        const index = categoryIndex(item);
        tally[index] = (tally[index] ?? 0) + 1;
      }
      const segments: Tone[] = [];
      const counts: SummaryCount[] = [];
      CATEGORIES.forEach((category, index) => {
        const count = tally[index] ?? 0;
        for (let i = 0; i < count; i += 1) {
          segments.push(category.tone);
        }
        if (count > 0) {
          counts.push({ ...category, count });
        }
      });
      return {
        key,
        namespace: summary.namespace,
        ...(summary.name === undefined ? {} : { name: summary.name }),
        ...(summary.kube === undefined ? {} : { kube: summary.kube }),
        segments,
        counts,
      };
    });
}

// ── 한눈에 보기: 최근 30분 판단 변화(결정 18) ──

export const TIMELINE_WINDOW_MS = 30 * 60 * 1000;
export const TIMELINE_LIMIT = 100;

function changeKey(change: PodStatusChange): string {
  return JSON.stringify([
    change.pod.namespace,
    change.pod.name,
    change.at,
    change.status,
  ]);
}

// GET으로 받은 기록과 스트림으로 받은 기록을 합칩니다. 같은 기록은 하나로, 서버 시계로 30분 안, 늦은 것부터 limit건까지.
export function mergeStatusChanges(
  lists: readonly (readonly PodStatusChange[])[],
  now: number,
  limit: number = TIMELINE_LIMIT,
): { changes: PodStatusChange[]; truncated: boolean } {
  const since = now - TIMELINE_WINDOW_MS;
  const byKey = new Map<string, PodStatusChange>();
  for (const list of lists) {
    for (const change of list) {
      if (change.at >= since) {
        byKey.set(changeKey(change), change);
      }
    }
  }
  const sorted = [...byKey.values()].sort(
    (a, b) =>
      b.at - a.at ||
      (a.pod.namespace < b.pod.namespace
        ? -1
        : a.pod.namespace > b.pod.namespace
          ? 1
          : a.pod.name < b.pod.name
            ? -1
            : a.pod.name > b.pod.name
              ? 1
              : 0),
  );
  return {
    changes: sorted.slice(0, limit),
    truncated: sorted.length > limit,
  };
}

// ── 한눈에 보기: 판단 변화와 조치를 한 줄씩 섞기(docs/guides/T21.md 결정 21) ──

export type OverviewEntry =
  | { kind: "status"; at: number; change: PodStatusChange }
  | { kind: "action"; at: number; action: ActionItem };

// 판단 변화(GET + 스트림)와 조치를 30분 안에서 늦은 것부터 limit줄까지 섞습니다. 같은 시각이면 조치가 먼저입니다.
export function mergeOverviewTimeline(
  changeLists: readonly (readonly PodStatusChange[])[],
  actions: readonly ActionItem[],
  now: number,
  limit: number = TIMELINE_LIMIT,
): { entries: OverviewEntry[]; truncated: boolean } {
  const since = now - TIMELINE_WINDOW_MS;
  const { changes } = mergeStatusChanges(changeLists, now, Infinity);
  const entries: OverviewEntry[] = [
    ...actions
      .filter((action) => action.requestedAt >= since)
      .map((action): OverviewEntry => ({
        kind: "action",
        at: action.requestedAt,
        action,
      })),
    ...changes.map((change): OverviewEntry => ({
      kind: "status",
      at: change.at,
      change,
    })),
  ];
  // 안정 정렬이라 같은 시각이면 조치(앞에 넣음)가 먼저, 판단 변화끼리는 mergeStatusChanges의 순서가 남습니다.
  entries.sort((a, b) => b.at - a.at);
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}
