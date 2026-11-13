// 받은 WebSocket 텍스트 프레임을 JSON으로 읽고 프로토콜 스키마로 검증합니다(design.md 7.2).
// 스키마는 모르는 필드를 허용합니다. 받는 쪽은 모르는 필드를 무시하면 됩니다.
import { Ajv } from "ajv";
import type { AnySchema, ValidateFunction } from "ajv";
import {
  sdkMessageSchema,
  serverMessageSchema,
  snapshotDataSchema,
} from "./generated/schemas.js";
import type { SdkMessage } from "./generated/sdk-message.js";
import type { ServerMessage } from "./generated/server-message.js";
import type { SnapshotData } from "./generated/snapshot.js";

// 검증 결과입니다. 실패하면 error에 이유를 한 줄로 담습니다(예: "message/pod must have required property 'name'").
export type ParseResult<T> =
  { ok: true; message: T } | { ok: false; error: string };

let ajv: Ajv | undefined;

function getAjv(): Ajv {
  // discriminator: type 값으로 oneOf의 갈래를 바로 골라, 오류가 그 메시지 하나에 대해서만 나오게 합니다.
  return (ajv ??= new Ajv({ discriminator: true }));
}

// 스키마 컴파일은 처음 쓸 때 한 번만 합니다. SDK를 불러오는 것만으로 앱 시작이 느려지지 않게 하려는 것입니다.
function lazyValidator<T>(schema: AnySchema): () => ValidateFunction<T> {
  let validate: ValidateFunction<T> | undefined;
  return () => (validate ??= getAjv().compile<T>(schema));
}

const sdkMessageValidator = lazyValidator<SdkMessage>(sdkMessageSchema);
const serverMessageValidator =
  lazyValidator<ServerMessage>(serverMessageSchema);
const snapshotDataValidator = lazyValidator<SnapshotData>(snapshotDataSchema);

function parseWith<T>(
  text: string,
  getValidator: () => ValidateFunction<T>,
): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "message is not valid JSON" };
  }
  const validate = getValidator();
  if (validate(value)) {
    return { ok: true, message: value };
  }
  return { ok: false, error: describeErrors(validate.errors) };
}

function describeErrors(errors: ValidateFunction["errors"]): string {
  // 모르는 type이면 Ajv 문구에 받은 값이 없으므로, 로그에서 바로 알아볼 수 있게 값을 넣습니다.
  const first = errors?.[0];
  if (first?.keyword === "discriminator" && first.params.error === "mapping") {
    return `unknown message type: ${JSON.stringify(first.params.tagValue)}`;
  }
  return getAjv().errorsText(errors, { dataVar: "message" });
}

// 서버가 SDK에서 받은 메시지(hello, metrics, event, response)를 읽습니다.
export function parseSdkMessage(text: string): ParseResult<SdkMessage> {
  return parseWith(text, sdkMessageValidator);
}

// SDK가 서버에서 받은 메시지(welcome, reject, request, heartbeat)를 읽습니다.
export function parseServerMessage(text: string): ParseResult<ServerMessage> {
  return parseWith(text, serverMessageValidator);
}

// 서버가 snapshot response의 data를 검증합니다(T09). data는 response를 읽을 때 이미 JSON에서 꺼낸 값입니다.
// 오류 문구는 "data"로 시작합니다(예: "data must have required property 'process'").
export function validateSnapshotData(
  value: unknown,
): ParseResult<SnapshotData> {
  const validate = snapshotDataValidator();
  if (validate(value)) {
    return { ok: true, message: value };
  }
  return {
    ok: false,
    error: getAjv().errorsText(validate.errors, { dataVar: "data" }),
  };
}
