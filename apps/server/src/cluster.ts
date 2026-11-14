// 쿠버네티스에서 받은 Pod·Deployment·ReplicaSet을 요약해 지금 상태로 들고 있습니다(docs/guides/T12.md '요약').
// 지워진 것은 바로 빼고, 이력은 들고 있지 않습니다(T11).
import type {
  V1Deployment,
  V1ObjectMeta,
  V1Pod,
  V1ReplicaSet,
} from "@kubernetes/client-node";

export interface PodTermination {
  container: string;
  reason: string;
  exitCode: number;
  finishedAt: string | undefined;
}

export interface PodSummary {
  namespace: string;
  name: string;
  uid: string;
  phase: string;
  ready: boolean;
  terminating: boolean;
  restarts: number;
  waiting: string | undefined;
  lastTermination: PodTermination | undefined;
  ip: string | undefined;
  replicaSet: string | undefined;
  createdAt: string | undefined;
}

export interface DeploymentSummary {
  namespace: string;
  name: string;
  uid: string;
  desired: number;
  ready: number;
  available: number;
}

export interface ReplicaSetSummary {
  namespace: string;
  name: string;
  uid: string;
  deployment: string | undefined;
  revision: string | undefined;
  desired: number;
}

// 바뀌었는지 비교하는 필드입니다. 이름·namespace·uid·createdAt은 같은 객체면 바뀌지 않습니다.
const POD_FIELDS = [
  "phase",
  "ready",
  "terminating",
  "restarts",
  "waiting",
  "lastTermination",
  "ip",
  "replicaSet",
] as const satisfies readonly (keyof PodSummary)[];
const DEPLOYMENT_FIELDS = [
  "desired",
  "ready",
  "available",
] as const satisfies readonly (keyof DeploymentSummary)[];
const REPLICA_SET_FIELDS = [
  "deployment",
  "revision",
  "desired",
] as const satisfies readonly (keyof ReplicaSetSummary)[];

const REVISION_ANNOTATION = "deployment.kubernetes.io/revision";

// list 결과는 client-node가 날짜를 Date로 바꾸지만, watch로 온 객체는 JSON 그대로라 문자열입니다.
function isoTime(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === "string" ? value : undefined;
}

function timeOf(value: string | undefined): number {
  const parsed = value === undefined ? NaN : Date.parse(value);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

// 이 객체를 관리하는 controller owner 가운데 정한 종류의 이름입니다.
function controllerName(
  metadata: V1ObjectMeta | undefined,
  kind: string,
): string | undefined {
  const owner = metadata?.ownerReferences?.find(
    (reference) => reference.controller === true && reference.kind === kind,
  );
  return owner?.name;
}

function identity(metadata: V1ObjectMeta | undefined): {
  namespace: string;
  name: string;
  uid: string;
} {
  return {
    namespace: metadata?.namespace ?? "",
    name: metadata?.name ?? "",
    uid: metadata?.uid ?? "",
  };
}

export function summarizePod(pod: V1Pod): PodSummary {
  const statuses = pod.status?.containerStatuses ?? [];

  // 지금 끝나 있는 컨테이너(state)와 직전에 끝난 컨테이너(lastState) 가운데 가장 최근 것입니다.
  let lastTermination: PodTermination | undefined;
  for (const status of statuses) {
    for (const terminated of [
      status.state?.terminated,
      status.lastState?.terminated,
    ]) {
      if (terminated === undefined) {
        continue;
      }
      const candidate: PodTermination = {
        container: status.name,
        reason: terminated.reason ?? "Unknown",
        exitCode: terminated.exitCode,
        finishedAt: isoTime(terminated.finishedAt),
      };
      if (
        lastTermination === undefined ||
        timeOf(candidate.finishedAt) > timeOf(lastTermination.finishedAt)
      ) {
        lastTermination = candidate;
      }
    }
  }

  return {
    ...identity(pod.metadata),
    phase: pod.status?.phase ?? "Unknown",
    ready:
      pod.status?.conditions?.some(
        (condition) =>
          condition.type === "Ready" && condition.status === "True",
      ) ?? false,
    terminating: pod.metadata?.deletionTimestamp != null,
    restarts: statuses.reduce((sum, status) => sum + status.restartCount, 0),
    waiting: statuses.find((status) => status.state?.waiting?.reason)?.state
      ?.waiting?.reason,
    lastTermination,
    ip: pod.status?.podIP || undefined,
    replicaSet: controllerName(pod.metadata, "ReplicaSet"),
    createdAt: isoTime(pod.metadata?.creationTimestamp),
  };
}

export function summarizeDeployment(
  deployment: V1Deployment,
): DeploymentSummary {
  return {
    ...identity(deployment.metadata),
    desired: deployment.spec?.replicas ?? 1,
    ready: deployment.status?.readyReplicas ?? 0,
    available: deployment.status?.availableReplicas ?? 0,
  };
}

export function summarizeReplicaSet(
  replicaSet: V1ReplicaSet,
): ReplicaSetSummary {
  return {
    ...identity(replicaSet.metadata),
    deployment: controllerName(replicaSet.metadata, "Deployment"),
    revision: replicaSet.metadata?.annotations?.[REVISION_ANNOTATION],
    desired: replicaSet.spec?.replicas ?? 1,
  };
}

// 두 요약에서 값이 다른 필드 이름입니다. 객체 값(lastTermination)은 내용으로 비교합니다.
export function changedFields<T, K extends keyof T>(
  previous: T,
  next: T,
  fields: readonly K[],
): K[] {
  return fields.filter(
    (field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]),
  );
}

