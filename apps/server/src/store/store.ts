// 서버가 SDK에서 받은 기록과 지워진 Pod를 보관하는 저장소의 인터페이스입니다(design.md 3장 '서버 데이터 보관').
// 어댑터는 운영자가 GLASSPOD_STORE로 고릅니다. 1차 범위는 메모리 어댑터(memory.ts)뿐입니다.
// DB 어댑터(T32)도 붙일 수 있게 모든 메서드는 Promise를 돌려줍니다. 규칙은 docs/guides/T11.md에 있습니다.
// 저장소는 받은 기록을 고치지 않고, 돌려준 기록도 부르는 쪽이 고치지 않습니다.
import type {
  ActionItem,
  EventLevel,
  MetricKind,
  PodRef,
  PodSeverity,
  PodStatus,
} from "@glasspod/protocol";
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

// 상태 판단이 바뀐 기록입니다(docs/guides/T14.md 결정 3, 4). 판단(status)이 바뀔 때와 서버가 처음 판단할 때 남습니다.
export interface StatusChangeRecord {
  pod: PodRef;
  // 서버 시각입니다.
  at: number;
  status: PodStatus;
  severity: PodSeverity;
  reason?: string;
  // 바로 앞 판단입니다. 서버가 처음 판단한 Pod면 없습니다.
  previous?: PodStatus;
  deployment?: string;
}

// 쿠버네티스가 Pod에 대해 남긴 Event(core/v1)입니다(docs/guides/T19.md 결정 8).
// 같은 Event(uid)가 다시 오면(횟수가 늘어남) 바꿔 끼웁니다.
export interface KubeEventRecord {
  pod: PodRef;
  uid: string;
  // Normal 또는 Warning입니다.
  type: string;
  reason: string;
  message?: string;
  count: number;
  // 쿠버네티스 시계입니다. 처음 일어난 시각(없을 수 있음)과 마지막으로 일어난 시각입니다.
  firstAt?: number;
  lastAt: number;
  // 서버가 마지막으로 받은 시각입니다. 30분은 이것으로 셉니다.
  receivedAt: number;
}

// 조치 기록입니다(docs/guides/T21.md 결정 3, 10). HTTP 본문과 같은 모양이라 그 타입을 그대로 씁니다.
// 30분 정리(prune)에서 빠지고, 서버 전체에서 최근 몇 건(메모리 어댑터는 1,000건)만 남깁니다.
export type ActionRecord = ActionItem;

// 조치 기록을 거르는 조건입니다. 둘 다 주면 둘 다 맞는 것만입니다.
export interface ActionQuery {
  namespace?: string;
  // 대상 Pod(namespace·이름)입니다. 주면 Pod가 대상인 조치만 돌려줍니다(T24).
  pod?: PodRef;
}

export interface PodRecords {
  // 받은 순서입니다.
  metrics: MetricsRecord[];
  // 일어난 순서(ts)입니다. ts가 같으면 받은 순서입니다.
  events: EventRecord[];
  connections: ConnectionRecord[];
  deletions: DeletedPodRecord[];
  // 일어난 순서(at)입니다.
  statusChanges: StatusChangeRecord[];
  // 마지막으로 일어난 순서(lastAt)입니다.
  kubeEvents: KubeEventRecord[];
}

export interface StoreStats {
  // 기록이 하나라도 있는 Pod 수입니다.
  pods: number;
  metrics: number;
  events: number;
  connections: number;
  deletedPods: number;
  statusChanges: number;
  kubeEvents: number;
  actions: number;
  // 상한을 넘어 버린 수입니다(서버가 시작된 뒤 누적).
  droppedMetrics: number;
  droppedEvents: number;
  droppedConnections: number;
  droppedStatusChanges: number;
  droppedKubeEvents: number;
  droppedActions: number;
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
  addStatusChange(record: StatusChangeRecord): Promise<void>;
  // 같은 Pod에 같은 uid의 기록이 있으면 바꿔 끼웁니다.
  addKubeEvent(record: KubeEventRecord): Promise<void>;
  addAction(record: ActionRecord): Promise<void>;
  // 남아 있는 조치 기록입니다. 요청한 순서(requestedAt)입니다.
  actions(query?: ActionQuery): Promise<ActionRecord[]>;
  // since 이후(받은 시각, 연결·판단 변화는 at, 지워진 Pod는 deletedAt)의 Pod 하나의 기록입니다.
  podRecords(pod: PodRef, since: number): Promise<PodRecords>;
  // since 이후에 지워진 Pod입니다. 지워진 순서입니다.
  deletedPods(since: number): Promise<DeletedPodRecord[]>;
  // since 이후의 판단 변화입니다. namespace를 주면 그 namespace의 Pod만. 일어난 순서(at)입니다.
  statusChanges(
    since: number,
    namespace?: string,
  ): Promise<StatusChangeRecord[]>;
  stats(): Promise<StoreStats>;
  // before보다 이른 기록을 지웁니다. 조치 기록은 지우지 않습니다.
  prune(before: number): Promise<PruneResult>;
  close(): Promise<void>;
}
