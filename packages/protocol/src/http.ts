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

// snapshot을 받았을 때의 본문입니다. ts는 SDK가 답을 보낸 시각(SDK 시계), elapsedMs는 서버가 보낸 때부터 받을 때까지입니다.
export interface SnapshotBody {
  pod: PodRef;
  instanceId: string;
  ts: number;
  elapsedMs: number;
  snapshot: SnapshotData;
}
