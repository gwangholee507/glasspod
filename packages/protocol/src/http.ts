// 서버 HTTP API의 본문 타입입니다. 서버가 만들고 웹 화면이 읽습니다(docs/guides/T17.md 결정 13).
// SDK–서버 메시지와 달리 JSON Schema 없이 손으로 쓴 타입입니다. 같은 저장소의 서버와 웹만 씁니다.
import type { PodRef } from "./generated/sdk-message.js";
import type { SnapshotData } from "./generated/snapshot.js";

// 실패했을 때의 공통 본문입니다. error는 짧은 코드, detail은 사람이 읽는 설명입니다.
export interface ApiErrorBody {
  error: string;
  detail: string;
}

// GET /api/pods/:namespace/:name/snapshot 의 오류 코드입니다(docs/guides/T09.md 'HTTP 상태 코드').
export type SnapshotErrorCode =
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
