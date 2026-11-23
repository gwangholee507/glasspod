// 서버 HTTP API의 본문 타입입니다. 서버가 만들고 웹 화면이 읽습니다(docs/guides/T17.md 결정 13).
// SDK–서버 메시지와 달리 JSON Schema 없이 손으로 쓴 타입입니다. 같은 저장소의 서버와 웹만 씁니다.
import type {
  EventLevel,
  MetricKind,
  PodRef,
} from "./generated/sdk-message.js";
import type { SnapshotData } from "./generated/snapshot.js";

// 실패했을 때의 공통 본문입니다. error는 짧은 코드, detail은 사람이 읽는 설명입니다.
export interface ApiErrorBody {
  error: string;
  detail: string;
}

// 조회 API(docs/guides/T14.md 결정 6)의 오류 코드입니다.
// pod-not-found: 판단이 없는 Pod, invalid-query: 잘못된 쿼리(namespace), not-found: 없는 /api 경로,
// too-many-streams: SSE 연결 상한, internal-error: 서버 예외
export type QueryErrorCode =
  | "pod-not-found"
  | "invalid-query"
  | "not-found"
  | "too-many-streams"
  | "internal-error";

// GET /api/pods/:namespace/:name/snapshot 의 오류 코드입니다(docs/guides/T09.md 'HTTP 상태 코드').
// pod-not-found는 SDK 연결도 판단도 없는 Pod입니다(T14). 판단이 있으면 not-connected입니다.
export type SnapshotErrorCode =
  | "pod-not-found"
  | "not-connected"
  | "not-supported"
  | "busy"
  | "no-response"
  | "disconnected"
  | "sdk-error"
  | "invalid-response";

export interface SnapshotErrorBody extends ApiErrorBody {
  error: SnapshotErrorCode;
}

// 서버가 Pod마다 내리는 판단입니다(design.md 7.5, docs/guides/T13.md '판단 표'). 한 Pod에 여럿이 맞으면 앞쪽이 먼저입니다.
export type PodStatus =
  | "terminated"
  | "pod-failing"
  | "stalled"
  | "disconnected"
  | "restarted"
  | "not-ready"
  | "starting"
  | "no-sdk"
  | "ok";

// 판단마다 정해진 강조 수준입니다. 화면은 warning과 critical을 강조합니다.
export type PodSeverity = "none" | "warning" | "critical";

// snapshot을 받았을 때의 본문입니다. ts는 SDK가 답을 보낸 시각(SDK 시계), elapsedMs는 서버가 보낸 때부터 받을 때까지입니다.
export interface SnapshotBody {
  pod: PodRef;
  instanceId: string;
  ts: number;
  elapsedMs: number;
  snapshot: SnapshotData;
}

// ── 웹 화면용 조회 API(docs/guides/T14.md) ──
// 시각은 모두 epoch ms입니다. 따로 적지 않으면 서버 시계이고, ts만 SDK 시계입니다.
// 성공 본문의 serverTime은 응답을 만든 서버 시각입니다. 화면은 '몇 초째'를 이것으로 셉니다.

// 30분 안의 재시작입니다(docs/guides/T13.md 결정 7, 8).
export interface PodRestart {
  // 쿠버네티스가 알린 직전 컨테이너의 종료 시각, 없으면 새 instance가 붙은 시각입니다.
  at: number;
  // 쿠버네티스가 알린 종료 이유와 종료 코드입니다(예: OOMKilled 137).
  reason?: string;
  exitCode?: number;
  // SDK가 새 instance로 다시 붙어 알게 된 직전 instance입니다.
  previousInstanceId?: string;
}

export interface PodTermination {
  container: string;
  reason: string;
  exitCode: number;
  // 쿠버네티스가 준 ISO 8601 문자열입니다.
  finishedAt?: string;
}

// 트래픽에서 뺀(격리한) Pod의 정보입니다(docs/guides/T23.md 결정 5, 12). 서버가 Pod의 라벨·주석에서 읽습니다.
// 표시 라벨(glasspod/isolated=true)이 있으면 격리된 Pod이고, 주석이 없거나 깨졌으면 그 필드만 없습니다.
export interface PodIsolation {
  // 격리한 시각(서버 시계)입니다.
  at?: number;
  // 뗀 라벨입니다(키 → 그때 값).
  labels: Record<string, string>;
  // 격리할 때의 판단입니다.
  status?: PodStatus;
  // 격리할 때 이 Pod를 관리하던 Deployment와 ReplicaSet입니다.
  deployment?: string;
  replicaSet?: string;
  actor?: ActionActor;
}

