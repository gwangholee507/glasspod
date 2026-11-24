// 메모리 저장소입니다(GLASSPOD_STORE=memory, 기본). 서버가 다시 시작되면 사라집니다.
// Pod마다 기록 종류별 배열을 들고, 상한을 넘으면 오래된 것부터 버립니다(docs/guides/T11.md 결정 2, 17).
import type { PodRef } from "@glasspod/protocol";
import { log } from "../log.js";
import { podKey, podLabel } from "../pod-key.js";
import type {
  ActionQuery,
  ActionRecord,
  ConnectionRecord,
  DeletedPodRecord,
  EventRecord,
  KubeEventRecord,
  MetricsRecord,
  PodRecords,
  PruneResult,
  StatusChangeRecord,
  Store,
  StoreStats,
} from "./store.js";

// Pod 하나에 들고 있는 기록 수의 상한입니다. 지표는 주기 하한(1초)이면 30분에 1,800건입니다.
export const MAX_METRICS_PER_POD = 2_000;
export const MAX_EVENTS_PER_POD = 500;
export const MAX_CONNECTIONS_PER_POD = 500;
// 판단은 1초마다 바뀔 수 있어 30분이면 1,800건이 될 수 있습니다. 오래된 것부터 버립니다(docs/guides/T14.md 결정 3).
export const MAX_STATUS_CHANGES_PER_POD = 500;
// 쿠버네티스 Event는 같은 것을 바꿔 끼우므로 Pod마다 몇십 개를 넘지 않습니다(docs/guides/T19.md 결정 8).
export const MAX_KUBE_EVENTS_PER_POD = 200;
// 조치 기록은 Pod별이 아니라 서버 전체에서 이만큼 남깁니다(docs/guides/T21.md 결정 3).
export const MAX_ACTIONS = 1_000;

type LimitedKind =
  "metrics" | "events" | "connections" | "statusChanges" | "kubeEvents";

interface Bucket {
  pod: PodRef;
  // 모두 넣은 순서(받은 시각 순서)입니다.
  metrics: MetricsRecord[];
  events: EventRecord[];
  connections: ConnectionRecord[];
  deletions: DeletedPodRecord[];
  statusChanges: StatusChangeRecord[];
  // 받은 순서(receivedAt)입니다. 바꿔 끼운 것은 맨 뒤로 옮깁니다.
  kubeEvents: KubeEventRecord[];
  // 상한을 넘었다고 이미 경고한 기록 종류입니다.
  warned: Set<LimitedKind>;
}

export class MemoryStore implements Store {
  readonly kind = "memory";
  private readonly buckets = new Map<string, Bucket>();
  // 넣은 순서입니다. 30분 정리에서 빠집니다.
  private readonly actionRecords: ActionRecord[] = [];
  private droppedActions = 0;
  private readonly dropped: Record<LimitedKind, number> = {
    metrics: 0,
    events: 0,
    connections: 0,
    statusChanges: 0,
    kubeEvents: 0,
  };

  async addMetrics(record: MetricsRecord): Promise<void> {
    const bucket = this.bucket(record.pod);
    this.push(bucket, "metrics", bucket.metrics, record, MAX_METRICS_PER_POD);
  }

  async addEvent(record: EventRecord): Promise<void> {
    const bucket = this.bucket(record.pod);
    this.push(bucket, "events", bucket.events, record, MAX_EVENTS_PER_POD);
  }

  async addConnection(record: ConnectionRecord): Promise<void> {
    const bucket = this.bucket(record.pod);
    this.push(
      bucket,
      "connections",
      bucket.connections,
      record,
      MAX_CONNECTIONS_PER_POD,
    );
  }

  // 지워진 Pod는 Pod마다 몇 번 되지 않으므로(같은 이름으로 다시 만들 때만) 상한을 두지 않습니다.
  async addDeletedPod(record: DeletedPodRecord): Promise<void> {
    this.bucket(record.pod).deletions.push(record);
  }

  async addStatusChange(record: StatusChangeRecord): Promise<void> {
    const bucket = this.bucket(record.pod);
    this.push(
      bucket,
      "statusChanges",
      bucket.statusChanges,
      record,
      MAX_STATUS_CHANGES_PER_POD,
    );
  }

  async addKubeEvent(record: KubeEventRecord): Promise<void> {
    const bucket = this.bucket(record.pod);
    const index = bucket.kubeEvents.findIndex(
      (item) => item.uid === record.uid,
    );
    if (index >= 0) {
      bucket.kubeEvents.splice(index, 1);
    }
    this.push(
      bucket,
      "kubeEvents",
      bucket.kubeEvents,
      record,
      MAX_KUBE_EVENTS_PER_POD,
    );
  }

  async addAction(record: ActionRecord): Promise<void> {
    this.actionRecords.push(record);
    const over = this.actionRecords.length - MAX_ACTIONS;
    if (over <= 0) {
      return;
    }
    this.actionRecords.splice(0, over);
    if (this.droppedActions === 0) {
      log.warn("records dropped", { kind: "actions", limit: MAX_ACTIONS });
    }
    this.droppedActions += over;
  }

