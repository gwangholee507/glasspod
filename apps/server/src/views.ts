// 웹 화면용 조회 API의 본문을 만듭니다(docs/guides/T14.md).
// 서버 안의 모델(쿠버네티스 요약, SDK 지금 상태, 저장소 기록, 판단)을 @glasspod/protocol의 HTTP 본문 타입으로 바꿉니다.
// 여기 함수는 시각을 인자로 받는 순수 함수입니다.
import type {
  ActionItem,
  DeploymentItem,
  MetricKind,
  MetricSeriesBody,
  PodConnection,
  PodDetailBody,
  PodEvent,
  PodItem,
  PodKube,
  PodKubeEvent,
  PodListMetrics,
  PodMetricSeries,
  PodMetricValue,
  PodRef,
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
  KubeEventRecord,
  MetricsRecord,
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
    ...(summary.isolation === undefined
      ? {}
      : { isolation: summary.isolation }),
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

export function kubeEventItem(record: KubeEventRecord): PodKubeEvent {
  return {
    uid: record.uid,
    type: record.type,
    reason: record.reason,
    ...(record.message === undefined ? {} : { message: record.message }),
    count: record.count,
    ...(record.firstAt === undefined ? {} : { firstAt: record.firstAt }),
    lastAt: record.lastAt,
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

// 상세 본문입니다(결정 13). records는 그 Pod의 최근 30분 기록, actions는 그 Pod에 한 조치 전부입니다(T21 결정 11).
export function podDetail(
  item: PodItem,
  app: AppState | undefined,
  records: PodRecords,
  serverTime: number,
  actions: readonly ActionItem[] = [],
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
    kubeEvents: records.kubeEvents.map(kubeEventItem),
    actions: [...actions],
  };
}

// ── 그래프용 시계열(docs/guides/T19.md 결정 5, 6) ──

// 한 번에 물을 수 있는 지표 수와, 함께 그릴 같은 Deployment의 다른 Pod 수입니다.
export const MAX_SERIES_METRICS = 8;
export const MAX_SERIES_SIBLINGS = 10;
// 지표 이름 규칙입니다(sdk-message.schema.json의 MetricName).
const METRIC_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export type MetricsQuery =
  { ok: true; names: string[] } | { ok: false; detail: string };

// ?metrics=a,b 쿼리입니다. 1~8개, 같은 이름은 하나로, 처음 나온 순서입니다.
export function parseMetricsQuery(value: unknown): MetricsQuery {
  if (typeof value !== "string" || value.trim() === "") {
    return {
      ok: false,
      detail: "metrics must list 1 to 8 metric names separated by commas",
    };
  }
  const names = [...new Set(value.split(",").map((name) => name.trim()))];
  const bad = names.find((name) => !METRIC_NAME.test(name));
  if (bad !== undefined) {
    return {
      ok: false,
      detail: `metrics has an invalid metric name ${JSON.stringify(bad)}`,
    };
  }
  if (names.length > MAX_SERIES_METRICS) {
    return {
      ok: false,
      detail: `metrics may list at most ${MAX_SERIES_METRICS} names (got ${names.length})`,
    };
  }
  return { ok: true, names };
}

// 그래프에 함께 그릴 Pod입니다. 이 Pod가 맨 앞, 그 뒤 같은 namespace·Deployment의 다른 Pod를 이름순으로 10개까지.
export function seriesPods(item: PodItem, items: readonly PodItem[]): PodRef[] {
  // 트래픽에서 뺀 Pod는 Deployment가 놓아주므로 원래 Deployment의 Pod와 견줍니다(docs/guides/T23.md 결정 13).
  const deployment = item.deployment ?? item.kube?.isolation?.deployment;
  const siblings =
    deployment === undefined
      ? []
      : items
          .filter(
            (other) =>
              other.pod.namespace === item.pod.namespace &&
              other.pod.name !== item.pod.name &&
              other.deployment === deployment,
          )
          .map((other) => other.pod)
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .slice(0, MAX_SERIES_SIBLINGS);
  return [{ namespace: item.pod.namespace, name: item.pod.name }, ...siblings];
}

// Pod 하나의 시계열입니다. records는 받은 순서입니다.
// gapMs보다 벌어졌거나 instance가 바뀐 곳에는 앞 점 1ms 뒤에 값이 모두 null인 시각을 넣어 선을 끊습니다.
export function podSeries(
  pod: PodRef,
  records: readonly MetricsRecord[],
  names: readonly string[],
  gapMs: number,
): PodMetricSeries {
  const times: number[] = [];
  const values: (number | null)[][] = names.map(() => []);
  // counter마다 같은 instance에서 앞서 그 counter가 든 기록의 SDK 시각입니다.
  const counterTs = new Map<string, number>();
  let previous: MetricsRecord | undefined;
  for (const record of records) {
    if (previous !== undefined) {
      const newInstance = record.instanceId !== previous.instanceId;
      if (newInstance || record.receivedAt - previous.receivedAt > gapMs) {
        times.push(previous.receivedAt + 1);
        for (const column of values) {
          column.push(null);
        }
      }
      if (newInstance) {
        counterTs.clear();
      }
    }
    times.push(record.receivedAt);
    names.forEach((name, index) => {
      const metric = record.values.find((value) => value.name === name);
      const column = values[index] as (number | null)[];
      if (metric === undefined) {
        column.push(null);
        return;
      }
      if (metric.kind === "gauge") {
        column.push(metric.value);
        return;
      }
      const before = counterTs.get(name);
      counterTs.set(name, record.ts);
      column.push(
        metric.reset === true ||
          metric.increase === undefined ||
          before === undefined ||
          record.ts <= before
          ? null
          : metric.increase / ((record.ts - before) / 1000),
      );
    });
    previous = record;
  }
  return {
    pod: { namespace: pod.namespace, name: pod.name },
    times,
    values,
  };
}

// 시계열 본문입니다. pods는 seriesPods 순서, records는 그 Pod마다 since 이후의 지표 기록입니다.
export function metricSeriesBody(
  names: readonly string[],
  pods: readonly { pod: PodRef; records: readonly MetricsRecord[] }[],
  gapMs: number,
  serverTime: number,
  since: number,
): MetricSeriesBody {
  const kinds = new Map<string, MetricKind>();
  for (const { records } of pods) {
    for (const record of records) {
      for (const value of record.values) {
        if (!kinds.has(value.name) && names.includes(value.name)) {
          kinds.set(value.name, value.kind);
        }
      }
    }
  }
  return {
    serverTime,
    since,
    metrics: names.map((name) => {
      const kind = kinds.get(name);
      return kind === undefined ? { name } : { name, kind };
    }),
    pods: pods.map(({ pod, records }) => podSeries(pod, records, names, gapMs)),
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
