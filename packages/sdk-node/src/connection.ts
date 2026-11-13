// SDK와 서버 사이의 WebSocket 연결을 관리합니다(design.md 7.1, 7.4).
// 연결 → hello → welcome을 거쳐 연결된 상태가 되고, 끊기면 재연결 간격대로 다시 붙습니다.
// 연결된 동안 서버 메시지(heartbeat 등)가 오래 없으면 응답 없는 연결로 보고 끊습니다(T08).
// 연결된 동안 받은 request는 onRequest로 넘기고, 답은 send()로 보냅니다(T09).
// Node 내장 WebSocket(undici)을 씁니다. 동작상의 제약은 docs/guides/T04.md '내장 WebSocket의 제약'과
// docs/guides/T08.md '사전 확인'에 있습니다.
import { PROTOCOL_VERSION, parseServerMessage } from "@glasspod/protocol";
import type {
  HelloMessage,
  PodRef,
  RequestMessage,
  SdkMessage,
  WelcomeMessage,
} from "@glasspod/protocol";
import { reconnectDelay } from "./backoff.js";
import { guard } from "./guard.js";
import {
  LIVENESS_CHECK_MS,
  LivenessWatch,
  heartbeatTimeout,
} from "./liveness.js";
import { debug, describeError, warn } from "./log.js";
import { SDK_VERSION } from "./version.js";

// 연결 시도 뒤 열릴 때까지, hello를 보낸 뒤 welcome까지 기다리는 시간입니다. 서버의 hello 대기와 같습니다.
const OPEN_TIMEOUT_MS = 10_000;
const WELCOME_TIMEOUT_MS = 10_000;
// stop()으로 닫을 때 쓰는 종료 코드입니다(1000: 정상 종료).
const CLOSE_NORMAL = 1000;

export interface ConnectionOptions {
  serverUrl: string;
  pod: PodRef;
  instanceId: string;
  app?: HelloMessage["app"];
  // 이 SDK가 답할 수 있는 request의 action입니다. hello의 capabilities로 보냅니다(T09).
  capabilities?: readonly string[];
  // 프로세스에 하나뿐인 seq 카운터입니다. 재연결하거나 다시 시작해도 이어집니다(design.md 7.2).
  nextSeq: () => number;
  // welcome을 받아 연결된 때와, 그 연결이 끝난 때(끊김, stop) 부릅니다. metrics(T05)가 씁니다.
  onConnected?: (settings: ServerSettings) => void;
  onDisconnected?: () => void;
  // welcome을 받은 연결에서 request가 오면 부릅니다. 답은 send()로 보냅니다(T09).
  onRequest?: (request: RequestMessage) => void;
}

// welcome으로 받은 주기와 한도입니다. metrics(T05)와 event(T06)가 씁니다.
export type ServerSettings = Omit<WelcomeMessage, "type">;

export class Connection {
  private readonly options: ConnectionOptions;
  // 로그에 쓰는 서버 주소입니다. 사용자 정보와 query는 뺍니다.
  private readonly label: string;

  private running = false;
  // 연결 중이거나 연결된 소켓입니다. 끝난 소켓에서 늦게 온 이벤트는 이 값과 달라 무시됩니다.
  private socket: WebSocket | undefined;
  // 제한 시간 또는 재연결 대기 타이머입니다. 한 번에 하나만 걸립니다.
  private timer: ReturnType<typeof setTimeout> | undefined;
  // 지금 소켓이 받은 welcome 값입니다. 받기 전에는 undefined입니다.
  private welcome: ServerSettings | undefined;
  // 지금 소켓이 reject를 받았는지입니다.
  private rejected = false;
  // 마지막 welcome 뒤로 연속해서 실패한 횟수입니다. 재연결 간격을 정합니다.
  private failures = 0;
  // 장애(연결이 안 되거나 끊긴 때부터 다음 welcome까지) 동안 경고를 이미 남겼는지입니다.
  private outageReported = false;
  // 이번 장애에서 경고를 남긴 reject 이유입니다. 이유마다 한 번만 남깁니다.
  private readonly reportedRejects = new Set<string>();
  // 연결된 동안 서버 메시지가 끊겼는지 지켜봅니다. welcome에 heartbeatIntervalMs가 있을 때만 있습니다.
  private liveness:
    { watch: LivenessWatch; timer: ReturnType<typeof setInterval> } | undefined;

  constructor(options: ConnectionOptions) {
    this.options = options;
    const url = new URL(options.serverUrl);
    this.label = `${url.origin}${url.pathname}`;
  }

  // 연결된 동안에만 값이 있습니다.
  get settings(): ServerSettings | undefined {
    return this.welcome;
  }

