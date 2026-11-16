// HTTP 경로입니다. 웹 화면용 조회 API와 SSE(docs/guides/T14.md), snapshot 조회(docs/guides/T09.md)가 있습니다.
// /api의 응답은 모두 JSON(SSE 제외)이고, 실패는 { error, detail }입니다.
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type {
  ApiErrorBody,
  PodRef,
  QueryErrorCode,
  StatusChangesBody,
} from "@glasspod/protocol";
import type { AgentRegistry } from "./agents.js";
import type { PodFeed } from "./feed.js";
import { log } from "./log.js";
import type { AppStates } from "./pods.js";
import { requestSnapshot } from "./snapshot.js";
import { STREAM_HEADERS } from "./stream.js";
import type { StreamHub } from "./stream.js";
import { RETENTION_MS } from "./store/store.js";
import type { Store } from "./store/store.js";
import { parseNamespaceQuery, podDetail, statusChangeItem } from "./views.js";

// 판단 변화 조회가 돌려주는 최대 건수입니다. 넘으면 최근 것만 돌려줍니다(결정 14).
export const MAX_STATUS_CHANGES_RESPONSE = 2_000;

export interface AppDependencies {
  agents: AgentRegistry;
  apps: AppStates;
  store: Store;
  feed: PodFeed;
  streams: StreamHub;
  now?: () => number;
}

export function createApp(deps: AppDependencies): Express {
  const { agents, apps, store, feed, streams } = deps;
  const now = deps.now ?? Date.now;
  const app = express();
  // 응답 헤더에 Express를 쓴다는 것을 드러내지 않습니다.
  app.disable("x-powered-by");

  // 쿠버네티스 probe와 개발 확인용입니다. 요청을 받을 수 있으면 200을 돌려줍니다.
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  // 조회 API의 응답은 캐시하지 않습니다(결정 5).
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  // 목록: Pod 항목과 Deployment 요약입니다. 마지막 판단 주기의 값입니다.
  app.get("/api/pods", (request, response) => {
    const query = parseNamespaceQuery(request.query.namespace);
    if (!query.ok) {
      sendError(response, 400, "invalid-query", query.detail);
      return;
    }
    response.json(feed.list(query.namespace));
  });

  // 상세: 판단, 마지막 지표 값, 최근 30분 event·연결·판단 변화, 재시작 원인 후보입니다.
  app.get("/api/pods/:namespace/:name", async (request, response) => {
    const pod: PodRef = {
      namespace: request.params.namespace,
      name: request.params.name,
    };
    const item = feed.item(pod);
    if (item === undefined) {
      sendError(response, 404, "pod-not-found", notFoundDetail(pod));
      return;
    }
    const serverTime = now();
    const records = await store.podRecords(pod, serverTime - RETENTION_MS);
    response.json(podDetail(item, apps.get(pod), records, serverTime));
  });

  // Pod 하나의 지금 상태(snapshot)를 그 Pod의 SDK에 물어 돌려줍니다. 답을 기다리느라 최대 5초 걸립니다.
  // 상태 코드와 본문은 docs/guides/T09.md 'HTTP 상태 코드'와 T14 결정 6에 있습니다.
  app.get("/api/pods/:namespace/:name/snapshot", async (request, response) => {
    const { namespace, name } = request.params;
    const reply = await requestSnapshot(
      agents,
      { namespace, name },
      (pod) => feed.item(pod) !== undefined,
    );
    response.status(reply.status).json(reply.body);
  });

  // 최근 30분 판단 변화입니다. 일어난 순서이고, 최근 2,000건까지입니다.
  app.get("/api/status-changes", async (request, response) => {
    const query = parseNamespaceQuery(request.query.namespace);
    if (!query.ok) {
      sendError(response, 400, "invalid-query", query.detail);
      return;
    }
    const serverTime = now();
    const records = await store.statusChanges(
      serverTime - RETENTION_MS,
      query.namespace,
    );
    const body: StatusChangesBody = {
      serverTime,
      changes: records
        .slice(-MAX_STATUS_CHANGES_RESPONSE)
        .map(statusChangeItem),
    };
    response.json(body);
  });

  // SSE: 연결 직후 목록 전체(pods), 그 뒤 판단 주기마다 바뀐 것(changes)을 보냅니다.
  app.get("/api/stream", (request, response) => {
    const query = parseNamespaceQuery(request.query.namespace);
    if (!query.ok) {
      sendError(response, 400, "invalid-query", query.detail);
      return;
    }
    const remote = request.socket.remoteAddress;
    if (streams.full) {
      log.warn("stream rejected", {
        remote,
        reason: "too-many-streams",
        limit: streams.limit,
      });
      sendError(
        response,
        503,
        "too-many-streams",
        `${streams.limit} streams are already open`,
      );
      return;
    }
    response.writeHead(200, STREAM_HEADERS);
    response.flushHeaders();
    const handle = streams.open(
      response,
      { remote, namespace: query.namespace },
      feed.list(query.namespace),
    );
    // 브라우저가 끊거나 서버가 소켓을 닫으면 목록에서 뺍니다. 이미 빠졌으면(느린 연결, 종료) 아무 일도 없습니다.
    response.on("close", () => handle.release("client"));
  });

  // 없는 /api 경로입니다.
  app.use("/api", (request, response) => {
    sendError(
      response,
      404,
      "not-found",
      `no API route for ${request.method} ${request.path}`,
    );
  });

  // 처리하지 못한 예외입니다. Express 기본 처리기의 HTML 대신 JSON으로 답합니다.
  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      log.error("api failed", {
        method: request.method,
        path: request.path,
        detail: error instanceof Error ? error.message : String(error),
      });
      if (response.headersSent) {
        next(error);
        return;
      }
      sendError(response, 500, "internal-error", "the server failed to answer");
    },
  );

  return app;
}

function notFoundDetail(pod: PodRef): string {
  return `no pod ${pod.namespace}/${pod.name} is known to the server`;
}

function sendError(
  response: Response,
  status: number,
  error: QueryErrorCode,
  detail: string,
): void {
  const body: ApiErrorBody = { error, detail };
  response.status(status).json(body);
}
