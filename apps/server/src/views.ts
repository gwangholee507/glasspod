// 웹 화면용 조회 API의 본문을 만듭니다(docs/guides/T14.md).
// 서버 안의 모델(쿠버네티스 요약, SDK 지금 상태, 저장소 기록, 판단)을 @glasspod/protocol의 HTTP 본문 타입으로 바꿉니다.
// 여기 함수는 시각을 인자로 받는 순수 함수입니다.
import type {
  DeploymentItem,
  PodConnection,
  PodDetailBody,
  PodEvent,
  PodItem,
  PodKube,
  PodListMetrics,
  PodMetricValue,
  PodRestart,
  PodSdk,
  PodStatusChange,
} from "@glasspod/protocol";
import type { DeploymentSummary, PodSummary } from "./cluster.js";
import { isNamespaceName } from "./config.js";
import type { AppState } from "./pods.js";
import { INCREASE_WINDOW_MS } from "./pods.js";
import type { RestartInfo } from "./status.js";
import { pickRestartCauses } from "./status.js";
import type { PodStatusEntry } from "./status-monitor.js";
import type {
  ConnectionRecord,
  EventRecord,
  PodRecords,
  StatusChangeRecord,
} from "./store/store.js";

// 목록 지표가 읽는 지표 이름입니다(design.md 5.3, docs/guides/T14.md 결정 9).
export const LIST_METRIC_NAMES = {
  eventLoopP99Ms: "runtime.event_loop.lag_p99_ms",
  heapUsedBytes: "runtime.heap.used_bytes",
  heapLimitBytes: "runtime.heap.limit_bytes",
  httpP99Ms: "http.requests.duration_p99_ms",
} as const satisfies Record<
  keyof Omit<PodListMetrics, "http5xxPerMinute">,
  string
>;
// 5xx/분은 이 counter의 최근 60초 증가량 합입니다.
export const HTTP_ERRORS_COUNTER = "http.requests.errors_total";

// 목록 지표입니다. 지금 instance가 그 지표를 보내지 않았으면 필드가 없습니다.
export function listMetrics(
  app: AppState | undefined,
  now: number,
): PodListMetrics {
  const metrics: PodListMetrics = {};
  if (app === undefined) {
    return metrics;
  }
  for (const [field, name] of Object.entries(LIST_METRIC_NAMES) as [
    keyof typeof LIST_METRIC_NAMES,
    string,
  ][]) {
    const value = app.values.get(name);
    if (value !== undefined) {
      metrics[field] = value.value;
    }
  }
  if (app.values.has(HTTP_ERRORS_COUNTER)) {
    const since = now - INCREASE_WINDOW_MS;
    let sum = 0;
    for (const entry of app.increases.get(HTTP_ERRORS_COUNTER) ?? []) {
      if (entry.at >= since) {
        sum += entry.increase;
      }
    }
    metrics.http5xxPerMinute = sum;
  }
  return metrics;
}

export function kubeItem(summary: PodSummary): PodKube {
  const termination = summary.lastTermination;
  return {
    uid: summary.uid,
    phase: summary.phase,
    ready: summary.ready,
    terminating: summary.terminating,
    restarts: summary.restarts,
    ...(summary.waiting === undefined ? {} : { waiting: summary.waiting }),
    ...(termination === undefined
      ? {}
      : {
          lastTermination: {
            container: termination.container,
            reason: termination.reason,
            exitCode: termination.exitCode,
            ...(termination.finishedAt === undefined
              ? {}
              : { finishedAt: termination.finishedAt }),
          },
        }),
    ...(summary.ip === undefined ? {} : { ip: summary.ip }),
    ...(summary.replicaSet === undefined
      ? {}
      : { replicaSet: summary.replicaSet }),
    ...(summary.createdAt === undefined
      ? {}
      : { createdAt: summary.createdAt }),
  };
}

export function sdkItem(app: AppState): PodSdk {
  return {
    connected: app.connected,
    instanceId: app.instanceId,
    sdk: app.sdk,
    ...(app.app === undefined ? {} : { app: app.app }),
    instanceSince: app.instanceSince,
    connectedAt: app.connectedAt,
    ...(app.disconnectedAt === undefined
      ? {}
      : { disconnectedAt: app.disconnectedAt }),
    ...(app.lastMetricsAt === undefined
      ? {}
      : { lastMetricsAt: app.lastMetricsAt }),
    missed: app.missed,
  };
}

