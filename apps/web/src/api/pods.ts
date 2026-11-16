// Pod에 대한 서버 API입니다. 목록·상세·판단 변화·SSE는 docs/guides/T14.md, snapshot은 docs/guides/T09.md에 있습니다.
import type {
  PodDetailBody,
  PodListBody,
  PodRef,
  SnapshotBody,
  StatusChangesBody,
} from "@glasspod/protocol";
import { getJson } from "./client.js";
import type { ApiResult } from "./client.js";

// namespace와 이름은 주소에서 온 값이므로 경로 한 칸으로 인코딩합니다(예: "/"가 경로를 나누지 않게).
export function podApiPath(pod: PodRef): string {
  return `/api/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`;
}

// ?namespace= 쿼리를 붙입니다. 없으면 모든 namespace입니다.
function withNamespace(path: string, namespace: string | undefined): string {
  return namespace === undefined
    ? path
    : `${path}?${new URLSearchParams({ namespace }).toString()}`;
}

export function podsPath(namespace?: string): string {
  return withNamespace("/api/pods", namespace);
}

export function statusChangesPath(namespace?: string): string {
  return withNamespace("/api/status-changes", namespace);
}

// SSE 주소입니다. EventSource로 엽니다(podStream.ts).
export function streamPath(namespace?: string): string {
  return withNamespace("/api/stream", namespace);
}

// Pod 목록과 Deployment 요약입니다.
export function getPods(
  namespace?: string,
  signal?: AbortSignal,
): Promise<ApiResult<PodListBody>> {
  return getJson<PodListBody>(podsPath(namespace), signal);
}

// Pod 하나의 판단, 마지막 지표 값, 최근 30분 기록입니다. 판단이 없는 Pod면 404 pod-not-found입니다.
export function getPod(
  pod: PodRef,
  signal?: AbortSignal,
): Promise<ApiResult<PodDetailBody>> {
  return getJson<PodDetailBody>(podApiPath(pod), signal);
}

// 최근 30분 판단 변화입니다(타임라인).
export function getStatusChanges(
  namespace?: string,
  signal?: AbortSignal,
): Promise<ApiResult<StatusChangesBody>> {
  return getJson<StatusChangesBody>(statusChangesPath(namespace), signal);
}

// 그 Pod의 SDK에 지금 상태를 물어봅니다. 서버가 최대 5초 기다리므로 그만큼 걸릴 수 있습니다.
export function getSnapshot(
  pod: PodRef,
  signal?: AbortSignal,
): Promise<ApiResult<SnapshotBody>> {
  return getJson<SnapshotBody>(`${podApiPath(pod)}/snapshot`, signal);
}
