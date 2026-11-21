// 조치 API입니다(docs/guides/T21.md 결정 5, 11). 조치 실행은 POST, 기록은 GET입니다.
import type {
  ActionBody,
  ActionRequest,
  ActionsBody,
} from "@glasspod/protocol";
import { getJson, postJson } from "./client.js";
import type { ApiResult } from "./client.js";

export function actionsPath(namespace?: string): string {
  return namespace === undefined
    ? "/api/actions"
    : `/api/actions?${new URLSearchParams({ namespace }).toString()}`;
}

// 조치를 실행합니다. 서버가 쿠버네티스의 답을 받을 때까지(최대 10초) 걸릴 수 있습니다.
export function runAction(
  request: ActionRequest,
): Promise<ApiResult<ActionBody>> {
  return postJson<ActionBody>("/api/actions", request);
}

// 서버가 남긴 조치 기록 전부입니다(요청한 순서).
export function getActions(
  namespace?: string,
  signal?: AbortSignal,
): Promise<ApiResult<ActionsBody>> {
  return getJson<ActionsBody>(actionsPath(namespace), signal);
}
