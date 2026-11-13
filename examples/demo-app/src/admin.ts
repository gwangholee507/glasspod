// 관리 포트의 HTTP API입니다. 고장 스위치를 켜고 끕니다(docs/guides/T10.md 결정 1, 13, '고장 스위치').
// 주문 API와 다른 포트이고 glasspod.express()를 두지 않아, 이 요청은 http.* 지표에 들어가지 않습니다.
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { InvalidValueError } from "./config.js";
import {
  blockParams,
  crashParams,
  errorsParams,
  leakParams,
  slowParams,
} from "./faults.js";
import type { Faults } from "./faults.js";

export function createAdminApp(faults: Faults): Express {
  const app = express();
  const sendState = (res: Response): void => {
    res.json(faults.state());
  };

  app.get("/faults", (_req, res) => sendState(res));
  app.delete("/faults", (_req, res) => {
    faults.clearAll();
    sendState(res);
  });

  app.post("/faults/slow", (req, res) => {
    faults.setSlow(slowParams(req.query));
    sendState(res);
  });
  app.delete("/faults/slow", (_req, res) => {
    faults.clearSlow();
    sendState(res);
  });

  app.post("/faults/errors", (req, res) => {
    faults.setErrors(errorsParams(req.query));
    sendState(res);
  });
  app.delete("/faults/errors", (_req, res) => {
    faults.clearErrors();
    sendState(res);
  });

  app.post("/faults/leak", (req, res) => {
    faults.setLeak(leakParams(req.query));
    sendState(res);
  });
  app.delete("/faults/leak", (_req, res) => {
    faults.clearLeak();
    sendState(res);
  });

  // 막힘과 크래시는 일으키면 답할 수 없으므로, 202로 답을 다 보낸 뒤에 일으킵니다.
  app.post("/faults/block", (req, res) => {
    const params = blockParams(req.query);
    res.once("close", () => setImmediate(() => faults.block(params)));
    res.status(202).json({ accepted: "block", ...params });
  });
  app.post("/faults/crash", (req, res) => {
    const params = crashParams(req.query);
    res.once("close", () => faults.crash(params));
    res.status(202).json({ accepted: "crash", ...params });
  });

  app.use(invalidValueHandler);
  return app;
}

// 잘못된 쿼리 값은 400으로 답합니다. 그 밖의 오류는 Express 기본 처리기로 넘깁니다.
function invalidValueHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof InvalidValueError && !res.headersSent) {
    res.status(400).json({ error: "invalid-parameter", detail: error.message });
    return;
  }
  next(error);
}