  // 연결된(welcome을 받은) 동안에만 보냅니다. build는 이번 메시지의 seq를 받아 메시지를 만듭니다.
  // 보냈으면 그 seq, 연결이 없으면 undefined입니다. 보내지 않으면 seq도 쓰지 않습니다.
  send(build: (seq: number) => SdkMessage): number | undefined {
    const socket = this.socket;
    if (socket === undefined || this.welcome === undefined) {
      return undefined;
    }
    const message = build(this.options.nextSeq());
    socket.send(JSON.stringify(message));
    return message.seq;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.clearTimer();
    this.stopLiveness();
    const socket = this.socket;
    const wasConnected = this.welcome !== undefined;
    this.socket = undefined;
    this.welcome = undefined;
    this.rejected = false;
    if (socket !== undefined) {
      closeQuietly(socket, CLOSE_NORMAL);
    }
    if (wasConnected) {
      this.notify(this.options.onDisconnected);
    }
    debug("stopped");
  }

  private connect(): void {
    debug(`connecting to ${this.label}`);
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.serverUrl);
    } catch (error) {
      // 주소는 설정에서 검사하므로 여기 올 일은 없지만, 오더라도 재연결 간격대로 다시 시도합니다.
      this.end(`cannot create WebSocket: ${describeError(error)}`);
      return;
    }
    this.socket = socket;
    this.welcome = undefined;
    this.rejected = false;
    this.setTimer(OPEN_TIMEOUT_MS, () =>
      this.end(`not open within ${OPEN_TIMEOUT_MS}ms`),
    );

    // 리스너에서 난 예외는 처리되지 않은 예외가 되어 앱을 죽이므로 모두 guard로 감쌉니다.
    socket.addEventListener("open", () => guard(() => this.onOpen(socket)));
    socket.addEventListener("message", (event) =>
      guard(() => this.onMessage(socket, event.data)),
    );
    socket.addEventListener("error", (event) =>
      guard(() => this.onError(socket, event.message)),
    );
    socket.addEventListener("close", (event) =>
      guard(() => this.onClose(socket, event.code, event.reason)),
    );
  }

  private onOpen(socket: WebSocket): void {
    if (socket !== this.socket) {
      return;
    }
    const { pod, instanceId, app, capabilities } = this.options;
    const hello: HelloMessage = {
      type: "hello",
      seq: this.options.nextSeq(),
      ts: Date.now(),
      protocol: PROTOCOL_VERSION,
      sdk: { lang: "node", version: SDK_VERSION },
      pod,
      instanceId,
    };
    if (app !== undefined) {
      hello.app = app;
    }
    if (capabilities !== undefined) {
      hello.capabilities = [...capabilities];
    }
    socket.send(JSON.stringify(hello));
    debug(
      `hello sent seq=${hello.seq} pod=${pod.namespace}/${pod.name} instance=${instanceId}`,
    );
    this.setTimer(WELCOME_TIMEOUT_MS, () =>
      this.end(`no welcome within ${WELCOME_TIMEOUT_MS}ms`),
    );
  }

  private onMessage(socket: WebSocket, data: unknown): void {
    if (socket !== this.socket) {
      return;
    }
    // 어떤 메시지든 오면 연결이 살아 있는 것입니다.
    this.liveness?.watch.received();
    if (typeof data !== "string") {
      debug("binary message ignored");
      return;
    }
    const result = parseServerMessage(data);
    if (!result.ok) {
      debug(`message ignored: ${result.error}`);
      return;
    }
    const message = result.message;
    if (this.welcome === undefined && !this.rejected) {
      if (message.type === "welcome") {
        this.onWelcome(message);
        return;
      }
      if (message.type === "reject") {
        this.onReject(message.reason);
        return;
      }
    }
    if (message.type === "heartbeat") {
      debug("heartbeat received");
      return;
    }
    // 서버는 welcome 뒤에만 request를 보냅니다. welcome 전이면 답할 연결이 아니므로 무시합니다.
    if (message.type === "request" && this.welcome !== undefined) {
      debug(`request received id=${message.id} action=${message.action}`);
      const { onRequest } = this.options;
      if (onRequest !== undefined) {
        this.notify(() => onRequest(message));
      }
      return;
    }
    // 순서가 맞지 않는 welcome, reject, welcome 전의 request는 무시합니다.
    debug(`${message.type} ignored`);
  }

  private onWelcome(message: WelcomeMessage): void {
    this.clearTimer();
    const settings: ServerSettings = {
      metricsIntervalMs: message.metricsIntervalMs,
      maxEventsPerMinute: message.maxEventsPerMinute,
    };
    if (message.heartbeatIntervalMs !== undefined) {
      settings.heartbeatIntervalMs = message.heartbeatIntervalMs;
    }
    this.welcome = settings;
    this.failures = 0;
    debug(
      `welcome metricsIntervalMs=${message.metricsIntervalMs} maxEventsPerMinute=${message.maxEventsPerMinute} heartbeatIntervalMs=${message.heartbeatIntervalMs ?? "(none)"}`,
    );
    // heartbeat를 보내지 않는 서버(heartbeatIntervalMs 없음)에는 이 판단을 하지 않습니다.
    if (message.heartbeatIntervalMs !== undefined) {
      this.startLiveness(heartbeatTimeout(message.heartbeatIntervalMs));
    }
    // 처음 연결은 조용히 넘어가고, 장애를 알린 뒤의 복구만 알립니다.
    if (this.outageReported) {
      warn(`connected to ${this.label}`);
    }
    this.outageReported = false;
    this.reportedRejects.clear();
    const { onConnected } = this.options;
    if (onConnected !== undefined) {
      this.notify(() => onConnected(settings));
    }
  }

  private onReject(reason: string): void {
    this.rejected = true;
    if (!this.reportedRejects.has(reason)) {
      this.reportedRejects.add(reason);
      warn(`rejected by server: reason=${reason}; retrying`);
    }
    // reject 경고가 이번 장애의 경고를 대신합니다. 서버가 연결을 닫으면 onClose에서 재연결을 예약합니다.
    // 서버가 닫지 않아도 welcome 제한 시간이 지나면 끊습니다.
    this.outageReported = true;
  }

  private onError(socket: WebSocket, message: string): void {
    if (socket !== this.socket) {
      return;
    }
    // undici 6은 첫 연결이 실패하면 error만 보내고 close는 보내지 않으므로, error에서 연결을 끝냅니다.
    this.end(message === "" ? "WebSocket error" : message);
  }

  private onClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.socket) {
      return;
    }
    this.end(reason === "" ? `code ${code}` : `code ${code}, ${reason}`);
  }

  // 지금 소켓을 끝내고, 실행 중이면 재연결을 예약합니다.
  // 끝낸 뒤에는 this.socket이 바뀌므로 같은 소켓에 대해 두 번 불리지 않습니다.
  private end(detail: string): void {
    const socket = this.socket;
    const wasConnected = this.welcome !== undefined;
    const wasRejected = this.rejected;
    this.socket = undefined;
    this.welcome = undefined;
    this.rejected = false;
    this.clearTimer();
    this.stopLiveness();
    if (socket !== undefined) {
      closeQuietly(socket);
    }
    if (wasConnected) {
      this.notify(this.options.onDisconnected);
    }
    if (!this.running) {
      return;
    }

    if (!this.outageReported) {
      this.outageReported = true;
      warn(
        wasConnected
          ? `connection lost (${detail}); reconnecting`
          : `cannot connect to ${this.label} (${detail}); retrying in the background`,
      );
    }
    this.failures += 1;
    const delay = reconnectDelay(this.failures);
    const what = wasConnected
      ? "disconnected"
      : wasRejected
        ? "rejected"
        : "connect failed";
    debug(`${what} (${detail}); retry ${this.failures} in ${delay}ms`);
    this.setTimer(delay, () => this.connect());
  }

  // 연결됨·끊김 알림을 부릅니다. 받는 쪽에서 난 예외가 연결 처리를 멈추지 않게 따로 감쌉니다.
  private notify(callback: (() => void) | undefined): void {
    if (callback !== undefined) {
      guard(callback);
    }
  }

  // welcome 뒤 서버 메시지가 timeoutMs 동안 없으면 연결을 끝냅니다.
  // 끝낸 소켓은 서버가 답하지 않으면 CLOSING에 머물 수 있습니다(docs/guides/T08.md '사전 확인').
  private startLiveness(timeoutMs: number): void {
    this.stopLiveness();
    const watch = new LivenessWatch(timeoutMs);
    const timer = setInterval(
      () =>
        guard(() => {
          const check = watch.check();
          if (check.result === "skipped") {
            debug(
              `heartbeat check skipped (timer was ${Math.round(check.lateMs)}ms late)`,
            );
          } else if (check.result === "dead") {
            this.end(`no message from server within ${timeoutMs}ms`);
          }
        }),
      LIVENESS_CHECK_MS,
    );
    // SDK 타이머가 앱 종료를 막지 않게 합니다.
    timer.unref();
    this.liveness = { watch, timer };
  }

  private stopLiveness(): void {
    if (this.liveness !== undefined) {
      clearInterval(this.liveness.timer);
      this.liveness = undefined;
    }
  }

  private setTimer(ms: number, callback: () => void): void {
    this.clearTimer();
    const timer = setTimeout(() => {
      this.timer = undefined;
      guard(callback);
    }, ms);
    // SDK 타이머가 앱 종료를 막지 않게 합니다.
    timer.unref();
    this.timer = timer;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

// 연결 중이거나 열린 소켓을 닫습니다. 이미 닫혔거나 닫히는 중이면 아무 일도 하지 않습니다.
function closeQuietly(socket: WebSocket, code?: number): void {
  try {
    if (
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN
    ) {
      socket.close(code);
    }
  } catch (error) {
    debug(`close failed: ${describeError(error)}`);
  }
}
