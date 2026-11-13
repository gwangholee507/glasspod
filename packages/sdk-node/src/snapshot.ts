// 서버의 request에 답할 내용을 만듭니다(design.md 7.3 request / response, docs/guides/T09.md).
// v1의 요청은 snapshot 하나입니다. 상태 값, 진행 중인 요청과 경과 시간, 프로세스 정보를 돌려줍니다.
// 정보 조회만 합니다. 앱 상태를 바꾸는 요청은 만들지 않습니다.
import type { ResponseMessage, SnapshotData } from "@glasspod/protocol";
import type { InFlightRequest } from "./http.js";
import { debug, describeError } from "./log.js";
import { truncate } from "./reports.js";

// 이 SDK가 답할 수 있는 action입니다. hello의 capabilities로 보냅니다.
export const SUPPORTED_ACTIONS: readonly string[] = ["snapshot"];
// 모르는 action을 error 문구에 넣을 때의 글자 수 상한입니다.
const MAX_ACTION_CHARS = 100;

// response 메시지에서 seq, ts, replyTo를 뺀 내용입니다.
export type ResponseContent = Pick<ResponseMessage, "ok" | "data" | "error">;

// snapshot에 넣을 값을 읽는 곳입니다. index.ts가 상태 저장소와 HTTP 집계를 넘깁니다.
export interface SnapshotSources {
  states: () => Record<string, string>;
  inFlight: () => InFlightRequest[];
}

// 지금 snapshot을 만듭니다. 가볍고 동기로 끝납니다.
export function buildSnapshot(sources: SnapshotSources): SnapshotData {
  return {
    state: sources.states(),
    inFlight: sources.inFlight(),
    process: {
      // 초 단위 실수입니다. 소수 셋째 자리(ms)까지 보냅니다.
      uptimeSec: Math.round(process.uptime() * 1000) / 1000,
      heapUsedBytes: process.memoryUsage().heapUsed,
    },
  };
}

// request의 action에 맞는 답을 만듭니다. 모르는 action이거나 만들다 실패하면 ok: false입니다.
export function answerRequest(
  action: string,
  snapshot: () => SnapshotData,
): ResponseContent {
  if (action !== "snapshot") {
    return {
      ok: false,
      error: `unknown action: ${JSON.stringify(truncate(action, MAX_ACTION_CHARS))}`,
    };
  }
  try {
    return { ok: true, data: { ...snapshot() } };
  } catch (error) {
    // 내부 오류 내용은 서버로 보내지 않고 디버그 로그에만 남깁니다.
    debug(`snapshot failed: ${describeError(error)}`);
    return { ok: false, error: "snapshot failed" };
  }
}

// 디버그 로그에 쓸 한 줄입니다. 예: ok=true inFlight=2, ok=false error="snapshot failed"
export function describeAnswer(content: ResponseContent): string {
  if (!content.ok) {
    return `ok=false error=${JSON.stringify(content.error)}`;
  }
  const inFlight = content.data?.["inFlight"];
  return `ok=true inFlight=${Array.isArray(inFlight) ? inFlight.length : 0}`;
}
