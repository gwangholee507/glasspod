// 예외와 event() 인자를 보낼 이벤트 내용으로 바꿉니다(docs/guides/T06.md 결정 11~14).
// 앱이 넘긴 값은 무엇이든 받아들이고, 문제가 있으면 경고만 남깁니다. 예외를 던지지 않습니다.
import type { EventLevel } from "@glasspod/protocol";
import { types } from "node:util";
import type { EventContent } from "./events.js";
import { describeError } from "./log.js";
import type { WarnOnce } from "./log.js";
import { APP_NAME_RULE, isAppName, quote } from "./registry.js";

// 길이 상한입니다. 처리되지 않은 예외는 기다리지 않고 보내므로 메시지가 소켓 버퍼에 한 번에 들어가야 합니다.
export const MAX_MESSAGE_CHARS = 1000;
export const MAX_STACK_LINES = 50;
export const MAX_STACK_CHARS = 8000;
export const MAX_DATA_CHARS = 8192;

const LEVELS: readonly string[] = ["info", "warn", "error"];

export interface EventOptions {
  // info(기본), warn, error 가운데 하나입니다.
  level?: EventLevel;
  message?: string;
  // JSON으로 바꿀 수 있는 객체입니다. 보낼 때의 값이 아니라 부른 때의 값을 복사해 둡니다.
  data?: Record<string, unknown>;
}

// 예외 값에서 뽑은 내용입니다.
export interface ExceptionInfo {
  errorType: string;
  message?: string;
  stack?: string;
}

// 예외를 exception 이벤트로 바꿉니다. data는 앱이 넘긴 값, extra는 SDK가 더하는 값(origin, fatal)입니다.
// 같은 키는 SDK 값이 이깁니다.
export function exceptionContent(
  error: unknown,
  data: unknown,
  extra: Record<string, unknown> | undefined,
  warnings: WarnOnce,
): EventContent {
  const info = describeException(error);
  const userData =
    data === undefined ? undefined : copyData("exception", data, warnings);
  const content: EventContent = {
    level: "error",
    name: "exception",
    data: {
      ...userData,
      errorType: info.errorType,
      ...(info.stack === undefined ? {} : { stack: info.stack }),
      ...extra,
    },
  };
  if (info.message !== undefined) {
    content.message = info.message;
  }
  return content;
}

// event(name, options)를 이벤트 내용으로 바꿉니다. 보내면 안 되는 문제가 있으면 경고하고 undefined입니다.
export function customEventContent(
  name: unknown,
  options: unknown,
  warnings: WarnOnce,
): EventContent | undefined {
  if (!isAppName(name)) {
    warnings.warn(
      `event:${String(name)}:name`,
      `event ignored: ${quote(name)} ${APP_NAME_RULE}`,
    );
    return undefined;
  }
  if (
    options !== undefined &&
    (typeof options !== "object" || options === null)
  ) {
    warnings.warn(
      `event:${name}:options`,
      `event ignored: "${name}": options must be an object`,
    );
    return undefined;
  }
  const {
    level = "info",
    message,
    data,
  } = (options ?? {}) as Record<string, unknown>;
  if (typeof level !== "string" || !LEVELS.includes(level)) {
    warnings.warn(
      `event:${name}:level`,
      `event ignored: "${name}": level must be "info", "warn" or "error"`,
    );
    return undefined;
  }
  if (message !== undefined && typeof message !== "string") {
    warnings.warn(
      `event:${name}:message`,
      `event ignored: "${name}": message must be a string`,
    );
    return undefined;
  }
  const content: EventContent = { level: level as EventLevel, name };
  if (message !== undefined && message !== "") {
    content.message = truncate(message, MAX_MESSAGE_CHARS);
  }
  if (data !== undefined) {
    const copy = copyData(name, data, warnings);
    if (copy !== undefined) {
      content.data = copy;
    }
  }
  return content;
}

// 던져진 값에서 종류, 메시지, stack을 뽑습니다. Error가 아닌 값도 받습니다.
export function describeException(value: unknown): ExceptionInfo {
  if (isErrorLike(value)) {
    const name = read(() => value.name);
    const constructorName = read(
      () => (value as { constructor?: { name?: unknown } }).constructor?.name,
    );
    // name을 따로 정하지 않은 사용자 정의 예외(class TimeoutError extends Error)는 생성자 이름을 씁니다.
    const errorType =
      typeof name === "string" && name !== "" && name !== "Error"
        ? name
        : typeof constructorName === "string" &&
            constructorName !== "" &&
            constructorName !== "Object"
          ? constructorName
          : "Error";
    const info: ExceptionInfo = { errorType };
    const message = read(() => value.message);
    if (typeof message === "string" && message !== "") {
      info.message = truncate(message, MAX_MESSAGE_CHARS);
    }
    const stack = read(() => value.stack);
    if (typeof stack === "string" && stack !== "") {
      info.stack = truncateStack(stack);
    }
    return info;
  }
  // throw "text"처럼 Error가 아닌 값입니다. 종류를 errorType으로, 글자로 바꾼 값을 message로 씁니다.
  const info: ExceptionInfo = {
    errorType: value === null ? "null" : typeof value,
  };
  const text = read(() => String(value));
  if (typeof text === "string" && text !== "") {
    info.message = truncate(text, MAX_MESSAGE_CHARS);
  }
  return info;
}

// data를 JSON으로 바꿔 복사합니다. 문제가 있으면 경고하고 undefined입니다(이벤트는 data 없이 보냄).
export function copyData(
  name: string,
  data: unknown,
  warnings: WarnOnce,
): Record<string, unknown> | undefined {
  const without = (problem: string, detail: string): undefined => {
    warnings.warn(
      `data:${name}:${problem}`,
      `event "${name}" sent without data: ${detail}`,
    );
    return undefined;
  };
  if (!isPlainObject(data)) {
    return without("type", "data must be a plain object");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch (error) {
    const reason = describeError(error).split("\n")[0] ?? "";
    return without("json", `data cannot be converted to JSON (${reason})`);
  }
  if (json === undefined) {
    return without("type", "data must be a plain object");
  }
  if (json.length > MAX_DATA_CHARS) {
    return without(
      "size",
      `data is longer than ${MAX_DATA_CHARS} characters as JSON`,
    );
  }
  // toJSON이 객체가 아닌 값을 돌려줄 수도 있으므로 복사한 뒤 다시 확인합니다.
  const copy: unknown = JSON.parse(json);
  if (!isPlainObject(copy)) {
    return without("type", "data must be a plain object");
  }
  return copy;
}

// 길이 상한을 넘는 글을 잘라 끝에 ...을 붙입니다.
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

// stack을 줄 수와 글자 수 상한에 맞춥니다.
function truncateStack(stack: string): string {
  const lines = stack.split("\n");
  const kept =
    lines.length <= MAX_STACK_LINES
      ? stack
      : `${lines.slice(0, MAX_STACK_LINES).join("\n")}\n...`;
  return truncate(kept, MAX_STACK_CHARS);
}

function isErrorLike(
  value: unknown,
): value is { name?: unknown; message?: unknown; stack?: unknown } {
  if (types.isNativeError(value) || value instanceof Error) {
    return true;
  }
  // 다른 라이브러리가 만든, Error를 상속하지 않은 오류 객체(message가 문자열)도 예외로 봅니다.
  return (
    typeof value === "object" &&
    value !== null &&
    typeof read(() => (value as { message?: unknown }).message) === "string"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// getter가 예외를 던져도 SDK가 멈추지 않게 값을 읽습니다.
function read(get: () => unknown): unknown {
  try {
    return get();
  } catch {
    return undefined;
  }
}
