// 연결의 첫 메시지를 보고 hello를 받아들일지 정합니다(design.md 7.3).
// 연결 처리(agent.ts)와 떼어 두어 단위 테스트합니다.
import { PROTOCOL_VERSION, parseSdkMessage } from "@glasspod/protocol";
import type {
  HelloMessage,
  RejectMessage,
  WelcomeMessage,
} from "@glasspod/protocol";

// reject의 reason 값입니다. unknown-pod(쿠버네티스에 없는 Pod)는 T25에서 더합니다.
export type RejectReason =
  "invalid-hello" | "unsupported-protocol" | "hello-timeout";

// welcome에 넣는 값입니다. 서버 설정(config.ts)에서 옵니다.
export interface WelcomeSettings {
  metricsIntervalMs: number;
  maxEventsPerMinute: number;
}

// detail은 서버 로그에만 남기는 설명입니다. SDK에는 reason만 보냅니다.
export type HelloDecision =
  | { accepted: true; hello: HelloMessage; welcome: WelcomeMessage }
  | { accepted: false; reason: RejectReason; detail: string };

export function rejectMessage(reason: RejectReason): RejectMessage {
  return { type: "reject", reason };
}

export function decideHello(
  text: string,
  settings: WelcomeSettings,
): HelloDecision {
  // 다른 버전의 hello는 v1 스키마와 모양이 다를 수 있으므로, 스키마 검증보다 protocol 값을 먼저 봅니다.
  const protocol = peekHelloProtocol(text);
  if (protocol !== undefined && protocol !== PROTOCOL_VERSION) {
    return {
      accepted: false,
      reason: "unsupported-protocol",
      detail: `protocol ${protocol} is not supported (server speaks ${PROTOCOL_VERSION})`,
    };
  }

  const result = parseSdkMessage(text);
  if (!result.ok) {
    return { accepted: false, reason: "invalid-hello", detail: result.error };
  }
  if (result.message.type !== "hello") {
    return {
      accepted: false,
      reason: "invalid-hello",
      detail: `expected hello as the first message, got ${result.message.type}`,
    };
  }

  return {
    accepted: true,
    hello: result.message,
    welcome: {
      type: "welcome",
      metricsIntervalMs: settings.metricsIntervalMs,
      maxEventsPerMinute: settings.maxEventsPerMinute,
    },
  };
}

// type이 hello이고 protocol이 정수일 때만 그 값을 돌려줍니다. 나머지는 스키마 검증에 맡깁니다.
function peekHelloProtocol(text: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "hello" &&
    "protocol" in value &&
    Number.isInteger(value.protocol)
  ) {
    return value.protocol as number;
  }
  return undefined;
}
