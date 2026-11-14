// 서버가 SDK에서 받은 기록과 지워진 Pod를 보관하는 저장소의 인터페이스입니다(design.md 3장 '서버 데이터 보관').
// 어댑터는 운영자가 GLASSPOD_STORE로 고릅니다. 1차 범위는 메모리 어댑터(memory.ts)뿐입니다.
// DB 어댑터(T32)도 붙일 수 있게 모든 메서드는 Promise를 돌려줍니다. 규칙은 docs/guides/T11.md에 있습니다.
// 저장소는 받은 기록을 고치지 않고, 돌려준 기록도 부르는 쪽이 고치지 않습니다.
import type { EventLevel, MetricKind, PodRef } from "@glasspod/protocol";
import type { PodSummary } from "../cluster.js";

// GLASSPOD_STORE가 받는 값입니다. postgres는 T32에서 더합니다.
export const STORE_KINDS = ["memory"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

// 기록을 들고 있는 시간입니다. 서버가 받은 시각(지워진 Pod는 지워진 시각)부터 셉니다.
export const RETENTION_MS = 30 * 60_000;

export interface StoredMetric {
  name: string;
  kind: MetricKind;
  value: number;
  // counter만 있습니다. 같은 Pod의 앞 점 뒤로 늘어난 양입니다. 앞 점이 없으면(서버가 처음 받은 값) 없습니다.
  increase?: number;
  // counter가 리셋됐으면(값이 줄었거나 instance가 바뀜) true입니다. 이때 increase는 지금 값(0부터 셈)입니다.
  reset?: true;
}

export interface MetricsRecord {
  pod: PodRef;
  instanceId: string;
  seq: number;
  // SDK가 보낸 시각(SDK 시계)입니다.
  ts: number;
  // 서버가 받은 시각입니다. 30분은 이것으로 셉니다.
  receivedAt: number;
  values: StoredMetric[];
}

export interface EventRecord {
  pod: PodRef;
  instanceId: string;
  seq: number;
  // 일어난 시각(SDK 시계)입니다. 다시 연결한 뒤 보낸 event는 receivedAt보다 한참 이를 수 있습니다(T08).
  ts: number;
  receivedAt: number;
  level: EventLevel;
  name: string;
  message?: string;
  count: number;
  data?: Record<string, unknown>;
}

export interface ConnectionRecord {
  pod: PodRef;
  instanceId: string;
  change: "connected" | "disconnected";
  // 서버 시각입니다.
  at: number;
  // connected만: 직전에 본 instance와 다르면 true, 같으면(다시 연결) false. 서버가 처음 보는 Pod면 없습니다.
  newInstance?: boolean;
  // connected만: hello의 SDK(예: node@0.1.0)와 앱입니다.
  sdk?: string;
  app?: { name: string; version?: string };
  // disconnected만: WebSocket 종료 코드입니다.
  code?: number;
}

export interface DeletedPodRecord {
  // 지워질 때의 Pod 요약(T12)입니다. 마지막 종료 이유가 들어 있습니다.
  pod: PodSummary;
  deletedAt: number;
}

export interface PodRecords {
  // 받은 순서입니다.
  metrics: MetricsRecord[];
  // 일어난 순서(ts)입니다. ts가 같으면 받은 순서입니다.
  events: EventRecord[];
  connections: ConnectionRecord[];
  deletions: DeletedPodRecord[];
}

export interface StoreStats {
  // 기록이 하나라도 있는 Pod 수입니다.
  pods: number;
  metrics: number;
  events: number;
  connections: number;
  deletedPods: number;
  // 상한을 넘어 버린 수입니다(서버가 시작된 뒤 누적).
  droppedMetrics: number;
  droppedEvents: number;
  droppedConnections: number;
}

export interface PruneResult {
  // 이번 정리로 기록이 모두 지워진 Pod입니다.
  expiredPods: PodRef[];
}

export interface Store {
  readonly kind: StoreKind;
  addMetrics(record: MetricsRecord): Promise<void>;
  addEvent(record: EventRecord): Promise<void>;
  addConnection(record: ConnectionRecord): Promise<void>;
  addDeletedPod(record: DeletedPodRecord): Promise<void>;
  // since 이후(받은 시각, 연결은 at, 지워진 Pod는 deletedAt)의 Pod 하나의 기록입니다.
  podRecords(pod: PodRef, since: number): Promise<PodRecords>;
  // since 이후에 지워진 Pod입니다. 지워진 순서입니다.
  deletedPods(since: number): Promise<DeletedPodRecord[]>;
  stats(): Promise<StoreStats>;
  // before보다 이른 기록을 지웁니다.
  prune(before: number): Promise<PruneResult>;
  close(): Promise<void>;
}
