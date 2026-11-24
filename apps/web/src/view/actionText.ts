// 조치를 화면 글로 바꾸고, 기록을 합치고 거르고, 재시작·트래픽에서 빼기·스케일 조정의 영향을 계산하는 순수 함수입니다
// (docs/guides/T21.md, docs/guides/T23.md, docs/guides/T24.md). 서버의 기록은 코드(error, kubeStatus)이므로
// 문장은 여기서 만듭니다(T21 결정 22, '결과 문장').
import type {
  ActionActor,
  ActionItem,
  ActionKind,
  ActionResult,
  ActionTarget,
  DeploymentHpa,
  DeploymentItem,
  IsolationPlan,
  PodItem,
  PodRef,
  PodStatus,
} from "@glasspod/protocol";
import { NETWORK_ERROR, UNEXPECTED_BODY } from "../api/client.js";
import { STATUS_LABEL, statusTone } from "./podText.js";
import type { Tone } from "./podText.js";
import { isIsolated } from "./podView.js";

export const ACTION_LABEL: Record<ActionKind, string> = {
  "restart-pod": "Pod 재시작",
  "isolate-pod": "트래픽에서 빼기",
  "delete-pod": "Pod 삭제",
  "scale-deployment": "스케일 조정",
};

// 조치 기록 화면의 '조치' 거르기 순서입니다.
export const ACTION_KINDS: readonly ActionKind[] = [
  "restart-pod",
  "isolate-pod",
  "delete-pod",
  "scale-deployment",
];

// Pod가 대상인 조치입니다. 상세 머리줄의 버튼입니다(스케일 조정은 Deployment 카드, docs/guides/T24.md 결정 1).
export type PodActionKind = Exclude<ActionKind, "scale-deployment">;

export const POD_ACTION_KINDS: readonly PodActionKind[] = [
  "restart-pod",
  "isolate-pod",
  "delete-pod",
];

type TargetKind = ActionTarget["kind"];

export const RESULT_LABEL: Record<ActionResult, string> = {
  succeeded: "성공",
  failed: "실패",
};

// 실행 주체입니다. 화면에서 누른 조치는 '개발자', 자동 규칙은 규칙 이름입니다(결정 4).
export function actorLabel(actor: ActionActor): string {
  return actor.kind === "user" ? "개발자" : actor.name;
}

// 오류 코드마다 문장입니다. 서버가 붙이는 코드 말고도 웹(network-error 등)과 프록시의 코드가 올 수 있습니다.
const ERROR_SENTENCE: Record<string, string> = {
  "action-not-allowed":
    "이 namespace는 조치가 꺼져 있습니다(GLASSPOD_ACTION_NAMESPACES).",
  "kube-unavailable": "서버가 쿠버네티스에 연결되어 있지 않습니다.",
  "target-not-found": "Pod가 이미 지워져 있습니다.",
  "target-changed":
    "같은 이름의 다른 Pod로 바뀌었습니다. 목록을 다시 보고 실행합니다.",
  "target-terminating": "Pod가 이미 지워지는 중입니다.",
  "target-isolated": "이미 트래픽에서 뺀 Pod입니다. 격리된 Pod에서 지웁니다.",
  "target-not-isolated":
    "격리된 Pod만 지울 수 있습니다. 먼저 트래픽에서 뺍니다.",
  "cannot-isolate":
    "이 Pod는 트래픽에서 뺄 수 없습니다(이 Pod를 고르는 Service가 없거나 떼어 낼 라벨이 없음).",
  "action-in-progress": "이 대상에 실행 중인 조치가 있습니다.",
  "kube-forbidden": "서버에 이 조치 권한이 없습니다(RBAC Role).",
  "kube-error": "쿠버네티스가 조치를 거부했습니다.",
  "kube-timeout":
    "쿠버네티스가 10초 안에 답하지 않았습니다. 실행됐는지 목록에서 확인합니다.",
};

