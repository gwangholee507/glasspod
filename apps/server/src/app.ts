// HTTP 경로입니다. 웹 화면용 조회 API와 SSE(docs/guides/T14.md), snapshot 조회(docs/guides/T09.md),
// 조치 실행과 조치 기록(docs/guides/T21.md)이 있습니다.
// /api의 응답은 모두 JSON(SSE 제외)이고, 실패는 { error, detail }입니다.
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type {
  ActionBody,
  ActionErrorBody,
  ActionsBody,
  ApiErrorBody,
  IsolationPlanBody,
  PodRef,
  QueryErrorCode,
  RulesBody,
  RulesView,
  StatusChangesBody,
} from "@glasspod/protocol";
import { parseActionRequest } from "./actions.js";
import type { ActionService } from "./actions.js";
import type { AgentRegistry } from "./agents.js";
import { rulesIn } from "./feed.js";
import type { PodFeed } from "./feed.js";
import { log } from "./log.js";
import type { AppStates } from "./pods.js";
import { requestSnapshot } from "./snapshot.js";
import { STREAM_HEADERS } from "./stream.js";
import type { StreamHub } from "./stream.js";
import { RETENTION_MS } from "./store/store.js";
import type { Store } from "./store/store.js";
import { stallLimitMs } from "./status.js";
import {
  metricSeriesBody,
  parseMetricsQuery,
  parseNamespaceQuery,
  podDetail,
  seriesPods,
  statusChangeItem,
} from "./views.js";

// 판단 변화 조회가 돌려주는 최대 건수입니다. 넘으면 최근 것만 돌려줍니다(결정 14).
export const MAX_STATUS_CHANGES_RESPONSE = 2_000;
// 조치 요청 본문의 상한입니다(docs/guides/T21.md 결정 5).
const ACTION_BODY_LIMIT = "16kb";

export interface AppDependencies {
  agents: AgentRegistry;
  apps: AppStates;
  store: Store;
  feed: PodFeed;
  streams: StreamHub;
  actions: ActionService;
  // 자동 규칙 보기입니다(RuleEngine, docs/guides/T28.md 결정 18). 없으면 규칙이 없는 것으로 답합니다.
  rules?: { view(): RulesView };
  // 시계열의 끊김 기준(3주기)에 씁니다(docs/guides/T19.md 결정 6).
  metricsIntervalMs: number;
  now?: () => number;
}