// 쿠버네티스 Pod 요약입니다(docs/guides/T12.md '요약'). 쿠버네티스에 없는 Pod는 항목에 없습니다.
export interface PodKube {
  uid: string;
  phase: string;
  ready: boolean;
  terminating: boolean;
  restarts: number;
  waiting?: string;
  lastTermination?: PodTermination;
  ip?: string;
  replicaSet?: string;
  // 쿠버네티스가 준 ISO 8601 문자열입니다.
  createdAt?: string;
  // 트래픽에서 뺀 Pod만 있습니다(T23).
  isolation?: PodIsolation;
}

// SDK 쪽 지금 상태입니다(docs/guides/T11.md). SDK가 붙은 적이 없는 Pod는 항목에 없습니다.
export interface PodSdk {
  connected: boolean;
  instanceId: string;
  // 예: node@0.1.0
  sdk: string;
  app?: { name: string; version?: string };
  // 이 instance가 처음 붙은 시각입니다.
  instanceSince: number;
  connectedAt: number;
  disconnectedAt?: number;
  // 지금 연결에서 마지막으로 metrics를 받은 시각입니다. 아직 없으면 없습니다.
  lastMetricsAt?: number;
  // 이 instance에서 seq 빈틈으로 빠진 메시지 수입니다.
  missed: number;
}

// 목록에 보이는 지표입니다(design.md 5.3). 그 지표를 받지 못했으면 필드가 없습니다.
export interface PodListMetrics {
  // runtime.event_loop.lag_p99_ms 마지막 값
  eventLoopP99Ms?: number;
  // runtime.heap.used_bytes, runtime.heap.limit_bytes 마지막 값
  heapUsedBytes?: number;
  heapLimitBytes?: number;
  // http.requests.duration_p99_ms 마지막 값
  httpP99Ms?: number;
  // http.requests.errors_total의 최근 60초 증가량 합(서버가 받은 시각 기준)
  http5xxPerMinute?: number;
}

// 목록의 Pod 항목입니다. 판단 주기(1초)마다 다시 만들고, 바뀌면 SSE로 보냅니다.
export interface PodItem {
  pod: PodRef;
  // Pod를 만든 Deployment입니다. 쿠버네티스에서 지워진 Pod는 앞에서 알던 값입니다.
  deployment?: string;
  status: PodStatus;
  severity: PodSeverity;
  // 판단의 근거입니다(docs/guides/T13.md '판단 표').
  reason?: string;
  // 지금 판단이 시작된 시각입니다.
  since: number;
  restart?: PodRestart;
  kube?: PodKube;
  sdk?: PodSdk;
  metrics: PodListMetrics;
}

// 쿠버네티스 Deployment 요약입니다.
export interface DeploymentItem {
  namespace: string;
  name: string;
  desired: number;
  ready: number;
  available: number;
}

// GET /api/pods 본문이자 SSE의 pods 이벤트입니다.
export interface PodListBody {
  serverTime: number;
  // 거르지 않은 전체입니다. GLASSPOD_NAMESPACES 순서, 그 뒤 판단에만 있는 namespace를 이름순으로 둡니다.
  namespaces: string[];
  // 조치할 수 있는 namespace입니다(GLASSPOD_ACTION_NAMESPACES, docs/guides/T21.md 결정 2, 12). 비면 조치가 꺼져 있습니다.
  actionNamespaces: string[];
  deployments: DeploymentItem[];
  pods: PodItem[];
}

// 판단이 바뀐 기록입니다. 서버가 처음 판단한 Pod는 previous가 없습니다.
export interface PodStatusChange {
  pod: PodRef;
  at: number;
  status: PodStatus;
  severity: PodSeverity;
  reason?: string;
  previous?: PodStatus;
  deployment?: string;
}

// GET /api/status-changes 본문입니다. 최근 30분, 일어난 순서입니다.
export interface StatusChangesBody {
  serverTime: number;
  changes: PodStatusChange[];
}

// 지표의 마지막 값입니다.
export interface PodMetricValue {
  name: string;
  kind: MetricKind;
  value: number;
  // SDK가 보낸 시각(SDK 시계)과 서버가 받은 시각입니다.
  ts: number;
  receivedAt: number;
}

// SDK가 보낸 event입니다(design.md 7.3 event).
export interface PodEvent {
  instanceId: string;
  seq: number;
  // 일어난 시각(SDK 시계)과 서버가 받은 시각입니다.
  ts: number;
  receivedAt: number;
  level: EventLevel;
  name: string;
  message?: string;
  count: number;
  data?: Record<string, unknown>;
}

