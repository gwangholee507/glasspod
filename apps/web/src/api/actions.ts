// 조치 API입니다(docs/guides/T21.md 결정 5, 11). 조치 실행은 POST, 기록은 GET입니다.
// 트래픽에서 빼기 미리 보기도 여기 있습니다(docs/guides/T23.md 결정 10).
import type {
  ActionBody,
  ActionRequest,
  ActionsBody,
  IsolationPlanBody,
  PodRef,
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

// 트래픽에서 빼면 뗄 라벨과 빠질 Service입니다. 서버가 쿠버네티스에서 읽으므로 몇 초 걸릴 수 있습니다.
export function getIsolationPlan(
  pod: PodRef,
  signal?: AbortSignal,
): Promise<ApiResult<IsolationPlanBody>> {
  return getJson<IsolationPlanBody>(
    `/api/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}/isolation-plan`,
    signal,
  );
}
