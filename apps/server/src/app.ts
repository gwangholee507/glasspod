// HTTP 경로입니다. 웹 화면용 조회 API는 T14에서 붙입니다. snapshot 조회는 T09에서 먼저 만들었습니다.
import express from "express";
import type { Express } from "express";
import type { AgentRegistry } from "./agents.js";
import { requestSnapshot } from "./snapshot.js";

export function createApp(agents: AgentRegistry): Express {
  const app = express();
  // 응답 헤더에 Express를 쓴다는 것을 드러내지 않습니다.
  app.disable("x-powered-by");

  // 쿠버네티스 probe와 개발 확인용입니다. 요청을 받을 수 있으면 200을 돌려줍니다.
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  // Pod 하나의 지금 상태(snapshot)를 그 Pod의 SDK에 물어 돌려줍니다. 답을 기다리느라 최대 5초 걸립니다.
  // 상태 코드와 본문은 docs/guides/T09.md 'HTTP 상태 코드'에 있습니다.
  app.get("/api/pods/:namespace/:name/snapshot", async (request, response) => {
    const { namespace, name } = request.params;
    const reply = await requestSnapshot(agents, { namespace, name });
    response
      .set("Cache-Control", "no-store")
      .status(reply.status)
      .json(reply.body);
  });

  return app;
}
