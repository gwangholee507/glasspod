import type { MetricValue } from "@glasspod/protocol";
import { EventEmitter } from "node:events";
import { createServer, get } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpCollector,
  MAX_IN_FLIGHT,
  MAX_ROUTE_CHARS,
  describeRoute,
} from "./http.js";

// 이름으로 값을 찾기 쉽게 바꿉니다.
function byName(values: MetricValue[]): Record<string, number> {
  return Object.fromEntries(values.map((value) => [value.name, value.value]));
}

const DURATIONS = [
  "http.requests.duration_p50_ms",
  "http.requests.duration_p99_ms",
  "http.requests.duration_max_ms",
];

// Express 없이 node:http 서버에 미들웨어를 붙입니다.
function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// Express가 하는 일 가운데 이 파일이 쓰는 부분(req.baseUrl, req.route)만 흉내 낸 요청과 응답입니다.
function fakeExchange(fields: Record<string, unknown> = {}): {
  req: IncomingMessage & { baseUrl?: string; route?: unknown };
  res: ServerResponse;
} {
  const req = {
    method: "GET",
    baseUrl: "",
    ...fields,
  } as unknown as IncomingMessage & { baseUrl?: string; route?: unknown };
  const res = Object.assign(new EventEmitter(), {
    writableFinished: true,
    statusCode: 200,
  }) as unknown as ServerResponse;
  return { req, res };
}

describe("HttpCollector metrics", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  it("sends nothing until a middleware is created", () => {
    expect(new HttpCollector().collect()).toEqual([]);
  });

  it("counts finished, failed and aborted requests with durations and in-flight", async () => {
    const http = new HttpCollector();
    const middleware = http.middleware();
    let hangArrived: () => void = () => {};
    const arrived = new Promise<void>((resolve) => (hangArrived = resolve));
    let hangClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => (hangClosed = resolve));
    const started = await listen((req, res) =>
      middleware(req, res, () => {
        if (req.url === "/slow") {
          setTimeout(() => res.end("late"), 30);
        } else if (req.url === "/fail") {
          res.statusCode = 500;
          res.end();
        } else if (req.url === "/missing") {
          res.statusCode = 404;
          res.end();
        } else if (req.url === "/hang") {
          // 응답하지 않습니다. 클라이언트가 끊으면 close가 옵니다.
          res.on("close", hangClosed);
          hangArrived();
        } else {
          res.end("ok");
        }
      }),
    );
    server = started.server;

    for (const path of ["/ok", "/slow", "/fail", "/missing"]) {
      await (await fetch(`${started.url}${path}`)).text();
    }
    const client = get(`${started.url}/hang`);
    client.on("error", () => {});
    await arrived;

    const first = byName(http.collect());
    expect(first["http.requests.total"]).toBe(4);
    expect(first["http.requests.errors_total"]).toBe(1);
    expect(first["http.requests.aborted_total"]).toBe(0);
    expect(first["http.requests.in_flight"]).toBe(1);
    expect(first["http.requests.duration_max_ms"]).toBeGreaterThanOrEqual(25);
    expect(first["http.requests.duration_p50_ms"]).toBeGreaterThan(0);

    // 응답 전에 클라이언트가 끊습니다. 오류가 아니라 끊긴 요청으로 셉니다.
    client.destroy();
    await closed;
    const second = byName(http.collect());
    expect(second["http.requests.total"]).toBe(5);
    expect(second["http.requests.errors_total"]).toBe(1);
    expect(second["http.requests.aborted_total"]).toBe(1);
    expect(second["http.requests.in_flight"]).toBe(0);
    expect(second["http.requests.duration_max_ms"]).toBeGreaterThan(0);

    // 이 주기에 끝난 요청이 없으면 응답 시간은 보내지 않습니다. counter는 그대로입니다.
    const third = http.collect();
    expect(third.map((value) => value.name)).toEqual([
      "http.requests.total",
      "http.requests.errors_total",
      "http.requests.aborted_total",
      "http.requests.in_flight",
    ]);
    expect(byName(third)["http.requests.total"]).toBe(5);
  });

  it("counts a request once when the middleware runs twice", async () => {
    const http = new HttpCollector();
    const outer = http.middleware();
    const inner = http.middleware();
    const started = await listen((req, res) =>
      outer(req, res, () => inner(req, res, () => res.end("ok"))),
    );
    server = started.server;
    await (await fetch(started.url)).text();
    // 응답의 close는 클라이언트가 본문을 받은 뒤에도 조금 늦게 올 수 있습니다.
    await vi.waitFor(() =>
      expect(byName(http.collect())["http.requests.in_flight"]).toBe(0),
    );
    expect(byName(http.collect())["http.requests.total"]).toBe(1);
  });

  it("does not swallow errors thrown by the next middleware", () => {
    const { req, res } = fakeExchange();
    const middleware = new HttpCollector().middleware();
    expect(() =>
      middleware(req, res, () => {
        throw new Error("app error");
      }),
    ).toThrow("app error");
  });
});

