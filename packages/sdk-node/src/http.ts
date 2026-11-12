// HTTP 요청 자동 수집입니다(design.md 5.1, 7.3, docs/guides/T07.md).
// Express 미들웨어로 요청 수, 오류, 끊긴 요청, 응답 시간, 처리 중인 요청 수를 모으고,
// 오류 미들웨어로 Express가 잡은 예외를 route와 함께 넘깁니다. SDK는 Express에 의존하지 않습니다.
import type { MetricValue } from "@glasspod/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHistogram, performance } from "node:perf_hooks";
import type { RecordableHistogram } from "node:perf_hooks";
import { guard } from "./guard.js";
import { debug, describeError } from "./log.js";
import { truncate } from "./reports.js";

// route 글자 수 상한입니다. 라우트 경로는 개발자가 정하므로 보통은 닿지 않습니다.
export const MAX_ROUTE_CHARS = 200;

// Express의 next와 같은 모양입니다. 값을 주면 오류로 넘깁니다.
export type NextFunction = (error?: unknown) => void;

// app.use()에 넣는 미들웨어입니다. Express와 Connect 방식 앱에서 씁니다.
export type HttpMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFunction,
) => void;

// app.use()에 넣는 오류 미들웨어입니다. Express는 인자가 네 개인 함수를 오류 미들웨어로 봅니다.
export type HttpErrorMiddleware = (
  error: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFunction,
) => void;

// Express가 잡은 예외를 보냅니다. route는 알 수 없으면 undefined입니다.
export type ReportError = (error: unknown, route: string | undefined) => void;

// 이 파일이 읽는 Express의 req 값입니다. Express가 아니면 없을 수 있습니다.
interface ExpressRequestFields {
  baseUrl?: unknown;
  route?: unknown;
}

export class HttpCollector {
  // express()를 한 번이라도 불렀는지입니다. 부르지 않은 앱은 http.* 값을 보내지 않습니다.
  private used = false;
  // 이미 센 요청입니다. 미들웨어가 두 번 등록돼도 한 번만 셉니다.
  private readonly tracked = new WeakSet<object>();
  // Express가 req.route를 대입한 순간의 route입니다(마운트 경로 포함).
  private readonly routes = new WeakMap<object, string>();
  private total = 0;
  private errors = 0;
  private aborted = 0;
  private inFlight = 0;
  // 끝난 요청의 응답 시간(마이크로초)입니다. collect()마다 비웁니다.
  private readonly durations: RecordableHistogram = createHistogram();

  // 요청을 세는 미들웨어를 만듭니다. 가능한 한 앞에, 세지 않을 라우트 뒤에 둡니다.
  middleware(): HttpMiddleware {
    this.used = true;
    debug("http middleware created");
    return (req, res, next) => {
      guard(() => this.track(req, res));
      // next()를 guard 밖에서 부릅니다. 안에서 부르면 앱의 다음 미들웨어에서 난 예외를 SDK가 삼킵니다.
      next();
    };
  }

  // Express가 잡은 예외를 report로 넘기는 오류 미들웨어를 만듭니다. 라우트 뒤, 앱의 오류 처리기 앞에 둡니다.
  // 넘긴 뒤에는 항상 next(error)를 불러 앱의 오류 처리를 그대로 둡니다.
  errorMiddleware(report: ReportError): HttpErrorMiddleware {
    debug("http error middleware created");
    // 인자 네 개를 그대로 둡니다. Express는 함수의 length가 4인지로 오류 미들웨어를 알아봅니다.
    return (error, req, _res, next) => {
      guard(() => {
        const status = errorStatus(error);
        if (status !== undefined && status < 500) {
          debug(`express error not reported: status ${status}`);
          return;
        }
        const route = this.routes.get(req) ?? describeRoute(req, routeOf(req));
        report(error, route);
        debug(`express error reported route=${route ?? "(none)"}`);
      });
      next(error);
    };
  }

  // 지난 collect() 뒤에 끝난 요청의 응답 시간을 버립니다. 연결될 때 불러, 첫 묶음이 한 주기만 덮게 합니다.
  resetDurations(): void {
    this.durations.reset();
  }

