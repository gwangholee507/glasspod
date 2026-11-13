// Pod 하나에 대한 서버 API입니다. 지금은 snapshot(docs/guides/T09.md)만 있고, 목록·상세 API는 T14에서 더합니다.
import type { PodRef, SnapshotBody } from "@glasspod/protocol";
import { getJson } from "./client.js";
import type { ApiResult } from "./client.js";

// namespace와 이름은 주소에서 온 값이므로 경로 한 칸으로 인코딩합니다(예: "/"가 경로를 나누지 않게).
export function podApiPath(pod: PodRef): string {
  return `/api/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`;
}

// 그 Pod의 SDK에 지금 상태를 물어봅니다. 서버가 최대 5초 기다리므로 그만큼 걸릴 수 있습니다.
export function getSnapshot(
  pod: PodRef,
  signal?: AbortSignal,
): Promise<ApiResult<SnapshotBody>> {
  return getJson<SnapshotBody>(`${podApiPath(pod)}/snapshot`, signal);
}
