// snapshot 칸의 글입니다(docs/guides/T19.md 'snapshot 문장', 결정 19).
import type { SnapshotErrorCode } from "@glasspod/protocol";

const ERROR_TEXT: Record<SnapshotErrorCode, string> = {
  "not-connected": "SDK가 연결되어 있지 않습니다.",
  "pod-not-found": "서버가 이 Pod를 모릅니다.",
  "not-supported": "이 SDK는 snapshot을 지원하지 않습니다.",
  busy: "이 Pod에 기다리는 snapshot 요청이 많습니다. 잠시 뒤에 다시 받습니다.",
  "no-response":
    "앱이 5초 안에 답하지 않았습니다. 이벤트 루프가 막혔을 수 있습니다.",
  disconnected: "답을 기다리는 동안 SDK 연결이 끊겼습니다.",
  "sdk-error": "SDK가 오류로 답했습니다.",
  "invalid-response": "SDK의 답이 형식에 맞지 않습니다.",
};

// 오류 코드를 문장으로 바꿉니다. 모르는 코드(network-error, proxy-error 등)는 서버에 닿지 못한 것으로 씁니다.
export function snapshotErrorText(code: string): string {
  return Object.hasOwn(ERROR_TEXT, code)
    ? ERROR_TEXT[code as SnapshotErrorCode]
    : `서버에 닿지 못했습니다 (${code}).`;
}

// 처리 중인 요청을 몇 개까지 보일지입니다. SDK가 긴 것(먼저 시작한 것)부터 보냅니다.
export const IN_FLIGHT_SHOWN = 5;
// 이보다 오래 걸린 요청은 위험 색으로 칠합니다.
export const SLOW_REQUEST_MS = 1_000;
