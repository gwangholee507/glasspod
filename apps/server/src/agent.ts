// SDK의 WebSocket 연결(/agent)을 받습니다(design.md 7.1).
// 첫 메시지로 hello를 받아 welcome 또는 reject로 답하고, 그 뒤 메시지는 검증만 합니다.
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { parseSdkMessage } from "@glasspod/protocol";
import type { HelloMessage } from "@glasspod/protocol";
import type { ServerConfig } from "./config.js";
import { decideHello, rejectMessage } from "./handshake.js";
import type { RejectReason } from "./handshake.js";
import { log } from "./log.js";
import type { LogFields } from "./log.js";

export const AGENT_PATH = "/agent";

// 메시지 하나의 최대 크기입니다. ws 기본값(100MiB)은 너무 커서 줄입니다. 넘으면 ws가 1009로 연결을 닫습니다.
const MAX_MESSAGE_BYTES = 1024 * 1024;
// 연결한 뒤 이 시간 안에 hello가 없으면 거절합니다.
const HELLO_TIMEOUT_MS = 10_000;
// reject를 보낸 뒤 닫을 때 쓰는 WebSocket 종료 코드입니다(1008: 정책 위반).
const CLOSE_POLICY_VIOLATION = 1008;

export function attachAgentServer(
  server: Server,
  config: ServerConfig,
): WebSocketServer {
  // path가 다른 업그레이드 요청은 ws가 400으로 거절합니다.
  const agents = new WebSocketServer({
    server,
    path: AGENT_PATH,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  agents.on("connection", (socket, request) =>
    handleConnection(socket, request, config),
  );
  // http 서버의 오류(예: 포트 사용 중)가 여기로도 전달됩니다. 처리는 index.ts의 서버 오류 처리에서 합니다.
  agents.on("error", () => {});
  return agents;
}

function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  config: ServerConfig,
): void {
  const remote = request.socket.remoteAddress;
  let hello: HelloMessage | undefined;
  let rejected = false;

  // 로그에 붙이는 연결 정보입니다. hello를 받은 뒤에는 Pod와 인스턴스를 붙입니다.
  const fields = (): LogFields =>
    hello === undefined
      ? { remote }
      : {
          remote,
          pod: `${hello.pod.namespace}/${hello.pod.name}`,
          instance: hello.instanceId,
        };

  const reject = (reason: RejectReason, detail: string): void => {
    rejected = true;
    clearTimeout(helloTimer);
    log.warn("hello rejected", { ...fields(), reason, detail });
    socket.send(JSON.stringify(rejectMessage(reason)));
    socket.close(CLOSE_POLICY_VIOLATION, reason);
  };

  const helloTimer = setTimeout(
    () => reject("hello-timeout", `no hello within ${HELLO_TIMEOUT_MS}ms`),
    HELLO_TIMEOUT_MS,
  );

  log.info("agent connected", fields());

  socket.on("message", (data, isBinary) => {
    // 거절한 뒤 닫히기 전에 들어온 메시지는 보지 않습니다.
    if (rejected) {
      return;
    }

    if (hello === undefined) {
      if (isBinary) {
        reject("invalid-hello", "binary frame");
        return;
      }
      const decision = decideHello(toText(data), config);
      if (!decision.accepted) {
        reject(decision.reason, decision.detail);
        return;
      }
      clearTimeout(helloTimer);
      hello = decision.hello;
      socket.send(JSON.stringify(decision.welcome));
      log.info("hello accepted", {
        ...fields(),
        sdk: `${hello.sdk.lang}@${hello.sdk.version}`,
        protocol: hello.protocol,
      });
      return;
    }

    // hello 뒤의 잘못된 메시지는 경고만 남기고 연결은 유지합니다. SDK 버그 하나로 다른 데이터까지 잃지 않게 하려는 것입니다.
    if (isBinary) {
      log.warn("message ignored", { ...fields(), detail: "binary frame" });
      return;
    }
    const result = parseSdkMessage(toText(data));
    if (!result.ok) {
      log.warn("message ignored", { ...fields(), detail: result.error });
      return;
    }
    if (result.message.type === "hello") {
      log.warn("message ignored", { ...fields(), detail: "duplicate hello" });
      return;
    }
    // 보관과 상태 판단은 T11부터 합니다. 지금은 받은 종류만 남깁니다.
    log.info("message received", {
      ...fields(),
      type: result.message.type,
      seq: result.message.seq,
    });
  });

  socket.on("close", (code, reason) => {
    clearTimeout(helloTimer);
    log.info("agent disconnected", {
      ...fields(),
      code,
      reason: reason.toString() || undefined,
    });
  });

  // 'error'를 받지 않으면 프로세스가 멈춥니다. 메시지가 너무 크거나 프레임이 잘못되면 여기로 옵니다.
  socket.on("error", (error) => {
    log.warn("agent connection error", { ...fields(), detail: error.message });
  });
}

// ws는 기본 설정에서 Buffer를 주지만, 타입에 있는 다른 모양도 문자열로 바꿉니다.
function toText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
