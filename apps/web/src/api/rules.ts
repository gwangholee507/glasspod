// 자동 규칙 API입니다(docs/guides/T28.md 결정 18). 규칙은 ConfigMap에서 바꾸므로 화면은 읽기만 합니다.
import type { RulesBody } from "@glasspod/protocol";
import { getJson } from "./client.js";
import type { ApiResult } from "./client.js";

export function rulesPath(namespace?: string): string {
  return namespace === undefined
    ? "/api/rules"
    : `/api/rules?${new URLSearchParams({ namespace }).toString()}`;
}

// 규칙 파일 상태, 규칙과 지금 상태, 서버가 남긴 규칙 기록(발동한 순서)입니다.
export function getRules(
  namespace?: string,
  signal?: AbortSignal,
): Promise<ApiResult<RulesBody>> {
  return getJson<RulesBody>(rulesPath(namespace), signal);
}
