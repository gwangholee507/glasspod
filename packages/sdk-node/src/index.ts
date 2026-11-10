// Glasspod Node.js SDK입니다. 앱 안에서 Glasspod 서버에 WebSocket으로 붙습니다(design.md 5.1, 8장).
// 연결된 동안 주기마다 metrics를 보내고(T05), 일이 생기자마자 event를 보냅니다(T06).
import { randomUUID } from "node:crypto";
import { readConfig } from "./config.js";
import { Connection } from "./connection.js";
import { watchCrashes } from "./crash.js";
import type { OnCrash } from "./crash.js";
import { EventAggregator } from "./events.js";
import { debug, describeError, warn, WarnOnce } from "./log.js";
import { MetricsReporter } from "./metrics.js";
import { Registry } from "./registry.js";
import type { Counter } from "./registry.js";
import { customEventContent, exceptionContent } from "./reports.js";
import type { EventOptions } from "./reports.js";
import { RuntimeSampler } from "./runtime.js";
import { StateStore } from "./states.js";

export type { Counter, EventOptions };

export interface StartOptions {
  // 감시 대상 앱의 이름과 버전입니다. hello의 app으로 보내고, 주지 않으면 보내지 않습니다.
  app?: { name: string; version?: string };
}

// SDK 상태는 프로세스에 하나입니다.
let connection: Connection | undefined;
// 개발자가 등록한 app.* 지표입니다. start() 전에도, SDK가 꺼져 있어도 등록할 수 있습니다.
const registry = new Registry();
// 프로세스에서 처음 start()할 때 만들고, stop() 뒤 다시 시작해도 그대로 씁니다(design.md 7.3).
let instanceId: string | undefined;
// SDK가 보내는 모든 메시지의 seq입니다. 0부터 하나씩 늘고 재연결해도 이어집니다(design.md 7.2).
let seq = 0;
const nextSeq = (): number => seq++;
// event 사용 실수 경고를 한 번씩만 남깁니다.
const warnings = new WarnOnce();
// 개발자가 정한 상태 값입니다. 연결이 없어도 기억합니다.
const states = new StateStore(warnings);
// 같은 이벤트를 묶고 1분 한도를 지켜 보냅니다. 연결이 없으면 버립니다(보관은 T08).
const events = new EventAggregator(
  (content, ts, count) =>
    connection?.send((seq) => ({ type: "event", seq, ts, count, ...content })),
  () => connection?.settings?.maxEventsPerMinute,
);
// 처리되지 않은 예외 감시를 끄는 함수입니다. start()가 연결을 만들 때 켭니다.
let unwatchCrashes: (() => void) | undefined;

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
    // welcome을 받으면 metrics를 보내기 시작하고, 연결이 끝나면 멈춥니다.
    const reporter = new MetricsReporter(
      new RuntimeSampler(),
      registry,
      (values) =>
        current.send((seq) => ({
          type: "metrics",
          seq,
          ts: Date.now(),
          values,
        })),
    );
    const current = new Connection({
      ...result.config,
      instanceId,
      nextSeq,
      ...(app === undefined ? {} : { app }),
      onConnected: (settings) => reporter.begin(settings.metricsIntervalMs),
      onDisconnected: () => reporter.end(),
    });
    connection = current;
    unwatchCrashes = watchCrashes(onCrash);
    current.start();
  } catch (error) {
    debug(`start failed: ${describeError(error)}`);
  }
}

// 처리되지 않은 예외입니다. 프로세스가 끝나면 기다리지 않고 바로 보내고, 살아남으면 보통 이벤트처럼 묶습니다.
const onCrash: OnCrash = (error, origin, fatal) => {
  const extra = fatal ? { origin, fatal: true } : { origin };
  const content = exceptionContent(error, undefined, extra, warnings);
  if (!fatal) {
    events.record(content);
    return;
  }
  const result = events.flushFatal(content);
  debug(
    result === undefined
      ? `crash not reported (not connected or event limit 0) origin=${origin}`
      : `crash reported seq=${result.seq} origin=${origin} fatal=true pending=${result.flushed}`,
  );
};

// 연결을 닫고(종료 코드 1000) 재연결하지 않습니다. 다시 start()할 수 있습니다.
// 내장 WebSocket은 열린 연결이 이벤트 루프를 붙잡으므로, 이벤트 루프가 비기를 기다려 끝나는 앱은 종료 처리에서 부릅니다.
function stop(): void {
  try {
    unwatchCrashes?.();
    events.reset();
    connection?.stop();
  } catch (error) {
    debug(`stop failed: ${describeError(error)}`);
  } finally {
    unwatchCrashes = undefined;
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

// 지금 값을 보내는 app.* 지표를 등록합니다. 보낼 때마다 read를 부르므로 가볍고 동기로 끝나는 콜백을 씁니다.
// 같은 이름을 다시 등록하면 새 콜백으로 바꿉니다. 이름이 잘못됐으면 경고만 남기고 등록하지 않습니다.
function gauge(name: string, read: () => number): void {
  registry.gauge(name, read);
}

// 누적값을 보내는 app.* 지표를 만듭니다. 같은 이름이면 같은 counter를 돌려줍니다.
// 이름이 잘못됐으면 경고만 남기고, 아무 일도 하지 않는 counter를 돌려줍니다.
function counter(name: string): Counter {
  return registry.counter(name);
}

// 앱이 잡은 예외를 보고합니다(name: exception, level: error). errorType과 stack은 SDK가 채웁니다.
// data는 함께 보낼 값입니다(예: { route: "GET /orders" }). 같은 예외가 쏟아지면 묶어서 보냅니다.
function exception(error: unknown, data?: Record<string, unknown>): void {
  try {
    events.record(exceptionContent(error, data, undefined, warnings));
  } catch (caught) {
    debug(`exception failed: ${describeError(caught)}`);
  }
}

// 상태 값을 정합니다(이름은 app.*, 값은 문자열). 값이 바뀔 때만 state 이벤트를 보냅니다.
function state(name: string, value: string): void {
  try {
    const content = states.set(name, value);
    if (content !== undefined) {
      events.record(content);
    }
  } catch (error) {
    debug(`state failed: ${describeError(error)}`);
  }
}

// 개발자가 정의한 이벤트를 보냅니다(이름은 app.*). level은 info(기본), warn, error입니다.
function event(name: string, options?: EventOptions): void {
  try {
    const content = customEventContent(name, options, warnings);
    if (content !== undefined) {
      events.record(content);
    }
  } catch (error) {
    debug(`event failed: ${describeError(error)}`);
  }
}

export const glasspod = {
  start,
  stop,
  gauge,
  counter,
  exception,
  state,
  event,
};
