// 트래픽에서 빼기(격리)의 순수 함수입니다(docs/guides/T23.md 결정 5~8).
// 격리 상태는 쿠버네티스 Pod에 남깁니다: Service와 ReplicaSet이 고르는 라벨을 떼고, 표시 라벨과 주석을 붙입니다.
// 서버를 다시 시작해도 watch가 라벨·주석을 읽어 격리 정보를 되찾습니다.
import type { V1ObjectMeta } from "@kubernetes/client-node";
import type {
  ActionActor,
  IsolationPlan,
  PodIsolation,
  PodStatus,
} from "@glasspod/protocol";

// 격리된 Pod의 표시 라벨입니다. `kubectl get pods -l glasspod/isolated=true`로 찾습니다.
export const ISOLATED_LABEL = "glasspod/isolated";
export const ISOLATED_VALUE = "true";

// 격리 정보 주석입니다. 값의 길이와 문자에 제한이 없는 주석에 둡니다.
export const ISOLATION_ANNOTATIONS = {
  // ISO 8601, 서버 시계
  at: "glasspod/isolated-at",
  // 뗀 라벨, JSON 객체
  labels: "glasspod/isolated-labels",
  // 격리할 때의 판단 코드
  status: "glasspod/isolated-status",
  deployment: "glasspod/isolated-deployment",
  replicaSet: "glasspod/isolated-replicaset",
  // user 또는 rule:<이름>
  by: "glasspod/isolated-by",
  // 격리할 때 다른 Pod보다 높던 값의 이름, JSON 배열(docs/guides/T28.md 결정 21). 없었으면 붙이지 않음
  outliers: "glasspod/isolated-outliers",
} as const;

// Deployment가 ReplicaSet selector에 붙이는 라벨입니다. Service는 보통 이것으로 고르지 않으므로 마지막에 고릅니다.
const TEMPLATE_HASH_LABEL = "pod-template-hash";

// 판단 코드입니다(packages/protocol의 PodStatus). 주석 값을 확인할 때 씁니다.
const POD_STATUSES: readonly PodStatus[] = [
  "terminated",
  "pod-failing",
  "stalled",
  "disconnected",
  "restarted",
  "not-ready",
  "starting",
  "no-sdk",
  "ok",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function parseLabels(text: string | undefined): Record<string, string> {
  if (text === undefined) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(value)) {
    return {};
  }
  const labels: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      labels[key] = entry;
    }
  }
  return labels;
}