export function createApp(deps: AppDependencies): Express {
  const { agents, apps, store, feed, streams, actions } = deps;
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
    const podActions = await store.actions({ pod });
    const podRuleFirings = await store.ruleFirings({ pod });
    response.json(
      podDetail(
        item,
        apps.get(pod),
        records,
        serverTime,
        podActions,
        podRuleFirings,
      ),
    );
  });

  // 그래프용 시계열: 이 Pod와 같은 Deployment의 다른 Pod, 최근 30분입니다(docs/guides/T19.md 결정 5, 6).
  app.get("/api/pods/:namespace/:name/series", async (request, response) => {
    const pod: PodRef = {
      namespace: request.params.namespace,
      name: request.params.name,
    };
    const item = feed.item(pod);
    if (item === undefined) {
      sendError(response, 404, "pod-not-found", notFoundDetail(pod));
      return;
    }
    const query = parseMetricsQuery(request.query.metrics);
    if (!query.ok) {
      sendError(response, 400, "invalid-query", query.detail);
      return;
    }
    const serverTime = now();
    const since = serverTime - RETENTION_MS;
    const pods = await Promise.all(
      seriesPods(item, feed.list(pod.namespace).pods).map(async (ref) => ({
        pod: ref,
        records: (await store.podRecords(ref, since)).metrics,
      })),
    );
    response.json(
      metricSeriesBody(
        query.names,
        pods,
        stallLimitMs(deps.metricsIntervalMs),
        serverTime,
        since,
      ),
    );
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

  // 트래픽에서 빼기 미리 보기입니다(docs/guides/T23.md 결정 10). 뗄 라벨, 빠질 Service, 대신할 Pod를 만들 ReplicaSet입니다.
  // 쿠버네티스에서 Pod·ReplicaSet·Service를 읽으므로 최대 10초씩 걸릴 수 있습니다. 기록하지 않습니다.
  app.get(
    "/api/pods/:namespace/:name/isolation-plan",
    async (request, response) => {
      const pod: PodRef = {
        namespace: request.params.namespace,
        name: request.params.name,
      };
      const outcome = await actions.previewIsolation(pod);
      if (!outcome.ok) {
        sendError(
          response,
          outcome.failure.status,
          outcome.failure.error,
          outcome.failure.detail,
        );
        return;
      }
      const body: IsolationPlanBody = {
        serverTime: now(),
        pod,
        uid: outcome.uid,
        plan: outcome.plan,
      };
      response.json(body);
    },
  );

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

  // 조치 실행입니다(docs/guides/T21.md 결정 5, 6). JSON 본문만 받습니다. 다른 출처의 페이지는 CORS 사전 요청 없이 JSON을 보내지 못합니다.
  // 형식이 틀린 요청은 기록하지 않고, 그 밖은 결과와 상관없이 기록합니다.
  app.post(
    "/api/actions",
    (request, response, next) => {
      // 본문이 있는데 JSON이 아니면 거부합니다. 본문이 없으면(null) 아래에서 400입니다.
      if (request.is("application/json") === false) {
        sendError(
          response,
          415,
          "invalid-request",
          "Content-Type must be application/json",
        );
        return;
      }
      next();
    },
    express.json({ limit: ACTION_BODY_LIMIT }),
    async (request, response) => {
      const parsed = parseActionRequest(request.body);
      if (!parsed.ok) {
        sendError(response, 400, "invalid-request", parsed.detail);
        return;
      }
      const outcome = await actions.run(parsed.request, { kind: "user" });
      if (outcome.item.result === "succeeded") {
        const body: ActionBody = { serverTime: now(), action: outcome.item };
        response.json(body);
        return;
      }
      sendError(
        response,
        outcome.status,
        outcome.item.error ?? "kube-error",
        outcome.item.detail ?? "the action failed",
      );
    },
  );

  // 조치 기록입니다. 서버가 남긴 전부(최근 1,000건), 요청한 순서입니다(docs/guides/T21.md 결정 3, 11).
  app.get("/api/actions", async (request, response) => {
    const query = parseNamespaceQuery(request.query.namespace);
    if (!query.ok) {
      sendError(response, 400, "invalid-query", query.detail);
      return;
    }
    const body: ActionsBody = {
      serverTime: now(),
      actions: await store.actions(
        query.namespace === undefined ? {} : { namespace: query.namespace },
      ),
    };
    response.json(body);
  });

  // SSE: 연결 직후 목록 전체(pods), 그 뒤 판단 주기마다 바뀐 것(changes)을 보냅니다.
  // 자동 규칙 파일 상태, 규칙과 지금 상태, 규칙 기록입니다(docs/guides/T28.md 결정 18).
  app.get("/api/rules", async (request, response) => {
    const query = parseNamespaceQuery(request.query.namespace);
    if (!query.ok) {
      sendError(response, 400, "invalid-query", query.detail);
      return;
    }
    const view = deps.rules?.view() ?? { file: {}, rules: [] };
    const body: RulesBody = {
      serverTime: now(),
      ...rulesIn(view, query.namespace),
      firings: await store.ruleFirings(
        query.namespace === undefined ? {} : { namespace: query.namespace },
      ),
    };
    response.json(body);
  });

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
      // 본문을 읽다 난 오류(JSON이 아님, 너무 큼)는 요청이 틀린 것입니다. body-parser가 4xx와 expose를 붙입니다.
      const clientError = requestError(error);
      if (clientError !== undefined && !response.headersSent) {
        sendError(
          response,
          clientError.status,
          "invalid-request",
          clientError.detail,
        );
        return;
      }
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

// body-parser가 만든 4xx 오류면 상태 코드와 설명을, 아니면 undefined를 돌려줍니다.
function requestError(
  error: unknown,
): { status: number; detail: string } | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const { status, expose } = error as { status?: unknown; expose?: unknown };
  if (
    expose === true &&
    typeof status === "number" &&
    status >= 400 &&
    status < 500
  ) {
    return { status, detail: error.message };
  }
  return undefined;
}

function sendError(
  response: Response,
  status: number,
  error: QueryErrorCode | ActionErrorBody["error"],
  detail: string,
): void {
  const body: ApiErrorBody = { error, detail };
  response.status(status).json(body);
}