// SDK 연결 기록입니다(docs/guides/T11.md).
export interface PodConnection {
  instanceId: string;
  change: "connected" | "disconnected";
  at: number;
  // connected만: 직전에 본 instance와 다르면 true입니다. 서버가 처음 보는 Pod면 없습니다.
  newInstance?: boolean;
  sdk?: string;
  app?: { name: string; version?: string };
  // disconnected만: WebSocket 종료 코드입니다.
  code?: number;
}

// 쿠버네티스가 Pod에 대해 남긴 Event(core/v1)입니다(docs/guides/T19.md 결정 8). 같은 Event는 count만 늘어납니다.
export interface PodKubeEvent {
  uid: string;
  // Normal 또는 Warning입니다.
  type: string;
  reason: string;
  message?: string;
  count: number;
  // 쿠버네티스 시계입니다. 처음 일어난 시각(없을 수 있음)과 마지막으로 일어난 시각입니다.
  firstAt?: number;
  lastAt: number;
}

// GET /api/pods/:namespace/:name 본문입니다. 기록은 최근 30분입니다.
export interface PodDetailBody {
  serverTime: number;
  item: PodItem;
  // 지금 instance의 마지막 값 전부, 이름순입니다.
  values: PodMetricValue[];
  // 모든 instance의 event, 일어난 순서입니다.
  events: PodEvent[];
  // 재시작 원인 후보입니다. 직전 instance의 event를 error 먼저, 같은 수준은 늦은 것부터 5개(docs/guides/T13.md 결정 9).
  restartCauses: PodEvent[];
  connections: PodConnection[];
  statusChanges: PodStatusChange[];
  // 이 Pod에 대한 쿠버네티스 Event입니다. 마지막으로 일어난 순서입니다(T19).
  kubeEvents: PodKubeEvent[];
  // 이 Pod(namespace·이름)에 한 조치 전부입니다. 30분이 아니라 서버가 남긴 만큼이고, 요청한 순서입니다(T21 결정 11).
  actions: ActionItem[];
}

// ── 그래프용 시계열(docs/guides/T19.md 결정 5, 6) ──

// 요청한 지표입니다. 어느 Pod도 그 지표를 보내지 않았으면 kind가 없습니다.
export interface SeriesMetric {
  name: string;
  kind?: MetricKind;
}

// Pod 하나의 시계열입니다. values[i][j]는 metrics[i]의 times[j] 값입니다.
// 그 기록에 없는 지표는 null입니다. 끊긴 곳(instance가 바뀜, 또는 3주기보다 오래 빔)에는 값이 모두 null인 시각이 하나 들어 있습니다.
// counter는 같은 instance의 앞 점과 견준 초당 증가량이고, 앞 점이 없거나 리셋이면 null입니다.
export interface PodMetricSeries {
  pod: PodRef;
  // 서버가 받은 시각, 오래된 것부터입니다.
  times: number[];
  values: (number | null)[][];
}

// GET /api/pods/:namespace/:name/series?metrics=a,b 본문입니다.
export interface MetricSeriesBody {
  serverTime: number;
  // 기간의 시작(서버 시계)입니다. serverTime - 30분입니다.
  since: number;
  metrics: SeriesMetric[];
  // 이 Pod가 맨 앞, 그 뒤 같은 Deployment의 다른 Pod(이름순, 10개까지)입니다.
  pods: PodMetricSeries[];
}

// SSE(GET /api/stream)의 이벤트 이름입니다. 처음에 pods 한 번, 그 뒤 바뀐 것이 있을 때마다 changes입니다.
export type PodStreamEvent = "pods" | "changes";

// SSE의 changes 이벤트입니다. 한 판단 주기의 변화를 한 번에 보냅니다.
export interface PodListChanges {
  serverTime: number;
  // 새로 생겼거나 바뀐 항목입니다. 같은 Pod의 항목을 통째로 바꿉니다.
  pods: PodItem[];
  removedPods: PodRef[];
  deployments: DeploymentItem[];
  removedDeployments: PodRef[];
  statusChanges: PodStatusChange[];
  // 앞 주기 뒤에 끝난 조치입니다(docs/guides/T21.md 결정 12). 요청한 순서입니다.
  actions: ActionItem[];
  // namespace 목록이 바뀌었을 때만 있습니다.
  namespaces?: string[];
}

// ── 조치(docs/guides/T21.md) ──

