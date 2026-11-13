// Glasspod 서버를 시작합니다. HTTP(/health, /api)와 SDK WebSocket(/agent)을 같은 포트에서 받습니다.
import { createServer } from "node:http";
import { PROTOCOL_VERSION } from "@glasspod/protocol";
import { AGENT_PATH, attachAgentServer } from "./agent.js";
import { AgentRegistry } from "./agents.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { log } from "./log.js";

// 종료 신호를 받은 뒤 이 시간 안에 정리가 끝나지 않으면 강제로 끝냅니다.
const SHUTDOWN_TIMEOUT_MS = 5_000;
// 서버가 내려갈 때 SDK 연결을 닫는 WebSocket 종료 코드입니다(1001: going away).
const CLOSE_GOING_AWAY = 1001;

let config: ServerConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  log.error("invalid configuration", {
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

// hello를 받아들인 SDK 연결 목록입니다. HTTP API가 여기서 연결을 찾아 request를 보냅니다.
const agents = new AgentRegistry();
const server = createServer(createApp(agents));
const agentServer = attachAgentServer(server, config, agents);

server.on("error", (error) => {
  log.error("server error", { detail: error.message });
  process.exit(1);
});

server.listen(config.port, () => {
  log.info("server listening", {
    port: config.port,
    agentPath: AGENT_PATH,
    protocol: PROTOCOL_VERSION,
    metricsIntervalMs: config.metricsIntervalMs,
    maxEventsPerMinute: config.maxEventsPerMinute,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log.info("shutting down", { signal });

  for (const client of agentServer.clients) {
    client.close(CLOSE_GOING_AWAY, "server shutting down");
  }
  agentServer.close();
  server.close(() => process.exit(0));

  setTimeout(() => {
    log.warn("shutdown timed out, exiting", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