export type SetResult<K> =
  { kind: "added" } | { kind: "changed"; fields: K[] } | { kind: "unchanged" };

// namespace/이름으로 요약을 들고 있습니다. 넣은 순서대로 돕니다.
class SummaryMap<
  T extends { namespace: string; name: string },
  K extends keyof T,
> {
  private readonly items = new Map<string, T>();

  constructor(private readonly fields: readonly K[]) {}

  set(next: T): SetResult<K> {
    const key = `${next.namespace}/${next.name}`;
    const previous = this.items.get(key);
    this.items.set(key, next);
    if (previous === undefined) {
      return { kind: "added" };
    }
    const fields = changedFields(previous, next, this.fields);
    return fields.length === 0
      ? { kind: "unchanged" }
      : { kind: "changed", fields };
  }

  delete(namespace: string, name: string): T | undefined {
    const key = `${namespace}/${name}`;
    const previous = this.items.get(key);
    this.items.delete(key);
    return previous;
  }

  get(namespace: string, name: string): T | undefined {
    return this.items.get(`${namespace}/${name}`);
  }

  list(): T[] {
    return [...this.items.values()];
  }
}

export type PodField = (typeof POD_FIELDS)[number];
export type DeploymentField = (typeof DEPLOYMENT_FIELDS)[number];
export type ReplicaSetField = (typeof REPLICA_SET_FIELDS)[number];

// watch가 채우는 클러스터의 지금 상태입니다. T13 상태 판단과 T14 조회 API가 읽습니다.
export class ClusterState {
  readonly pods = new SummaryMap<PodSummary, PodField>(POD_FIELDS);
  readonly deployments = new SummaryMap<DeploymentSummary, DeploymentField>(
    DEPLOYMENT_FIELDS,
  );
  readonly replicaSets = new SummaryMap<ReplicaSetSummary, ReplicaSetField>(
    REPLICA_SET_FIELDS,
  );

  // Pod → ReplicaSet → Deployment. ReplicaSet을 아직 받지 못했거나 Deployment가 만든 것이 아니면 undefined입니다.
  deploymentOf(pod: PodSummary): string | undefined {
    if (pod.replicaSet === undefined) {
      return undefined;
    }
    return this.replicaSets.get(pod.namespace, pod.replicaSet)?.deployment;
  }
}
