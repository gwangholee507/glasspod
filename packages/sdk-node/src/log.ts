// SDK 로그입니다. SDK는 앱과 출력을 함께 쓰므로 중요한 것만 표준 오류에 한 줄 남깁니다.
// 자세한 내용은 NODE_DEBUG=glasspod일 때만 나옵니다(Node 표준 util.debuglog).
import { debuglog } from "node:util";

const debugLog = debuglog("glasspod");

// 예: [glasspod] connection lost (code 1001); reconnecting
export function warn(message: string): void {
  console.warn(`[glasspod] ${message}`);
}

// 예: GLASSPOD 12345: hello sent seq=0
export function debug(message: string): void {
  // 메시지에 %가 있어도 형식 문자로 읽지 않게 %s로 넘깁니다.
  debugLog("%s", message);
}

// 예외 값에서 로그에 쓸 한 줄을 뽑습니다.
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
