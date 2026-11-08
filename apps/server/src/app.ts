// HTTP 경로입니다. 웹 화면용 조회 API는 T14에서 붙입니다.
import express from "express";
import type { Express } from "express";

export function createApp(): Express {
  const app = express();
  // 응답 헤더에 Express를 쓴다는 것을 드러내지 않습니다.
  app.disable("x-powered-by");

  // 쿠버네티스 probe와 개발 확인용입니다. 요청을 받을 수 있으면 200을 돌려줍니다.
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  return app;
}