describe("HttpCollector in-flight requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists unfinished requests oldest first, with the route shape or only the method", () => {
    const http = new HttpCollector();
    const middleware = http.middleware();
    const clock = vi.spyOn(performance, "now");

    clock.mockReturnValue(1000);
    const routed = fakeExchange({ method: "GET", baseUrl: "/orders" });
    middleware(routed.req, routed.res, () => {});
    // Express가 라우트를 정하면 라우트 모양을 씁니다.
    routed.req.route = { path: "/:id" };
    clock.mockReturnValue(1500);
    // 라우트 앞 미들웨어(예: 본문 파싱)에서 기다리는 요청은 메서드만 씁니다.
    const waiting = fakeExchange({ method: "POST" });
    middleware(waiting.req, waiting.res, () => {});
    clock.mockReturnValue(1800);
    const finished = fakeExchange();
    middleware(finished.req, finished.res, () => {});
    finished.res.emit("close");

    expect(http.inFlightRequests(9200.4)).toEqual([
      { route: "GET /orders/:id", elapsedMs: 8200 },
      { route: "POST", elapsedMs: 7700 },
    ]);
    expect(byName(http.collect())["http.requests.in_flight"]).toBe(2);

    routed.res.emit("close");
    expect(http.inFlightRequests(9300)).toEqual([
      { route: "POST", elapsedMs: 7800 },
    ]);
  });

  it(`keeps only the oldest ${MAX_IN_FLIGHT} requests`, () => {
    const http = new HttpCollector();
    const middleware = http.middleware();
    const clock = vi.spyOn(performance, "now");
    for (let i = 0; i <= MAX_IN_FLIGHT; i += 1) {
      clock.mockReturnValue(i);
      const { req, res } = fakeExchange();
      middleware(req, res, () => {});
    }
    const list = http.inFlightRequests(1000);
    expect(list).toHaveLength(MAX_IN_FLIGHT);
    expect(list[0]?.elapsedMs).toBe(1000);
    expect(list.at(-1)?.elapsedMs).toBe(1000 - (MAX_IN_FLIGHT - 1));
  });

  it("is empty when no middleware was created", () => {
    expect(new HttpCollector().inFlightRequests()).toEqual([]);
  });
});

describe("HttpCollector error middleware", () => {
  it("reports the route with its mount path and always passes the error on", () => {
    const http = new HttpCollector();
    const middleware = http.middleware();
    const report = vi.fn();
    const errors = http.errorMiddleware(report);
    // Express는 인자가 네 개인 함수만 오류 미들웨어로 봅니다.
    expect(errors.length).toBe(4);

    const { req, res } = fakeExchange({ method: "GET" });
    middleware(req, res, () => {});
    // Express가 /orders에 마운트한 Router에서 라우트를 정하고, 오류 처리 전에 baseUrl을 되돌리는 모습입니다.
    req.baseUrl = "/orders";
    const route = { path: "/:id" };
    req.route = route;
    req.baseUrl = "";
    // 앱이 읽는 req.route는 그대로입니다.
    expect(req.route).toBe(route);

    const error = new Error("DB timeout");
    const next = vi.fn();
    errors(error, req, res, next);
    expect(report).toHaveBeenCalledWith(error, "GET /orders/:id");
    expect(next).toHaveBeenCalledWith(error);
  });

  it("skips client errors (4xx) but reports server errors", () => {
    const http = new HttpCollector();
    const report = vi.fn();
    const errors = http.errorMiddleware(report);
    const next = vi.fn();
    const { req, res } = fakeExchange({ route: { path: "/items" } });

    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const badBody = Object.assign(new Error("bad json"), { statusCode: 400 });
    const unavailable = Object.assign(new Error("down"), { statusCode: 503 });
    // 범위 밖의 status는 Express처럼 무시하고 500으로 봅니다.
    const odd = Object.assign(new Error("odd"), { status: 200 });
    for (const error of [notFound, badBody, unavailable, odd, "text"]) {
      errors(error, req, res, next);
    }
    expect(report.mock.calls).toEqual([
      [unavailable, "GET /items"],
      [odd, "GET /items"],
      ["text", "GET /items"],
    ]);
    expect(next).toHaveBeenCalledTimes(5);
  });

  it("reports without a route when no route matched, and survives a failing report", () => {
    const http = new HttpCollector();
    const next = vi.fn();
    const { req, res } = fakeExchange();
    const report = vi.fn();
    http.errorMiddleware(report)(new Error("auth"), req, res, next);
    expect(report).toHaveBeenCalledWith(expect.any(Error), undefined);

    const throwing = http.errorMiddleware(() => {
      throw new Error("sdk bug");
    });
    expect(() => throwing(new Error("x"), req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe("describeRoute", () => {
  const req = (method: string, baseUrl: string): IncomingMessage =>
    ({ method, baseUrl }) as unknown as IncomingMessage;

  it("joins the method, mount path and route path", () => {
    expect(describeRoute(req("GET", ""), { path: "/top/:x" })).toBe(
      "GET /top/:x",
    );
    expect(describeRoute(req("POST", "/orders"), { path: "/:id" })).toBe(
      "POST /orders/:id",
    );
    expect(describeRoute(req("GET", "/orders"), { path: "/" })).toBe(
      "GET /orders",
    );
    expect(describeRoute(req("GET", ""), { path: ["/a", "/b"] })).toBe(
      "GET /a,/b",
    );
    expect(describeRoute(req("GET", ""), { path: /^\/v\d+$/ })).toBe(
      "GET /^\\/v\\d+$/",
    );
  });

  it("returns undefined without a route and caps the length", () => {
    expect(describeRoute(req("GET", ""), undefined)).toBeUndefined();
    expect(describeRoute(req("GET", ""), {})).toBeUndefined();
    const long = describeRoute(req("GET", ""), { path: `/${"a".repeat(300)}` });
    expect(long).toHaveLength(MAX_ROUTE_CHARS + 3);
    expect(long?.endsWith("...")).toBe(true);
  });
});
