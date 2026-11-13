// 주문 API와 큐, 작업자입니다(docs/guides/T10.md 결정 2, 7, 9, 11).
// 접수한 주문은 큐에 넣고, 작업자가 동시에 2건까지 꺼내 가짜 DB에 씁니다.
// 가짜 DB가 느려지면 처리량이 줄어 큐가 쌓이고, 시간 제한을 넘으면 DB timeout 예외가 납니다(design.md 6장).
import { glasspod } from "@glasspod/sdk";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { FakeDb } from "./db.js";

// 큐 상한입니다. 느려짐이 길어져도 메모리가 계속 늘지 않게 합니다.
export const QUEUE_LIMIT = 10_000;
export const WORKER_CONCURRENCY = 2;

export class OrderQueue {
  // 기다리는 주문 id입니다. 처리 중인 것은 들어 있지 않습니다.
  private readonly pending: number[] = [];
  private active = 0;
  private running = true;
  private nextId = 1;
  private readonly created = glasspod.counter("app.orders.created");
  private readonly processed = glasspod.counter("app.orders.processed");
  private readonly failed = glasspod.counter("app.orders.failed");

  constructor(private readonly db: FakeDb) {
    glasspod.gauge("app.queue.length", () => this.pending.length);
  }

  get length(): number {
    return this.pending.length;
  }

  // 주문을 큐에 넣고 id를 돌려줍니다. 큐가 가득 찼거나 멈췄으면 undefined입니다.
  enqueue(): number | undefined {
    if (!this.running || this.pending.length >= QUEUE_LIMIT) {
      return undefined;
    }
    const id = this.nextId++;
    this.pending.push(id);
    this.created.inc();
    this.pump();
    return id;
  }

  // 새 주문을 받지 않고 기다리는 주문은 버립니다. 처리 중인 것은 마칩니다(가짜 DB라 1초 안).
  stop(): void {
    this.running = false;
    this.pending.length = 0;
  }

  private pump(): void {
    while (this.running && this.active < WORKER_CONCURRENCY) {
      const id = this.pending.shift();
      if (id === undefined) {
        return;
      }
      this.active++;
      void this.process().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  // 실패한 주문은 다시 넣지 않고 세기만 합니다. 예외는 앱이 잡아 SDK로 보고합니다.
  private async process(): Promise<void> {
    try {
      await this.db.query();
      this.processed.inc();
    } catch (error) {
      this.failed.inc();
      glasspod.exception(error, { job: "process-order" });
    }
  }
}

export function createOrdersApp(queue: OrderQueue, db: FakeDb): Express {
  const app = express();
  // probe용입니다. glasspod.express()보다 앞에 두어 세지 않습니다.
  app.get("/healthz", (_req, res) => {
    res.type("text").send("ok");
  });
  app.use(glasspod.express());

  app.get("/orders/:id", async (req, res) => {
    await db.query();
    res.json({ id: req.params.id, status: "shipped" });
  });

  app.post("/orders", (_req, res) => {
    const id = queue.enqueue();
    if (id === undefined) {
      res.status(503).json({ error: "queue-full" });
      return;
    }
    res.status(202).json({ id, queued: queue.length });
  });

  // 라우트에서 난 예외를 route와 함께 SDK로 보냅니다.
  app.use(glasspod.expressErrors());
  app.use(errorHandler);
  return app;
}

// 앱의 오류 처리기입니다. Express 기본 처리기와 달리 예외마다 stack을 출력하지 않습니다.
function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  res
    .status(errorStatus(error))
    .json({ error: error instanceof Error ? error.message : String(error) });
}

// Express가 붙인 status(예: 잘못된 URL 인코딩은 400)가 있으면 쓰고, 없으면 500입니다.
function errorStatus(error: unknown): number {
  if (typeof error === "object" && error !== null) {
    const { status, statusCode } = error as {
      status?: unknown;
      statusCode?: unknown;
    };
    const value = status ?? statusCode;
    if (typeof value === "number" && value >= 400 && value <= 599) {
      return value;
    }
  }
  return 500;
}
