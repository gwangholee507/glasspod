// 데모 앱에 요청을 보내는 부하 스크립트입니다(docs/guides/T10.md 결정 3, 19).
// 요청의 반은 주문 조회, 반은 주문 접수이고, 10초마다 요약 한 줄을 남깁니다.
// 실행: npm run demo:load. 설정은 LOAD_TARGET(기본 http://localhost:3000), LOAD_RPS(기본 10)입니다.
import { request } from "node:http";
import { loadLoadConfig } from "./config.js";
import { describeError, log } from "./log.js";
import { RateTicker } from "./rate.js";

// 답을 기다리는 요청 상한입니다. 앱이 막혀도 부하 스크립트가 요청을 끝없이 쌓지 않게 합니다.
const MAX_IN_FLIGHT = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const REPORT_INTERVAL_MS = 10_000;
// 주문 조회에 쓰는 id 범위입니다.
const ORDER_IDS = 1000;

type Outcome = "2xx" | "4xx" | "5xx" | "failed";

const counts = {
  sent: 0,
  "2xx": 0,
  "4xx": 0,
  "5xx": 0,
  failed: 0,
  skipped: 0,
};
let inFlight = 0;

// 데모 앱은 넘겨주기(3xx)를 하지 않으므로 400 미만은 모두 2xx로 셉니다.
function outcomeOf(status: number | undefined): Outcome {
  if (status === undefined) {
    return "failed";
  }
  return status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx";
}

function send(target: URL): void {
  if (inFlight >= MAX_IN_FLIGHT) {
    counts.skipped++;
    return;
  }
  const isGet = Math.random() < 0.5;
  const path = isGet
    ? `/orders/${1 + Math.floor(Math.random() * ORDER_IDS)}`
    : "/orders";
  inFlight++;
  counts.sent++;
  let done = false;
  const finish = (outcome: Outcome): void => {
    if (!done) {
      done = true;
      inFlight--;
      counts[outcome]++;
    }
  };
  // 요청마다 새 연결을 씁니다(agent: false는 Connection: close).
  // keep-alive 연결은 Service 뒤의 한 Pod에 붙어 있어, 격리한 뒤에도 트래픽이 그 Pod로 갑니다.
  const req = request(
    new URL(path, target),
    {
      method: isGet ? "GET" : "POST",
      agent: false,
      headers: isGet ? {} : { "content-length": "0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    (res) => {
      res.resume();
      res.on("error", () => finish("failed"));
      res.on("close", () =>
        finish(res.complete ? outcomeOf(res.statusCode) : "failed"),
      );
    },
  );
  req.on("error", () => finish("failed"));
  req.end();
}

function report(): void {
  log.info("load", { ...counts, inFlight });
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    counts[key] = 0;
  }
}

function main(): void {
  let config;
  try {
    config = loadLoadConfig(process.env);
  } catch (error) {
    log.error("invalid config", { detail: describeError(error) });
    process.exitCode = 1;
    return;
  }
  const { target, rps } = config;
  log.info("load started", { target: target.origin, rps });
  new RateTicker(rps, (count) => {
    for (let i = 0; i < count; i++) {
      send(target);
    }
  }).start();
  setInterval(report, REPORT_INTERVAL_MS);

  // 컨테이너에서는 node가 PID 1이라, 처리기가 없는 SIGTERM은 무시되고 유예 시간이 지나야 끝납니다(docs/guides/T15.md).
  // 기다리는 요청은 버리고 바로 끝냅니다.
  const onSignal = (signal: NodeJS.Signals): void => {
    log.info("load stopped", { signal, inFlight });
    process.exit(0);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

main();