  async actions(query: ActionQuery = {}): Promise<ActionRecord[]> {
    const { namespace, pod } = query;
    return this.actionRecords
      .filter(
        (record) =>
          (namespace === undefined || record.target.namespace === namespace) &&
          // Pod를 주면 그 Pod가 대상인 조치만입니다. 스케일 조정(Deployment 대상)은 뺍니다(docs/guides/T24.md 결정 14).
          (pod === undefined ||
            (record.target.kind === "pod" &&
              record.target.namespace === pod.namespace &&
              record.target.name === pod.name)),
      )
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  async podRecords(pod: PodRef, since: number): Promise<PodRecords> {
    const bucket = this.buckets.get(podKey(pod));
    if (bucket === undefined) {
      return {
        metrics: [],
        events: [],
        connections: [],
        deletions: [],
        statusChanges: [],
        kubeEvents: [],
      };
    }
    return {
      metrics: bucket.metrics.filter((record) => record.receivedAt >= since),
      // sort는 안정 정렬이라 ts가 같으면 받은 순서가 남습니다.
      events: bucket.events
        .filter((record) => record.receivedAt >= since)
        .sort((a, b) => a.ts - b.ts),
      connections: bucket.connections.filter((record) => record.at >= since),
      deletions: bucket.deletions.filter((record) => record.deletedAt >= since),
      statusChanges: bucket.statusChanges.filter(
        (record) => record.at >= since,
      ),
      kubeEvents: bucket.kubeEvents
        .filter((record) => record.receivedAt >= since)
        .sort((a, b) => a.lastAt - b.lastAt),
    };
  }

  async deletedPods(since: number): Promise<DeletedPodRecord[]> {
    const deletions: DeletedPodRecord[] = [];
    for (const bucket of this.buckets.values()) {
      for (const record of bucket.deletions) {
        if (record.deletedAt >= since) {
          deletions.push(record);
        }
      }
    }
    return deletions.sort((a, b) => a.deletedAt - b.deletedAt);
  }

  async statusChanges(
    since: number,
    namespace?: string,
  ): Promise<StatusChangeRecord[]> {
    const changes: StatusChangeRecord[] = [];
    for (const bucket of this.buckets.values()) {
      if (namespace !== undefined && bucket.pod.namespace !== namespace) {
        continue;
      }
      for (const record of bucket.statusChanges) {
        if (record.at >= since) {
          changes.push(record);
        }
      }
    }
    // 같은 시각(같은 판단 주기)이면 Pod를 넣은 순서가 남습니다(안정 정렬).
    return changes.sort((a, b) => a.at - b.at);
  }

  async stats(): Promise<StoreStats> {
    const stats: StoreStats = {
      pods: this.buckets.size,
      metrics: 0,
      events: 0,
      connections: 0,
      deletedPods: 0,
      statusChanges: 0,
      kubeEvents: 0,
      actions: this.actionRecords.length,
      droppedMetrics: this.dropped.metrics,
      droppedEvents: this.dropped.events,
      droppedConnections: this.dropped.connections,
      droppedStatusChanges: this.dropped.statusChanges,
      droppedKubeEvents: this.dropped.kubeEvents,
      droppedActions: this.droppedActions,
    };
    for (const bucket of this.buckets.values()) {
      stats.metrics += bucket.metrics.length;
      stats.events += bucket.events.length;
      stats.connections += bucket.connections.length;
      stats.deletedPods += bucket.deletions.length;
      stats.statusChanges += bucket.statusChanges.length;
      stats.kubeEvents += bucket.kubeEvents.length;
    }
    return stats;
  }

  async prune(before: number): Promise<PruneResult> {
    const expiredPods: PodRef[] = [];
    for (const [key, bucket] of this.buckets) {
      dropBefore(bucket.metrics, (record) => record.receivedAt, before);
      dropBefore(bucket.events, (record) => record.receivedAt, before);
      dropBefore(bucket.connections, (record) => record.at, before);
      dropBefore(bucket.deletions, (record) => record.deletedAt, before);
      dropBefore(bucket.statusChanges, (record) => record.at, before);
      dropBefore(bucket.kubeEvents, (record) => record.receivedAt, before);
      if (
        bucket.metrics.length === 0 &&
        bucket.events.length === 0 &&
        bucket.connections.length === 0 &&
        bucket.deletions.length === 0 &&
        bucket.statusChanges.length === 0 &&
        bucket.kubeEvents.length === 0
      ) {
        this.buckets.delete(key);
        expiredPods.push(bucket.pod);
      }
    }
    return { expiredPods };
  }

  async close(): Promise<void> {
    this.buckets.clear();
    this.actionRecords.length = 0;
  }

  private bucket(pod: PodRef): Bucket {
    const key = podKey(pod);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        pod: { namespace: pod.namespace, name: pod.name },
        metrics: [],
        events: [],
        connections: [],
        deletions: [],
        statusChanges: [],
        kubeEvents: [],
        warned: new Set(),
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  // 넣고, 상한을 넘으면 오래된 것부터 버립니다. Pod마다 기록 종류별로 처음 한 번만 경고합니다.
  private push<T>(
    bucket: Bucket,
    kind: LimitedKind,
    list: T[],
    record: T,
    limit: number,
  ): void {
    list.push(record);
    const over = list.length - limit;
    if (over <= 0) {
      return;
    }
    list.splice(0, over);
    this.dropped[kind] += over;
    if (!bucket.warned.has(kind)) {
      bucket.warned.add(kind);
      log.warn("records dropped", { pod: podLabel(bucket.pod), kind, limit });
    }
  }
}

// 넣은 순서로 든 배열에서 before보다 이른 앞부분을 지웁니다.
function dropBefore<T>(
  list: T[],
  timeOf: (record: T) => number,
  before: number,
): void {
  let index = 0;
  while (index < list.length && timeOf(list[index] as T) < before) {
    index += 1;
  }
  if (index > 0) {
    list.splice(0, index);
  }
}
