// Glasspod 데모 앱입니다(docs/guides/T10.md).
// 주문 앱처럼 동작하면서 SDK로 상태를 보내고, 관리 포트의 고장 스위치로 일부러 문제를 일으킵니다.
// 실행: GLASSPOD_SERVER, POD_NAME, POD_NAMESPACE를 주고 npm run demo. 없으면 SDK만 꺼지고 앱은 동작합니다.
import { glasspod } from "@glasspod/sdk";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createAdminApp } from "./admin.js";
import { loadAppConfig } from "./config.js";
import { FakeDb } from "./db.js";
import { Faults } from "./faults.js";
import { describeError, log } from "./log.js";
import { OrderQueue, createOrdersApp } from "./orders.js";

// hello의 app입니다. version은 package.json의 version과 같게 둡니다.
const APP = { name: "demo-app", version: "0.0.0" };

// 신호를 받은 뒤 이 시간 안에 끝나지 않으면 강제로 끝냅니다.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadAppConfig(process.env);
  glasspod.start({ app: APP });

  const faults = new Faults();
  const db = new FakeDb(() => faults.slowDelayMs());
  const queue = new OrderQueue(db);
  const orders = createServer(createOrdersApp(queue, db));
  const admin = createServer(createAdminApp(faults));

  // SIGTERM(쿠버네티스)과 SIGINT(Ctrl+C)를 같은 방법으로 처리합니다. 두 번째 신호는 Node 기본 동작(바로 종료)입니다.
  const onSignal = (signal: NodeJS.Signals): void => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    shutdown(signal, { faults, queue, servers: [orders, admin] });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  orders.listen(config.port);
  admin.listen(config.adminPort, config.adminHost);
  await Promise.all([once(orders, "listening"), once(admin, "listening")]);
  glasspod.state("app.mode", "ready");
  log.info("demo-app started", {
    port: config.port,
    admin: `${config.adminHost}:${config.adminPort}`,
  });
}

interface Running {
  faults: Faults;
  queue: OrderQueue;
  servers: Server[];
}

// 새 요청을 받지 않고 하던 일을 마친 뒤 SDK 연결을 닫습니다.
// 내장 WebSocket이 이벤트 루프를 붙잡으므로 glasspod.stop()을 불러야 프로세스가 스스로 끝납니다(design.md 5.1).
function shutdown(signal: NodeJS.Signals, running: Running): void {
  log.info("shutting down", { signal });
  glasspod.state("app.mode", "draining");
  running.faults.clearAll();
  running.queue.stop();
  const forced = setTimeout(() => {
    log.warn("forced exit", { afterMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  const closed = running.servers.map(
    (server) =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  void Promise.all(closed).then(() => {
    glasspod.stop();
    log.info("demo-app stopped");
  });
}

main().catch((error: unknown) => {
  log.error("start failed", { detail: describeError(error) });
  // SDK 연결과 열린 서버가 이벤트 루프를 붙잡으므로 바로 끝냅니다.
  process.exit(1);
});