// 조치 종류입니다. 스케일 조정(T24)을 여기에 더합니다.
// restart-pod: Pod 재시작(삭제 → 컨트롤러가 새로 만듦), isolate-pod: 트래픽에서 빼기(T23), delete-pod: 격리된 Pod 삭제(T23)
export type ActionKind = "restart-pod" | "isolate-pod" | "delete-pod";

// 조치 요청 본문이 틀렸을 때의 오류 코드입니다. 이 요청은 기록하지 않습니다.
// invalid-request: 본문이 JSON이 아니거나 모양이 틀림, 모르는 조치, Content-Type이 JSON이 아님(415)
export type ActionRequestErrorCode = "invalid-request";

// 기록하는 실패의 오류 코드입니다(결정 6). 검사하는 순서대로 적었습니다.
export type ActionErrorCode =
  | "action-not-allowed"
  | "kube-unavailable"
  | "target-not-found"
  | "target-changed"
  | "target-terminating"
  // T23: 격리된 Pod에 재시작·트래픽에서 빼기, 격리되지 않은 Pod에 삭제, 뗄 라벨을 정하지 못함
  | "target-isolated"
  | "target-not-isolated"
  | "cannot-isolate"
  | "action-in-progress"
  | "kube-forbidden"
  | "kube-error"
  | "kube-timeout";

export interface ActionErrorBody extends ApiErrorBody {
  error: ActionRequestErrorCode | ActionErrorCode;
}

// 조치를 실행한 쪽입니다. 화면에서 누른 조치는 user('개발자'), 자동 규칙(T28)은 rule입니다(결정 4).
export type ActionActor = { kind: "user" } | { kind: "rule"; name: string };

// 조치 대상입니다. uid는 화면이 확인한 Pod의 uid(expectedUid)입니다. 스케일(T24)은 Deployment 대상을 더합니다.
export interface ActionTarget {
  kind: "pod";
  namespace: string;
  name: string;
  uid: string;
}

export type ActionResult = "succeeded" | "failed";

// 조치 기록입니다(결정 10). 서버 저장소도 이 모양 그대로 남깁니다.
export interface ActionItem {
  // 서버가 만든 UUID입니다.
  id: string;
  action: ActionKind;
  target: ActionTarget;
  actor: ActionActor;
  // 서버가 요청을 받은 시각과 결과가 정해진 시각입니다.
  requestedAt: number;
  finishedAt: number;
  result: ActionResult;
  // 실패만: 오류 코드, 서버나 쿠버네티스가 준 설명(200자까지), 쿠버네티스가 답한 HTTP 상태 코드입니다.
  error?: ActionErrorCode;
  detail?: string;
  kubeStatus?: number;
  // 재시작·트래픽에서 빼기: 실행할 때 그 Pod를 관리하던 ReplicaSet과 Deployment입니다.
  replicaSet?: string;
  deployment?: string;
  // 트래픽에서 빼기 성공: 실제로 뗀 라벨과 이 Pod를 고르던 Service입니다(T23 결정 11).
  isolation?: { labels: Record<string, string>; services: string[] };
}

// 트래픽에서 빼기의 계획입니다(T23 결정 6, 10). 실행할 때도 같은 규칙으로 다시 계산합니다.
export interface IsolationPlan {
  // 뗄 라벨입니다(키 → 지금 값).
  labels: Record<string, string>;
  // 이 Pod를 고르는 Service입니다. 이름순입니다.
  services: string[];
  // 대신할 Pod를 만들 ReplicaSet과 그 Deployment입니다. 컨트롤러가 없는 Pod면 없습니다.
  replicaSet?: string;
  deployment?: string;
}

// GET /api/pods/:namespace/:name/isolation-plan 성공 본문입니다. uid는 계산할 때 읽은 Pod의 uid입니다.
export interface IsolationPlanBody {
  serverTime: number;
  pod: PodRef;
  uid: string;
  plan: IsolationPlan;
}

// POST /api/actions 본문입니다.
export interface ActionRequest {
  action: ActionKind;
  target: { namespace: string; name: string };
  // 화면이 확인한 대상 Pod의 uid입니다(결정 7). 지금 uid와 다르면 409 target-changed입니다.
  expectedUid: string;
}

// POST /api/actions 성공 본문입니다.
export interface ActionBody {
  serverTime: number;
  action: ActionItem;
}

// GET /api/actions 본문입니다. 서버가 남긴 전부(최근 1,000건), 요청한 순서입니다(결정 3, 11).
export interface ActionsBody {
  serverTime: number;
  actions: ActionItem[];
}