export function restartItem(restart: RestartInfo): PodRestart {
  return {
    at: restart.at,
    ...(restart.reason === undefined ? {} : { reason: restart.reason }),
    ...(restart.exitCode === undefined ? {} : { exitCode: restart.exitCode }),
    ...(restart.previousInstanceId === undefined
      ? {}
      : { previousInstanceId: restart.previousInstanceId }),
  };
}

// 목록의 Pod 항목입니다. 판단의 silentMs는 판단 주기마다 바뀌므로 넣지 않습니다(결정 11).
export function podItem(
  entry: PodStatusEntry,
  summary: PodSummary | undefined,
  app: AppState | undefined,
  now: number,
): PodItem {
  return {
    pod: { namespace: entry.pod.namespace, name: entry.pod.name },
    ...(entry.deployment === undefined ? {} : { deployment: entry.deployment }),
    status: entry.status,
    severity: entry.severity,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    since: entry.since,
    ...(entry.restart === undefined
      ? {}
      : { restart: restartItem(entry.restart) }),
    ...(summary === undefined ? {} : { kube: kubeItem(summary) }),
    ...(app === undefined ? {} : { sdk: sdkItem(app) }),
    metrics: listMetrics(app, now),
  };
}

export function deploymentItem(summary: DeploymentSummary): DeploymentItem {
  return {
    namespace: summary.namespace,
    name: summary.name,
    desired: summary.desired,
    ready: summary.ready,
    available: summary.available,
  };
}

export function eventItem(record: EventRecord): PodEvent {
  return {
    instanceId: record.instanceId,
    seq: record.seq,
    ts: record.ts,
    receivedAt: record.receivedAt,
    level: record.level,
    name: record.name,
    ...(record.message === undefined ? {} : { message: record.message }),
    count: record.count,
    ...(record.data === undefined ? {} : { data: record.data }),
  };
}

export function connectionItem(record: ConnectionRecord): PodConnection {
  return {
    instanceId: record.instanceId,
    change: record.change,
    at: record.at,
    ...(record.newInstance === undefined
      ? {}
      : { newInstance: record.newInstance }),
    ...(record.sdk === undefined ? {} : { sdk: record.sdk }),
    ...(record.app === undefined ? {} : { app: record.app }),
    ...(record.code === undefined ? {} : { code: record.code }),
  };
}

export function statusChangeItem(record: StatusChangeRecord): PodStatusChange {
  return {
    pod: { namespace: record.pod.namespace, name: record.pod.name },
    at: record.at,
    status: record.status,
    severity: record.severity,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.previous === undefined ? {} : { previous: record.previous }),
    ...(record.deployment === undefined
      ? {}
      : { deployment: record.deployment }),
  };
}

// 지금 instance의 마지막 값 전부, 이름순입니다.
export function metricValues(app: AppState | undefined): PodMetricValue[] {
  if (app === undefined) {
    return [];
  }
  return [...app.values]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => ({
      name,
      kind: value.kind,
      value: value.value,
      ts: value.ts,
      receivedAt: value.receivedAt,
    }));
}

// 상세 본문입니다(결정 13). records는 그 Pod의 최근 30분 기록입니다.
export function podDetail(
  item: PodItem,
  app: AppState | undefined,
  records: PodRecords,
  serverTime: number,
): PodDetailBody {
  const previousInstanceId = item.restart?.previousInstanceId;
  return {
    serverTime,
    item,
    values: metricValues(app),
    events: records.events.map(eventItem),
    restartCauses:
      previousInstanceId === undefined
        ? []
        : pickRestartCauses(records.events, previousInstanceId).map(eventItem),
    connections: records.connections.map(connectionItem),
    statusChanges: records.statusChanges.map(statusChangeItem),
  };
}

export type NamespaceQuery =
  { ok: true; namespace: string | undefined } | { ok: false; detail: string };

// ?namespace= 쿼리입니다. 없으면 전부, 하나의 namespace 이름이면 그것만, 그 밖은 잘못된 쿼리입니다.
export function parseNamespaceQuery(value: unknown): NamespaceQuery {
  if (value === undefined) {
    return { ok: true, namespace: undefined };
  }
  if (typeof value !== "string" || !isNamespaceName(value)) {
    return {
      ok: false,
      detail: `namespace must be one Kubernetes namespace name (got ${JSON.stringify(value)})`,
    };
  }
  return { ok: true, namespace: value };
}
