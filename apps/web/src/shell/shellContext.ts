// 분할 화면 틀(Shell)이 오른쪽 자리(Outlet)에 넘기는 값과 화면 안 링크입니다(docs/guides/T18.md 결정 4~6).
import type { PodRef } from "@glasspod/protocol";
import { useOutletContext } from "react-router";
import type { PodStream } from "../api/podStream.js";

export interface ShellContext {
  // 틀이 하나만 연 SSE 스트림입니다(결정 5).
  stream: PodStream;
  // 고른 namespace입니다. 없으면 모든 namespace입니다.
  namespace: string | undefined;
  // 지금(서버 시계)입니다. 1초마다 바뀝니다(결정 12).
  now: number;
}

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}

// 화면 안 링크가 이어 가는 주소 쿼리입니다. 고른 namespace만 담습니다(결정 6).
export function namespaceSearch(namespace: string | undefined): string {
  return namespace === undefined
    ? ""
    : `?${new URLSearchParams({ namespace }).toString()}`;
}

export function overviewLink(namespace: string | undefined) {
  return { pathname: "/", search: namespaceSearch(namespace) };
}

// 조치 기록 화면 주소입니다(docs/guides/T21.md 결정 19).
export const ACTIONS_PATH = "/actions";

export function actionsLink(namespace: string | undefined) {
  return { pathname: ACTIONS_PATH, search: namespaceSearch(namespace) };
}

// 격리된 Pod 화면 주소입니다(docs/guides/T23.md 결정 18).
export const ISOLATED_PATH = "/isolated";

export function isolatedLink(namespace: string | undefined) {
  return { pathname: ISOLATED_PATH, search: namespaceSearch(namespace) };
}

// 상세 주소입니다. 주소의 한 칸이 되게 인코딩합니다.
export function podLink(pod: PodRef, namespace: string | undefined) {
  return {
    pathname: `/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`,
    search: namespaceSearch(namespace),
  };
}
