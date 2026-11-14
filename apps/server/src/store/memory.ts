// 메모리 저장소입니다(GLASSPOD_STORE=memory, 기본). 서버가 다시 시작되면 사라집니다.
// Pod마다 기록 종류별 배열을 들고, 상한을 넘으면 오래된 것부터 버립니다(docs/guides/T11.md 결정 2, 17).
import type { PodRef } from "@glasspod/protocol";
import { log } from "../log.js";
import { podKey, podLabel } from "../pod-key.js";
import type {
  ConnectionRecord,
  DeletedPodRecord,
  EventRecord,
  MetricsRecord,
  PodRecords,
  PruneResult,
  Store,
  StoreStats,
} from "./store.js";

// Pod 하나에 들고 있는 기록 수의 상한입니다. 지표는 주기 하한(1초)이면 30분에 1,800건입니다.
export const MAX_METRICS_PER_POD = 2_000;
export const MAX_EVENTS_PER_POD = 500;
export const MAX_CONNECTIONS_PER_POD = 500;

type LimitedKind = "metrics" | "events" | "connections";

interface Bucket {
  pod: PodRef;
  // 모두 넣은 순서(받은 시각 순서)입니다.
  metrics: MetricsRecord[];
  events: EventRecord[];
  connections: ConnectionRecord[];
  deletions: DeletedPodRecord[];
  // 상한을 넘었다고 이미 경고한 기록 종류입니다.
  warned: Set<LimitedKind>;
}

export class MemoryStore implements Store {
  readonly kind = "memory";
  private readonly buckets = new Map<string, Bucket>();
  private readonly dropped: Record<LimitedKind, number> = {
    metrics: 0,
    events: 0,
    connections: 0,
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

  async podRecords(pod: PodRef, since: number): Promise<PodRecords> {
    const bucket = this.buckets.get(podKey(pod));
    if (bucket === undefined) {
      return { metrics: [], events: [], connections: [], deletions: [] };
    }
    return {
      metrics: bucket.metrics.filter((record) => record.receivedAt >= since),
      // sort는 안정 정렬이라 ts가 같으면 받은 순서가 남습니다.
      events: bucket.events
        .filter((record) => record.receivedAt >= since)
        .sort((a, b) => a.ts - b.ts),
      connections: bucket.connections.filter((record) => record.at >= since),
      deletions: bucket.deletions.filter((record) => record.deletedAt >= since),
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

  async stats(): Promise<StoreStats> {
    const stats: StoreStats = {
      pods: this.buckets.size,
      metrics: 0,
      events: 0,
      connections: 0,
      deletedPods: 0,
      droppedMetrics: this.dropped.metrics,
      droppedEvents: this.dropped.events,
      droppedConnections: this.dropped.connections,
    };
    for (const bucket of this.buckets.values()) {
      stats.metrics += bucket.metrics.length;
      stats.events += bucket.events.length;
      stats.connections += bucket.connections.length;
      stats.deletedPods += bucket.deletions.length;
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
      if (
        bucket.metrics.length === 0 &&
        bucket.events.length === 0 &&
        bucket.connections.length === 0 &&
        bucket.deletions.length === 0
      ) {
        this.buckets.delete(key);
        expiredPods.push(bucket.pod);
      }
    }
    return { expiredPods };
  }

  async close(): Promise<void> {
    this.buckets.clear();
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