function parseOutliers(text: string | undefined): string[] | undefined {
  if (text === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const names = value.filter(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
  return names.length === 0 ? undefined : names;
}

function parseActor(text: string | undefined): ActionActor | undefined {
  if (text === "user") {
    return { kind: "user" };
  }
  if (text?.startsWith("rule:") === true && text.length > "rule:".length) {
    return { kind: "rule", name: text.slice("rule:".length) };
  }
  return undefined;
}

export function actorAnnotation(actor: ActionActor): string {
  return actor.kind === "user" ? "user" : `rule:${actor.name}`;
}

// Pod 라벨·주석에서 격리 정보를 읽습니다(결정 5, 12). 표시 라벨이 없으면 undefined입니다.
// 주석이 없거나 깨졌으면 그 필드만 없습니다(손으로 표시 라벨만 붙인 Pod도 격리된 Pod로 봅니다).
export function readIsolation(
  metadata: V1ObjectMeta | undefined,
): PodIsolation | undefined {
  if (metadata?.labels?.[ISOLATED_LABEL] !== ISOLATED_VALUE) {
    return undefined;
  }
  const annotations = metadata.annotations ?? {};
  const atText = annotations[ISOLATION_ANNOTATIONS.at];
  const at = atText === undefined ? NaN : Date.parse(atText);
  const statusText = annotations[ISOLATION_ANNOTATIONS.status];
  const status = POD_STATUSES.find((value) => value === statusText);
  const deployment = nonEmpty(annotations[ISOLATION_ANNOTATIONS.deployment]);
  const replicaSet = nonEmpty(annotations[ISOLATION_ANNOTATIONS.replicaSet]);
  const actor = parseActor(annotations[ISOLATION_ANNOTATIONS.by]);
  const outliers = parseOutliers(annotations[ISOLATION_ANNOTATIONS.outliers]);
  return {
    ...(Number.isFinite(at) ? { at } : {}),
    labels: parseLabels(annotations[ISOLATION_ANNOTATIONS.labels]),
    ...(status === undefined ? {} : { status }),
    ...(deployment === undefined ? {} : { deployment }),
    ...(replicaSet === undefined ? {} : { replicaSet }),
    ...(actor === undefined ? {} : { actor }),
    ...(outliers === undefined ? {} : { outliers }),
  };
}

export interface PlanInput {
  // 지금 Pod 라벨입니다.
  podLabels: Readonly<Record<string, string>>;
  // 이 Pod를 관리하는 ReplicaSet입니다. 컨트롤러가 없으면 undefined입니다.
  replicaSet:
    | {
        name: string;
        deployment?: string;
        // selector.matchLabels입니다. 없으면(matchExpressions만) undefined입니다.
        matchLabels?: Readonly<Record<string, string>>;
      }
    | undefined;
  // 같은 namespace의 Service입니다. selector가 없는 Service(엔드포인트를 손으로 둠)도 들어 있을 수 있습니다.
  services: readonly {
    name: string;
    selector?: Readonly<Record<string, string>>;
  }[];
}

export type PlanResult =
  { ok: true; plan: IsolationPlan } | { ok: false; detail: string };

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Service selector가 이 Pod를 고르는지 봅니다. 빈 selector는 아무것도 고르지 않습니다(쿠버네티스와 같음).
function selects(
  selector: Readonly<Record<string, string>> | undefined,
  labels: Readonly<Record<string, string>>,
): boolean {
  const entries = Object.entries(selector ?? {});
  return (
    entries.length > 0 && entries.every(([key, value]) => labels[key] === value)
  );
}

// 뗄 라벨을 고릅니다(결정 6, 7). 이 Pod를 고르는 Service마다 키 하나를 떼고, ReplicaSet selector의 키도 하나는 뗍니다.
// 키는 Service와 ReplicaSet이 함께 쓰는 것을 먼저, 같은 조건이면 이름순으로 고릅니다.
export function planIsolation(input: PlanInput): PlanResult {
  const { podLabels, replicaSet } = input;
  const services = input.services
    .filter((service) => selects(service.selector, podLabels))
    .sort((a, b) => byName(a.name, b.name));
  if (services.length === 0) {
    return { ok: false, detail: "no service selects this pod" };
  }

  // ReplicaSet selector 가운데 이 Pod에 실제로 있는 키입니다. pod-template-hash는 마지막입니다.
  const replicaSetKeys = Object.entries(replicaSet?.matchLabels ?? {})
    .filter(([key, value]) => podLabels[key] === value)
    .map(([key]) => key)
    .sort(
      (a, b) =>
        Number(a === TEMPLATE_HASH_LABEL) - Number(b === TEMPLATE_HASH_LABEL) ||
        byName(a, b),
    );

  const chosen = new Set<string>();
  for (const service of services) {
    const keys = Object.keys(service.selector ?? {}).sort(byName);
    if (keys.some((key) => chosen.has(key))) {
      continue;
    }
    const shared = keys.find((key) => replicaSetKeys.includes(key));
    const key = shared ?? keys[0];
    if (key !== undefined) {
      chosen.add(key);
    }
  }
  if (
    replicaSet !== undefined &&
    !replicaSetKeys.some((key) => chosen.has(key))
  ) {
    const [key] = replicaSetKeys;
    if (key === undefined) {
      return {
        ok: false,
        detail: `replicaset ${replicaSet.name} selector has no matchLabels on this pod`,
      };
    }
    chosen.add(key);
  }

  const labels: Record<string, string> = {};
  for (const key of [...chosen].sort(byName)) {
    labels[key] = podLabels[key] ?? "";
  }
  return {
    ok: true,
    plan: {
      labels,
      services: services.map((service) => service.name),
      ...(replicaSet === undefined ? {} : { replicaSet: replicaSet.name }),
      ...(replicaSet?.deployment === undefined
        ? {}
        : { deployment: replicaSet.deployment }),
    },
  };
}

export interface IsolationPatchInput {
  // 읽은 Pod의 resourceVersion입니다. 그사이 Pod가 바뀌었으면 쿠버네티스가 409로 거부합니다(결정 8).
  resourceVersion: string;
  plan: IsolationPlan;
  at: number;
  status: PodStatus | undefined;
  actor: ActionActor;
  // 격리할 때 다른 Pod보다 높던 값의 이름입니다(T28 결정 21). 비었으면 주석을 붙이지 않습니다.
  outliers?: readonly string[];
}

// merge patch 본문입니다. 뗄 라벨은 null로 지우고, 표시 라벨과 주석을 붙입니다.
export function isolationPatch(input: IsolationPatchInput): object {
  const { plan } = input;
  const labels: Record<string, string | null> = {};
  for (const key of Object.keys(plan.labels)) {
    labels[key] = null;
  }
  labels[ISOLATED_LABEL] = ISOLATED_VALUE;
  const annotations: Record<string, string> = {
    [ISOLATION_ANNOTATIONS.at]: new Date(input.at).toISOString(),
    [ISOLATION_ANNOTATIONS.labels]: JSON.stringify(plan.labels),
    [ISOLATION_ANNOTATIONS.by]: actorAnnotation(input.actor),
  };
  if (input.status !== undefined) {
    annotations[ISOLATION_ANNOTATIONS.status] = input.status;
  }
  if (plan.deployment !== undefined) {
    annotations[ISOLATION_ANNOTATIONS.deployment] = plan.deployment;
  }
  if (plan.replicaSet !== undefined) {
    annotations[ISOLATION_ANNOTATIONS.replicaSet] = plan.replicaSet;
  }
  if (input.outliers !== undefined && input.outliers.length > 0) {
    annotations[ISOLATION_ANNOTATIONS.outliers] = JSON.stringify(
      input.outliers,
    );
  }
  return {
    metadata: {
      resourceVersion: input.resourceVersion,
      labels,
      annotations,
    },
  };
}
