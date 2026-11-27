// 받은 WebSocket 텍스트 프레임을 JSON으로 읽고 프로토콜 스키마로 검증합니다(design.md 7.2).
// 스키마는 모르는 필드를 허용합니다. 받는 쪽은 모르는 필드를 무시하면 됩니다.
import { Ajv } from "ajv";
import type { AnySchema, ValidateFunction } from "ajv";
import {
  rulesFileSchema,
  sdkMessageSchema,
  serverMessageSchema,
  snapshotDataSchema,
} from "./generated/schemas.js";
import type { RulesFile } from "./generated/rules.js";
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
// 규칙 파일은 사람이 고치므로 틀린 곳을 모두 보입니다(빠진 cooldown과 오타 cooldwon을 함께).
// 메시지 검증과 따로 allErrors를 켠 Ajv를 씁니다.
let rulesAjv: Ajv | undefined;
let rulesFileValidate: ValidateFunction<RulesFile> | undefined;
function rulesFileValidator(): ValidateFunction<RulesFile> {
  rulesAjv ??= new Ajv({ allErrors: true });
  return (rulesFileValidate ??= rulesAjv.compile<RulesFile>(rulesFileSchema));
}

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

// 규칙 파일에서 조건·조치가 어느 갈래에도 맞지 않을 때 보일 설명입니다. Ajv의 schemaPath는 $ref마다 새로 시작하므로
// 데이터 경로(rules/0/when/1, rules/0/action)로 고릅니다.
function oneOfHint(instancePath: string): string | undefined {
  if (/^\/rules\/\d+\/when\/\d+$/.test(instancePath)) {
    return "must be one condition: { status: [...], for }, { outlier, for } or { metric, above or below, for }";
  }
  if (/^\/rules\/\d+\/action$/.test(instancePath)) {
    return "must be one action: { restart: {} }, { isolate: {} } or { scale: { by, min, max } }";
  }
  return undefined;
}

// 사람이 고칠 파일이라 Ajv 문구를 다듬습니다. 경로는 'rules/0/cooldown'처럼 쓰고, 모르는 필드는 이름을,
// enum은 받는 값을 보입니다. oneOf가 틀렸을 때 갈래 안의 값이 틀린 것(더 깊은 경로)이 있으면 그것을,
// 없으면(어느 갈래의 키도 아님) 한 줄 설명을 보입니다.
function describeRulesErrors(errors: ValidateFunction["errors"]): string {
  const list = errors ?? [];
  const oneOfs = list.filter((error) => error.keyword === "oneOf");
  const parts: string[] = [];
  for (const error of list) {
    const where =
      error.instancePath === "" ? "file" : error.instancePath.slice(1);
    const parent = oneOfs.find(
      (oneOf) =>
        oneOf !== error &&
        (error.instancePath === oneOf.instancePath ||
          error.instancePath.startsWith(`${oneOf.instancePath}/`)),
    );
    if (parent !== undefined) {
      // 갈래 안의 깊은 오류만 남깁니다. 같은 자리의 required·additionalProperties는 다른 갈래의 것입니다.
      if (error.instancePath === parent.instancePath) {
        continue;
      }
    }
    if (error.keyword === "oneOf") {
      const deeper = list.some((other) =>
        other.instancePath.startsWith(`${error.instancePath}/`),
      );
      if (!deeper) {
        parts.push(
          `${where} ${oneOfHint(error.instancePath) ?? error.message ?? "is not valid"}`,
        );
      }
      continue;
    }
    if (error.keyword === "if") {
      continue;
    }
    if (error.keyword === "additionalProperties") {
      parts.push(
        `${where} has an unknown field "${String(error.params["additionalProperty"])}"`,
      );
      continue;
    }
    if (error.keyword === "enum") {
      const allowed = error.params["allowedValues"];
      parts.push(
        `${where} must be one of: ${Array.isArray(allowed) ? allowed.join(", ") : ""}`,
      );
      continue;
    }
    parts.push(`${where} ${error.message ?? "is not valid"}`);
  }
  return [...new Set(parts)].join("; ") || "the rules file is not valid";
}

// 서버가 자동 규칙 파일(YAML을 읽은 값)을 검증합니다(docs/guides/T28.md 결정 8).
// 오류 문구는 'rules/0 has an unknown field "cooldwon"'처럼 틀린 자리부터 씁니다.
// 스키마로 할 수 없는 검사(이름 겹침, 시간 범위)는 서버가 따로 합니다.
export function validateRulesFile(value: unknown): ParseResult<RulesFile> {
  const validate = rulesFileValidator();
  if (validate(value)) {
    return { ok: true, message: value };
  }
  return { ok: false, error: describeRulesErrors(validate.errors) };
}
