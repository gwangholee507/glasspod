// Glasspod Node.js SDK입니다. 앱 안에서 Glasspod 서버에 WebSocket으로 붙습니다(design.md 5.1, 8장).
// metrics(T05)와 event(T06)는 이 연결 위에 더합니다.
import { randomUUID } from "node:crypto";
import { readConfig } from "./config.js";
import { Connection } from "./connection.js";
import { debug, describeError, warn } from "./log.js";

export interface StartOptions {
  // 감시 대상 앱의 이름과 버전입니다. hello의 app으로 보내고, 주지 않으면 보내지 않습니다.
  app?: { name: string; version?: string };
}

// SDK 상태는 프로세스에 하나입니다.
let connection: Connection | undefined;
// 프로세스에서 처음 start()할 때 만들고, stop() 뒤 다시 시작해도 그대로 씁니다(design.md 7.3).
let instanceId: string | undefined;
// SDK가 보내는 모든 메시지의 seq입니다. 0부터 하나씩 늘고 재연결해도 이어집니다(design.md 7.2).
let seq = 0;
const nextSeq = (): number => seq++;

// 서버 주소와 Pod 정보는 환경변수(GLASSPOD_SERVER, POD_NAME, POD_NAMESPACE)에서 읽습니다.
// 설정에 문제가 있으면 경고 한 줄을 남기고 아무것도 하지 않습니다. 앱으로 예외를 던지지 않습니다.
function start(options: StartOptions = {}): void {
  try {
    if (connection !== undefined) {
      debug("start ignored: already started");
      return;
    }
    // 전역 WebSocket은 Node 22부터 있습니다.
    if (typeof globalThis.WebSocket !== "function") {
      warn(
        "disabled: global WebSocket is not available (Node.js 22 or later is required)",
      );
      return;
    }
    const result = readConfig(process.env);
    if (!result.ok) {
      warn(`disabled: ${result.problems.join(", ")}`);
      return;
    }
    instanceId ??= randomUUID();
    const app = checkApp(options.app);
    connection = new Connection({
      ...result.config,
      instanceId,
      nextSeq,
      ...(app === undefined ? {} : { app }),
    });
    connection.start();
  } catch (error) {
    debug(`start failed: ${describeError(error)}`);
  }
}

// 연결을 닫고(종료 코드 1000) 재연결하지 않습니다. 다시 start()할 수 있습니다.
// 내장 WebSocket은 열린 연결이 이벤트 루프를 붙잡으므로, 이벤트 루프가 비기를 기다려 끝나는 앱은 종료 처리에서 부릅니다.
function stop(): void {
  try {
    connection?.stop();
  } catch (error) {
    debug(`stop failed: ${describeError(error)}`);
  } finally {
    connection = undefined;
  }
}

// hello 스키마에 맞지 않는 app은 보내지 않습니다. 보내면 서버가 hello를 거절합니다(invalid-hello).
function checkApp(app: StartOptions["app"]): StartOptions["app"] {
  if (app === undefined) {
    return undefined;
  }
  const { name, version } = app;
  const isText = (value: unknown): value is string =>
    typeof value === "string" && value !== "";
  if (!isText(name) || (version !== undefined && !isText(version))) {
    warn("app is not sent: app.name and app.version must be non-empty strings");
    return undefined;
  }
  return version === undefined ? { name } : { name, version };
}

export const glasspod = { start, stop };