  // 보낼 http.* 값을 모으고 응답 시간 기록을 비웁니다. express()를 부르지 않았으면 빈 배열입니다.
  collect(): MetricValue[] {
    if (!this.used) {
      return [];
    }
    const values: MetricValue[] = [
      { name: "http.requests.total", kind: "counter", value: this.total },
      {
        name: "http.requests.errors_total",
        kind: "counter",
        value: this.errors,
      },
      {
        name: "http.requests.aborted_total",
        kind: "counter",
        value: this.aborted,
      },
    ];
    // 이 주기에 끝난 요청이 없으면 응답 시간은 보내지 않습니다.
    if (this.durations.count > 0) {
      const gauge = (name: string, us: number): void => {
        values.push({ name, kind: "gauge", value: us / 1000 });
      };
      gauge("http.requests.duration_p50_ms", this.durations.percentile(50));
      gauge("http.requests.duration_p99_ms", this.durations.percentile(99));
      gauge("http.requests.duration_max_ms", this.durations.max);
    }
    this.durations.reset();
    values.push({
      name: "http.requests.in_flight",
      kind: "gauge",
      value: this.inFlight,
    });
    return values;
  }

  private track(req: IncomingMessage, res: ServerResponse): void {
    if (this.tracked.has(req)) {
      return;
    }
    this.tracked.add(req);
    const startedAt = performance.now();
    this.inFlight += 1;
    this.watchRoute(req);
    // close는 응답을 마쳤을 때도, 그 전에 연결이 끊겼을 때도 옵니다(docs/guides/T07.md '사전 확인').
    res.once("close", () =>
      guard(() =>
        this.finish(
          performance.now() - startedAt,
          res.writableFinished,
          res.statusCode,
        ),
      ),
    );
  }

  private finish(durationMs: number, finished: boolean, status: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.total += 1;
    if (!finished) {
      this.aborted += 1;
    } else if (status >= 500) {
      this.errors += 1;
    }
    // 히스토그램은 1 이상의 정수만 받으므로 마이크로초로 반올림하고 최소 1로 둡니다.
    this.durations.record(Math.max(1, Math.round(durationMs * 1000)));
  }

  // Express는 오류 미들웨어를 부르기 전에 req.baseUrl을 되돌립니다. 그래서 req.route가 대입되는 순간의
  // baseUrl을 기억해 마운트 경로를 얻습니다. 앱이 읽고 쓰는 req.route 값은 그대로입니다.
  private watchRoute(req: IncomingMessage): void {
    try {
      let current: unknown = (req as ExpressRequestFields).route;
      Object.defineProperty(req, "route", {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (value: unknown) => {
          current = value;
          guard(() => {
            const route = describeRoute(req, value);
            if (route === undefined) {
              this.routes.delete(req);
            } else {
              this.routes.set(req, route);
            }
          });
        },
      });
    } catch (error) {
      debug(`http route watch failed: ${describeError(error)}`);
    }
  }
}

// Express 라우트를 'METHOD 마운트경로+라우트경로'로 만듭니다(예: GET /orders/:id). 라우트가 없으면 undefined입니다.
export function describeRoute(
  req: IncomingMessage,
  route: unknown,
): string | undefined {
  if (typeof route !== "object" || route === null) {
    return undefined;
  }
  const path: unknown = (route as { path?: unknown }).path;
  if (path === undefined || path === null) {
    return undefined;
  }
  const routePath = Array.isArray(path)
    ? path.map(String).join(",")
    : String(path);
  const baseUrl = (req as ExpressRequestFields).baseUrl;
  const base = typeof baseUrl === "string" ? baseUrl : "";
  // 마운트된 Router의 / 라우트는 마운트 경로만 씁니다(/orders/가 아니라 /orders).
  const full = base !== "" && routePath === "/" ? base : `${base}${routePath}`;
  return truncate(`${req.method ?? "?"} ${full}`, MAX_ROUTE_CHARS);
}

function routeOf(req: IncomingMessage): unknown {
  return (req as ExpressRequestFields).route;
}

// 예외에 붙은 HTTP 상태 코드입니다. Express 기본 오류 처리기처럼 status, statusCode 순서로 400~599만 봅니다.
export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const fields = error as { status?: unknown; statusCode?: unknown };
  for (const value of [fields.status, fields.statusCode]) {
    if (typeof value === "number" && value >= 400 && value < 600) {
      return value;
    }
  }
  return undefined;
}
