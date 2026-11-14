// SDK의 WebSocket 연결(/agent)을 받습니다(design.md 7.1).
// 첫 메시지로 hello를 받아 welcome 또는 reject로 답하고, 그 뒤 메시지는 검증만 합니다.
// welcome 뒤에는 heartbeat를 주기마다 보내 SDK가 응답 없는 연결을 알아채게 합니다(design.md 7.4).
// hello를 받아들인 연결은 연결 목록(agents.ts)에 넣고, response는 그 연결에 넘겨 기다리던 요청과 짝짓습니다(T09).
// 연결, 메시지, 끊김은 AppStates(pods.ts)에 넘겨 지금 상태와 기록을 만듭니다(T11).
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { parseSdkMessage } from "@glasspod/protocol";
import type { HelloMessage } from "@glasspod/protocol";
import { AgentSession } from "./agents.js";
import type { AgentRegistry } from "./agents.js";
import type { ServerConfig } from "./config.js";
import { decideHello, rejectMessage } from "./handshake.js";
import type { RejectReason } from "./handshake.js";
import { log } from "./log.js";
import type { LogFields } from "./log.js";
import type { AppStates } from "./pods.js";

export const AGENT_PATH = "/agent";

// 메시지 하나의 최대 크기입니다. ws 기본값(100MiB)은 너무 커서 줄입니다. 넘으면 ws가 1009로 연결을 닫습니다.
const MAX_MESSAGE_BYTES = 1024 * 1024;
// 연결한 뒤 이 시간 안에 hello가 없으면 거절합니다.
const HELLO_TIMEOUT_MS = 10_000;
// reject를 보낸 뒤 닫을 때 쓰는 WebSocket 종료 코드입니다(1008: 정책 위반).
const CLOSE_POLICY_VIOLATION = 1008;
// heartbeat 메시지는 늘 같으므로 한 번만 만듭니다.
const HEARTBEAT_TEXT = JSON.stringify({ type: "heartbeat" });

export function attachAgentServer(
  server: Server,
  config: ServerConfig,
  agents: AgentRegistry,
  apps: AppStates,
): WebSocketServer {
  // path가 다른 업그레이드 요청은 ws가 400으로 거절합니다.
  const agentServer = new WebSocketServer({
    server,
    path: AGENT_PATH,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  agentServer.on("connection", (socket, request) =>
    handleConnection(socket, request, config, agents, apps),
  );
  // http 서버의 오류(예: 포트 사용 중)가 여기로도 전달됩니다. 처리는 index.ts의 서버 오류 처리에서 합니다.
  agentServer.on("error", () => {});
  return agentServer;
}

function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  config: ServerConfig,
  agents: AgentRegistry,
  apps: AppStates,
): void {
  const remote = request.socket.remoteAddress;
  let hello: HelloMessage | undefined;
  // hello를 받아들인 뒤의 연결입니다. 연결 목록에 들어가고, 연결이 끝나면 빠집니다.
  let session: AgentSession | undefined;
  let rejected = false;
  // welcome을 보낸 뒤 heartbeat를 보내는 타이머입니다. 연결이 끝나면 멈춥니다.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  // 로그에 붙이는 연결 정보입니다. hello를 받은 뒤에는 Pod와 인스턴스를 붙입니다.
  const fields = (): LogFields =>
    hello === undefined
      ? { remote }
      : {
          remote,
          pod: `${hello.pod.namespace}/${hello.pod.name}`,
          instance: hello.instanceId,
        };

  // 지금 상태와 기록을 만들다 난 예외는 오류 한 줄만 남기고 연결은 유지합니다.
  // 메시지 하나 때문에 서버가 죽으면 메모리에 든 기록을 모두 잃습니다.
  const record = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      log.error("app state failed", {
        ...fields(),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
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
      // SDK는 이 메시지에 답하지 않습니다. 응답이 없다고 서버가 연결을 닫지도 않습니다.
      // 앱의 이벤트 루프가 막히면 SDK가 답할 수 없어, 앱 멈춤과 연결 끊김을 구분하지 못하게 되기 때문입니다.
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send(HEARTBEAT_TEXT);
        }
      }, config.heartbeatIntervalMs);
      log.info("hello accepted", {
        ...fields(),
        sdk: `${hello.sdk.lang}@${hello.sdk.version}`,
        protocol: hello.protocol,
      });
      session = new AgentSession({
        hello,
        fields: fields(),
        send: (text) => {
          if (socket.readyState !== socket.OPEN) {
            return false;
          }
          socket.send(text);
          return true;
        },
      });
      const previous = agents.add(session);
      if (previous !== undefined) {
        log.info("agent replaced", {
          ...fields(),
          previous: previous.hello.instanceId,
        });
      }
      const accepted = session;
      record(() => apps.connect(accepted));
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
    if (session === undefined) {
      return;
    }
    const message = result.message;
    if (message.type === "hello") {
      log.warn("message ignored", { ...fields(), detail: "duplicate hello" });
    }
    // 답은 기다리던 요청과 짝짓습니다. 로그는 짝지은 쪽(agents.ts)에서 남깁니다.
    if (message.type === "response") {
      session.receive(message);
    }
    // metrics와 event는 기록하고, 모든 메시지(무시한 두 번째 hello 포함)의 seq로 누락을 봅니다.
    // 메시지마다 로그는 남기지 않습니다(T11).
    const current = session;
    record(() => apps.receive(current, message));
  });

  socket.on("close", (code, reason) => {
    clearTimeout(helloTimer);
    clearInterval(heartbeatTimer);
    if (session !== undefined) {
      const closed = session;
      session.close();
      agents.remove(session);
      record(() => apps.disconnect(closed, code));
    }
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