// 대상이 Deployment(스케일 조정)일 때 문장이 다른 오류 코드입니다(T24 '결과 문장').
const DEPLOYMENT_ERROR_SENTENCE: Record<string, string> = {
  "target-not-found": "Deployment가 이미 지워져 있습니다.",
  "target-changed":
    "같은 이름의 다른 Deployment로 바뀌었습니다. 목록을 다시 보고 실행합니다.",
};

export function errorSentence(code: string, kind: TargetKind = "pod"): string {
  return (
    (kind === "deployment" ? DEPLOYMENT_ERROR_SENTENCE[code] : undefined) ??
    ERROR_SENTENCE[code] ??
    `조치를 보내지 못했습니다(${code}).`
  );
}

// 서버에 닿지 못했거나 알 수 없는 답이면 조치가 실행됐는지 모릅니다.
export function isUnknownOutcome(code: string): boolean {
  return code === NETWORK_ERROR || code === UNEXPECTED_BODY;
}

// 라벨을 key=value로 이어 씁니다(예: app=demo-app, tier=web).
export function labelText(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function successSentence(item: ActionItem): string {
  switch (item.action) {
    case "restart-pod":
      return item.replicaSet === undefined
        ? "Pod를 지웠습니다."
        : `Pod를 지웠습니다. ReplicaSet ${item.replicaSet}이 새 Pod를 만듭니다.`;
    case "isolate-pod": {
      const isolation = item.isolation;
      const removed =
        isolation === undefined
          ? "트래픽에서 뺐습니다."
          : `Service ${isolation.services.join(", ")}에서 뺐습니다(뗀 라벨 ${labelText(isolation.labels)}).`;
      return item.replicaSet === undefined
        ? removed
        : `${removed} ReplicaSet ${item.replicaSet}이 대신할 새 Pod를 만듭니다.`;
    }
    case "delete-pod":
      return "격리된 Pod를 지웠습니다.";
    case "scale-deployment": {
      const scale = item.scale;
      const subject = `Deployment ${item.target.name}의 replica 수를`;
      const changed =
        scale === undefined
          ? `${subject} 바꿨습니다.`
          : scale.from === undefined
            ? `${subject} ${scale.to}개로 바꿨습니다.`
            : `${subject} ${scale.from}개에서 ${scale.to}개로 바꿨습니다.`;
      return scale?.hpa === undefined
        ? changed
        : `${changed} HPA가 다시 바꿀 수 있습니다(${scale.hpa}).`;
    }
  }
}

// 기록 한 건의 '내용' 문장입니다. 쿠버네티스가 답한 상태 코드가 있으면 앞에 붙입니다.
export function actionSentence(item: ActionItem): string {
  if (item.result === "succeeded") {
    return successSentence(item);
  }
  const sentence = errorSentence(item.error ?? "kube-error", item.target.kind);
  return item.kubeStatus === undefined
    ? sentence
    : `HTTP ${item.kubeStatus} · ${sentence}`;
}

// 성공한 '트래픽에서 빼기'입니다. 타임라인에 '격리됨' 배지를 붙입니다(docs/guides/T23.md 결정 21).
export function isIsolation(item: ActionItem): boolean {
  return item.action === "isolate-pod" && item.result === "succeeded";
}

export function actionTone(item: ActionItem): Tone {
  return item.result === "succeeded" ? "ok" : "warning";
}

// ── 기록 합치기와 거르기(결정 19, 20) ──

// GET으로 받은 기록과 스트림으로 받은 기록을 합칩니다. 같은 id는 하나로, 늦은 것부터입니다.
export function mergeActions(
  lists: readonly (readonly ActionItem[])[],
): ActionItem[] {
  const byId = new Map<string, ActionItem>();
  for (const list of lists) {
    for (const item of list) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      b.requestedAt - a.requestedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// 이 Pod가 대상인 조치입니다. 이름이 같은 Deployment의 스케일 조정은 넣지 않습니다(T24 결정 14).
export function isActionOn(item: ActionItem, pod: PodRef): boolean {
  return (
    item.target.kind === "pod" &&
    item.target.namespace === pod.namespace &&
    item.target.name === pod.name
  );
}

export interface ActionFilter {
  action: ActionKind | "all";
  result: ActionResult | "all";
  // 대상 이름에 들어 있는 글자입니다(대소문자 무시). 비면 거르지 않습니다.
  query: string;
}

export const NO_ACTION_FILTER: ActionFilter = {
  action: "all",
  result: "all",
  query: "",
};

export function filterActions(
  items: readonly ActionItem[],
  filter: ActionFilter,
): ActionItem[] {
  const query = filter.query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter.action === "all" || item.action === filter.action) &&
      (filter.result === "all" || item.result === filter.result) &&
      (query === "" || item.target.name.toLowerCase().includes(query)),
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// 조치 기록의 시각입니다. 오늘이면 'HH:MM:SS', 아니면 'MM-DD HH:MM:SS'(브라우저 시간대)입니다.
export function formatActionTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? clock
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

// ── 버튼 끄기(T21 결정 18, T23 결정 17) ──

// 버튼을 끌 이유입니다. 누를 수 있으면 undefined입니다.
// actionNamespaces가 undefined면 아직 목록을 받지 못한 것입니다.
// 서버와 같이 삭제는 격리된 Pod만, 재시작·트래픽에서 빼기는 격리되지 않은 Pod만 받습니다.
export function actionBlockReason(
  action: PodActionKind,
  pod: PodRef,
  item: PodItem | undefined,
  actionNamespaces: readonly string[] | undefined,
): string | undefined {
  const common = commonBlockReason(pod, item, actionNamespaces);
  if (common !== undefined) {
    return common;
  }
  if (action === "delete-pod") {
    return isIsolated(item)
      ? undefined
      : "격리된 Pod만 지울 수 있습니다. 먼저 트래픽에서 뺍니다.";
  }
  return isIsolated(item) ? "이미 트래픽에서 뺀 Pod입니다." : undefined;
}

function commonBlockReason(
  pod: PodRef,
  item: PodItem | undefined,
  actionNamespaces: readonly string[] | undefined,
): string | undefined {
  if (actionNamespaces === undefined || item === undefined) {
    return "서버에서 Pod 정보를 받는 중입니다.";
  }
  const off = namespaceBlockReason(pod.namespace, actionNamespaces);
  if (off !== undefined) {
    return off;
  }
  if (item.kube === undefined) {
    return "쿠버네티스에 없는 Pod입니다.";
  }
  if (item.kube.terminating) {
    return "Pod가 지워지는 중입니다.";
  }
  return undefined;
}

function namespaceBlockReason(
  namespace: string,
  actionNamespaces: readonly string[],
): string | undefined {
  if (actionNamespaces.includes(namespace)) {
    return undefined;
  }
  return actionNamespaces.length === 0
    ? "서버에서 조치가 꺼져 있습니다(GLASSPOD_ACTION_NAMESPACES)."
    : "이 namespace는 조치가 꺼져 있습니다(GLASSPOD_ACTION_NAMESPACES).";
}

// Deployment 카드의 '스케일 조정'을 끌 이유입니다(T24 결정 12). 카드는 쿠버네티스에 있는 Deployment에만 버튼을 둡니다.
export function scaleBlockReason(
  deployment: DeploymentItem,
  actionNamespaces: readonly string[] | undefined,
): string | undefined {
  if (actionNamespaces === undefined) {
    return "서버에서 목록을 받는 중입니다.";
  }
  return namespaceBlockReason(deployment.namespace, actionNamespaces);
}

export interface ImpactRow {
  pod: PodRef;
  status: PodStatus;
  // 오른쪽 짧은 말입니다.
  note: string;
  tone: Tone;
}

export interface RestartImpact {
  // 새 Pod를 만들 ReplicaSet입니다. 없으면 지운(뺀) Pod를 대신할 Pod가 생기지 않습니다.
  replicaSet?: string;
  deployment?: string;
  // 같은 Deployment(없으면 같은 ReplicaSet)의 다른 Pod입니다. 지워지는 중인 Pod는 뺍니다. 이름순입니다.
  others: ImpactRow[];
  // others 가운데 트래픽을 받을 수 있는 Pod(준비됐고 위험이 아님) 수입니다.
  // 재시작·주의 판단이어도 준비된 Pod는 트래픽을 받으므로 셉니다(2026-11-21 클러스터 확인).
  serving: number;
  // 코랄 경고 문장입니다. 없으면 비어 있습니다.
  warnings: string[];
}

// Pod 이름의 마지막 조각입니다(예: demo-app-7c9f8b6d5-9kd2p → 9kd2p).
export function shortPodName(name: string): string {
  const index = name.lastIndexOf("-");
  return index < 0 || index === name.length - 1 ? name : name.slice(index + 1);
}

function isServing(item: PodItem): boolean {
  return item.kube?.ready === true && item.severity !== "critical";
}

export function impactRow(item: PodItem): ImpactRow {
  if (item.kube?.ready !== true) {
    return {
      pod: item.pod,
      status: item.status,
      note: "트래픽 받지 않음",
      tone: "neutral",
    };
  }
  if (item.severity === "critical") {
    return {
      pod: item.pod,
      status: item.status,
      note: "응답이 없을 수 있음",
      tone: "critical",
    };
  }
  if (item.severity === "warning") {
    return {
      pod: item.pod,
      status: item.status,
      note: "주의",
      tone: "warning",
    };
  }
  return {
    pod: item.pod,
    status: item.status,
    note: STATUS_LABEL[item.status],
    tone: statusTone(item.status),
  };
}

// 영향을 계산하는 조치입니다. 문장만 다릅니다.
export type ImpactAction = "restart-pod" | "isolate-pod";

const IMPACT_TEXT: Record<
  ImpactAction,
  { noController: string; verb: string }
> = {
  "restart-pod": {
    noController:
      "이 Pod를 다시 만들 컨트롤러가 없습니다. 지우면 다시 생기지 않습니다.",
    verb: "재시작하면",
  },
  "isolate-pod": {
    noController:
      "대신할 Pod를 만들 컨트롤러가 없습니다. 빼면 트래픽을 받는 Pod가 하나 줄어듭니다.",
    verb: "빼면",
  },
};

// 재시작하거나 트래픽에서 빼면 트래픽을 받을 Pod와 경고입니다. 화면이 받은 목록(스트림)으로 계산합니다
// (T21 결정 17, T23 결정 15). 이미 격리된 Pod는 트래픽을 받지 않으므로 다른 Pod에 넣지 않습니다.
export function restartImpact(
  target: PodItem,
  pods: readonly PodItem[],
  action: ImpactAction = "restart-pod",
): RestartImpact {
  const text = IMPACT_TEXT[action];
  const replicaSet = target.kube?.replicaSet;
  const deployment = target.deployment;
  const sameGroup = (item: PodItem): boolean => {
    if (item.pod.namespace !== target.pod.namespace) {
      return false;
    }
    if (deployment !== undefined) {
      return item.deployment === deployment;
    }
    return replicaSet !== undefined && item.kube?.replicaSet === replicaSet;
  };
  const others = pods
    .filter(
      (item) =>
        item.pod.name !== target.pod.name &&
        sameGroup(item) &&
        item.kube !== undefined &&
        !item.kube.terminating &&
        item.kube.isolation === undefined,
    )
    .sort((a, b) => (a.pod.name < b.pod.name ? -1 : 1));
  const serving = others.filter(isServing).length;

  const warnings: string[] = [];
  if (replicaSet === undefined) {
    warnings.push(text.noController);
  }
  // 트래픽을 받지 못하는 다른 Pod(준비 안 됨, 위험)입니다.
  const troubled = others.filter((item) => !isServing(item));
  const after =
    serving === 0
      ? "새 Pod가 준비될 때까지 트래픽을 받을 Pod가 없습니다."
      : `지금 ${text.verb} 새 Pod가 준비될 때까지 Pod ${serving}개가 트래픽을 받습니다.`;
  const [first] = troubled;
  if (first !== undefined) {
    const who =
      troubled.length === 1
        ? `같은 Deployment의 ${shortPodName(first.pod.name)}도 ${STATUS_LABEL[first.status]}입니다.`
        : `같은 Deployment의 ${shortPodName(first.pod.name)} 외 ${troubled.length - 1}개도 트래픽을 받지 못할 수 있습니다.`;
    warnings.push(`${who} ${after}`);
  } else if (serving === 0) {
    warnings.push(after);
  }

  return {
    ...(replicaSet === undefined ? {} : { replicaSet }),
    ...(deployment === undefined ? {} : { deployment }),
    others: others.map(impactRow),
    serving,
    warnings,
  };
}

// ── 트래픽에서 빼기(T23 결정 15) ──

// '실행하면' 단계입니다. 계획을 아직 받지 못했으면 undefined를 넘깁니다.
export function isolateSteps(plan: IsolationPlan | undefined): string[] {
  if (plan === undefined) {
    return ["서버에서 뗄 라벨과 빠질 Service를 확인하는 중입니다."];
  }
  return [
    `Pod 라벨을 바꿉니다. 떼는 라벨: ${labelText(plan.labels)} · 붙이는 라벨: glasspod/isolated=true`,
    `Service ${plan.services.join(", ")}이 이 Pod로 트래픽을 보내지 않습니다.`,
    ...(plan.replicaSet === undefined
      ? []
      : [`ReplicaSet ${plan.replicaSet}이 대신할 새 Pod를 만듭니다.`]),
    "이 Pod는 지우지 않고 남습니다. 지표와 snapshot을 계속 받습니다.",
  ];
}

// ── 격리된 Pod 화면(T23 결정 18) ──

// 격리된 Pod를 늦게 뺀 것부터 둡니다. 격리 시각을 모르면 맨 뒤, 같으면 이름순입니다.
export function isolatedPods(pods: readonly PodItem[]): PodItem[] {
  return pods
    .filter(isIsolated)
    .sort(
      (a, b) =>
        (b.kube?.isolation?.at ?? -Infinity) -
          (a.kube?.isolation?.at ?? -Infinity) ||
        (a.pod.name < b.pod.name ? -1 : a.pod.name > b.pod.name ? 1 : 0),
    );
}

// ── 스케일 조정(docs/guides/T24.md 결정 2, 3, 13) ──

// 고를 수 있는 replica 수의 상한입니다. 서버(apps/server/src/actions.ts의 MAX_SCALE_REPLICAS)와 같은 값입니다.
export const MAX_SCALE_REPLICAS = 20;

export function isReplicaCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_SCALE_REPLICAS;
}

// 카드 칩의 글입니다(예: HPA 3~5).
export function hpaRange(hpa: DeploymentHpa): string {
  return `HPA ${hpa.minReplicas}~${hpa.maxReplicas}`;
}

// HPA 경고의 앞 문장입니다. 카드 버튼 title과 서랍 경고가 함께 씁니다.
export function hpaNote(hpa: DeploymentHpa): string {
  return `HPA ${hpa.name}(최소 ${hpa.minReplicas} · 최대 ${hpa.maxReplicas})가 이 Deployment의 replica 수를 관리합니다. 바꾼 값은 HPA가 다시 바꿀 수 있습니다.`;
}

export interface ScalePlan {
  // 지금 replica 수(Deployment spec)와 고른 수입니다.
  from: number;
  to: number;
  steps: string[];
  warnings: string[];
  notice: string;
  // 지금 이 Deployment의 Pod입니다. 격리된 Pod와 지워지는 중인 Pod는 뺍니다. 이름순입니다.
  pods: ImpactRow[];
  // 늘리면 새로 만들 Pod 수, 줄이면 지울 Pod 수입니다. 같으면 둘 다 0입니다.
  added: number;
  removed: number;
}

// 스케일 서랍의 '실행하면'·영향·경고·안내입니다. 화면이 받은 목록(스트림)으로 계산합니다(T24 '서랍 문장').
export function scalePlan(
  deployment: DeploymentItem,
  pods: readonly PodItem[],
  to: number,
): ScalePlan {
  const from = deployment.desired;
  const inNamespace = pods.filter(
    (item) => item.pod.namespace === deployment.namespace,
  );
  const members = inNamespace
    .filter(
      (item) =>
        item.deployment === deployment.name &&
        item.kube !== undefined &&
        !item.kube.terminating &&
        item.kube.isolation === undefined,
    )
    .sort((a, b) => (a.pod.name < b.pod.name ? -1 : 1));
  // 이 Deployment에서 트래픽에서 뺀 Pod입니다. Deployment가 놓아주어 replica 수에 들지 않습니다.
  const isolated = inNamespace.filter(
    (item) => item.kube?.isolation?.deployment === deployment.name,
  ).length;
  const added = Math.max(to - from, 0);
  const removed = Math.max(from - to, 0);

  const steps: string[] = [];
  if (to === from) {
    steps.push("바꿀 replica 수를 고릅니다.");
  } else {
    steps.push(
      `Deployment ${deployment.name}의 replica 수를 ${from}개에서 ${to}개로 바꿉니다.`,
    );
    if (added > 0) {
      steps.push(
        `ReplicaSet이 새 Pod ${added}개를 만듭니다. 준비되면 트래픽을 받습니다.`,
      );
    } else {
      steps.push(
        to === 0
          ? `ReplicaSet이 Pod ${from}개를 모두 지웁니다.`
          : `ReplicaSet이 Pod ${removed}개를 지웁니다. 준비 안 된 Pod와 늦게 만든 Pod를 먼저 고릅니다.`,
        "지운 Pod의 기록은 이 화면에 30분 남습니다.",
      );
    }
    if (isolated > 0) {
      steps.push(
        `격리된 Pod ${isolated}개는 Deployment가 관리하지 않아 이 수에 들지 않고 그대로 남습니다.`,
      );
    }
  }

  const warnings: string[] = [];
  const hpa = deployment.hpa;
  if (hpa !== undefined) {
    let tail = "";
    if (to === 0) {
      tail = " 0개면 HPA가 이 Deployment를 조정하지 않습니다.";
    } else if (to < hpa.minReplicas) {
      tail = ` ${to}개는 범위 밖이라 HPA가 곧 ${hpa.minReplicas}개로 되돌립니다.`;
    } else if (to > hpa.maxReplicas) {
      tail = ` ${to}개는 범위 밖이라 HPA가 곧 ${hpa.maxReplicas}개로 되돌립니다.`;
    }
    warnings.push(`${hpaNote(hpa)}${tail}`);
  }
  if (to === 0 && from > 0) {
    warnings.push(
      "replica를 0개로 하면 이 Deployment의 Pod가 모두 지워져 트래픽을 받을 Pod가 없습니다.",
    );
  }

  const notice =
    to === from
      ? `replica 수는 0~${MAX_SCALE_REPLICAS}개로 고릅니다.`
      : added > 0
        ? "새 Pod는 readiness probe를 통과한 뒤에 트래픽을 받습니다."
        : "Pod를 지우면 메모리 상태와 처리 중이던 요청이 사라집니다. 원인을 조사하려면 먼저 snapshot을 받아 둡니다.";

  return {
    from,
    to,
    steps,
    warnings,
    notice,
    pods: members.map(impactRow),
    added,
    removed,
  };
}
