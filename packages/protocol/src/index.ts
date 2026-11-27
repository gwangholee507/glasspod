// SDK–서버 프로토콜 버전입니다. hello 메시지의 protocol 필드에 들어갑니다(design.md 7.3).
// 필드를 없애거나 의미를 바꿀 때만 올립니다.
export const PROTOCOL_VERSION = 1;

// 메시지 타입은 schema/*.schema.json에서 만든 것입니다(npm run generate).
export type * from "./generated/sdk-message.js";
export type * from "./generated/server-message.js";
export type * from "./generated/snapshot.js";
// 자동 규칙 파일의 타입입니다(docs/guides/T28.md). 서버 설정이지만 스키마가 기준인 것은 같습니다.
export type * from "./generated/rules.js";

// 서버 HTTP API의 본문 타입입니다(손으로 씀). 서버와 웹 화면이 함께 씁니다.
export type * from "./http.js";

export {
  parseSdkMessage,
  parseServerMessage,
  validateRulesFile,
  validateSnapshotData,
} from "./validate.js";
export type { ParseResult } from "./validate.js";
