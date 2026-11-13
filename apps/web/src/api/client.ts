// 서버 HTTP API를 부르는 fetch 감싸기입니다(docs/guides/T17.md 결정 11).
// 예외를 던지지 않고 성공과 실패를 같은 모양의 결과로 돌려줍니다. 실패는 서버의 오류 본문 { error, detail }을 그대로 씁니다.
import type { ApiErrorBody } from "@glasspod/protocol";

export interface ApiSuccess<T> {
  ok: true;
  status: number;
  data: T;
}

// status가 0이면 HTTP 응답을 받지 못한 것입니다.
export interface ApiFailure extends ApiErrorBody {
  ok: false;
  status: number;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

// 웹 화면이 붙이는 오류 코드입니다. 나머지 코드는 서버(또는 개발 서버의 프록시)가 정합니다.
// 서버나 개발 서버에 닿지 못했습니다.
export const NETWORK_ERROR = "network-error";
// 본문이 JSON이 아니거나, 오류 본문이 { error, detail } 모양이 아닙니다.
export const UNEXPECTED_BODY = "unexpected-body";

// 알아볼 수 없는 본문은 앞부분만 detail에 넣습니다.
const BODY_PREVIEW_LENGTH = 200;

export async function getJson<T>(
  path: string,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
  } catch (error) {
    return failure(0, NETWORK_ERROR, errorMessage(error));
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return failure(response.status, NETWORK_ERROR, errorMessage(error));
  }
  return parseApiResponse<T>(response.status, text);
}

// 상태 코드와 본문으로 결과를 만듭니다. 2xx 본문은 검증하지 않고 타입만 붙입니다(서버가 이미 검증함, 결정 12).
export function parseApiResponse<T>(
  status: number,
  text: string,
): ApiResult<T> {
  const body = parseJson(text);
  if (status >= 200 && status < 300) {
    if (!body.ok) {
      return failure(
        status,
        UNEXPECTED_BODY,
        `body is not JSON: ${preview(text)}`,
      );
    }
    return { ok: true, status, data: body.value as T };
  }
  if (body.ok && isApiErrorBody(body.value)) {
    return failure(status, body.value.error, body.value.detail);
  }
  return failure(
    status,
    UNEXPECTED_BODY,
    `error body is not { error, detail }: ${preview(text)}`,
  );
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { error, detail } = value as Record<string, unknown>;
  return typeof error === "string" && typeof detail === "string";
}

function preview(text: string): string {
  if (text.trim() === "") {
    return "(empty)";
  }
  return text.length > BODY_PREVIEW_LENGTH
    ? `${text.slice(0, BODY_PREVIEW_LENGTH)}…`
    : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(status: number, error: string, detail: string): ApiFailure {
  return { ok: false, status, error, detail };
}
