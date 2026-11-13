// 고장 스위치입니다(docs/guides/T10.md 결정 12~18, '고장 스위치').
// 이어지는 고장(느려짐, 예외 폭주, 메모리 증가)은 켜고 끄고, 한 번 일어나는 고장(막힘, 크래시)은 부르면 일으킵니다.
// 고장은 SDK로 알리지 않고 로그에만 남깁니다. Glasspod가 실제 신호로 판단하는지 보려는 것입니다.
import { glasspod } from "@glasspod/sdk";
import { performance } from "node:perf_hooks";
import { InvalidValueError, readInteger } from "./config.js";
import { log } from "./log.js";
import { RateTicker } from "./rate.js";

// Express의 req.query처럼 값이 무엇이든 올 수 있는 쿼리 문자열입니다.
export type Query = Record<string, unknown>;

export interface SlowParams {
  delayMs: number;
}
export interface ErrorsParams {
  perSecond: number;
  distinct: number;
}
export interface LeakParams {
  mbPerSec: number;
}
export interface BlockParams {
  seconds: number;
}
export type CrashKind = "exception" | "rejection";
export interface CrashParams {
  kind: CrashKind;
}

// 지금 켜진 이어지는 고장입니다. 꺼져 있으면 null입니다.
export interface FaultState {
  slow: SlowParams | null;
  errors: ErrorsParams | null;
  leak: (LeakParams & { retainedMb: number }) | null;
}

// 쿼리 값을 읽습니다. 잘못된 값이면 InvalidValueError를 던집니다.
export function slowParams(query: Query): SlowParams {
  return { delayMs: readInteger(query.delayMs, "delayMs", 1500, 1, 60_000) };
}

export function errorsParams(query: Query): ErrorsParams {
  return {
    perSecond: readInteger(query.perSecond, "perSecond", 50, 1, 1000),
    distinct: readInteger(query.distinct, "distinct", 1, 1, 100),
  };
}

export function leakParams(query: Query): LeakParams {
  return { mbPerSec: readInteger(query.mbPerSec, "mbPerSec", 10, 1, 1000) };
}

export function blockParams(query: Query): BlockParams {
  return { seconds: readInteger(query.seconds, "seconds", 20, 1, 300) };
}

export function crashParams(query: Query): CrashParams {
  const raw = query.kind;
  if (raw === undefined || raw === "") {
    return { kind: "exception" };
  }
  if (raw === "exception" || raw === "rejection") {
    return { kind: raw };
  }
  throw new InvalidValueError(
    `kind must be "exception" or "rejection" (got ${JSON.stringify(raw)})`,
  );
}

// 메모리 증가에서 한 번에 붙잡는 배열입니다. double 65,536칸은 힙 0.5MB입니다(T10.md '사전 확인').
// new Array(n)은 n이 크면 느린 사전 모드가 되므로 작은 배열을 여러 개 만듭니다.
const CHUNK_ELEMENTS = 65_536;
const CHUNKS_PER_MB = 2;

// 예외 폭주에서 쓰는 예외입니다. SDK가 생성자 이름(PaymentError)을 errorType으로 씁니다.
class PaymentError extends Error {}

// 처리되지 않은 예외로 끝나는 크래시에서 쓰는 예외입니다.
class DemoCrashError extends Error {}

export class Faults {
  private slow: SlowParams | undefined;
  private errors:
    (ErrorsParams & { ticker: RateTicker; raised: number }) | undefined;
  private leak:
    (LeakParams & { ticker: RateTicker; chunks: number[][] }) | undefined;

  // 가짜 DB가 더 기다릴 시간(ms)입니다.
  slowDelayMs(): number {
    return this.slow?.delayMs ?? 0;
  }

  state(): FaultState {
    const { slow, errors, leak } = this;
    return {
      slow: slow === undefined ? null : { delayMs: slow.delayMs },
      errors:
        errors === undefined
          ? null
          : { perSecond: errors.perSecond, distinct: errors.distinct },
      leak:
        leak === undefined
          ? null
          : {
              mbPerSec: leak.mbPerSec,
              retainedMb: leak.chunks.length / CHUNKS_PER_MB,
            },
    };
  }

  setSlow(params: SlowParams): void {
    this.slow = { ...params };
    log.info("fault on", { name: "slow", ...params });
  }

  clearSlow(): void {
    if (this.slow !== undefined) {
      this.slow = undefined;
      log.info("fault off", { name: "slow" });
    }
  }

  // 다시 켜면 값만 바꿉니다.
  setErrors(params: ErrorsParams): void {
    if (this.errors === undefined) {
      const ticker = new RateTicker(params.perSecond, (count) => {
        for (let i = 0; i < count; i++) {
          this.raiseError();
        }
      });
      this.errors = { ...params, ticker, raised: 0 };
      ticker.start();
    } else {
      Object.assign(this.errors, params);
      this.errors.ticker.setRate(params.perSecond);
    }
    log.info("fault on", { name: "errors", ...params });
  }

  clearErrors(): void {
    if (this.errors !== undefined) {
      this.errors.ticker.stop();
      this.errors = undefined;
      log.info("fault off", { name: "errors" });
    }
  }

  // 앱이 잡은 예외로 보고합니다. distinct가 1이면 메시지가 모두 같아 SDK가 묶습니다(T06).
  private raiseError(): void {
    const errors = this.errors;
    if (errors === undefined) {
      return;
    }
    const code = (errors.raised % errors.distinct) + 1;
    errors.raised++;
    const message =
      errors.distinct === 1
        ? "payment gateway unavailable"
        : `payment gateway unavailable (code ${code})`;
    glasspod.exception(new PaymentError(message), { job: "payment-sync" });
  }

  // 다시 켜면 속도만 바꾸고 붙잡은 메모리는 그대로 둡니다.
  setLeak(params: LeakParams): void {
    const perSecond = params.mbPerSec * CHUNKS_PER_MB;
    if (this.leak === undefined) {
      const chunks: number[][] = [];
      const ticker = new RateTicker(perSecond, (count) => {
        for (let i = 0; i < count; i++) {
          chunks.push(new Array<number>(CHUNK_ELEMENTS).fill(1.5));
        }
      });
      this.leak = { ...params, ticker, chunks };
      ticker.start();
    } else {
      this.leak.mbPerSec = params.mbPerSec;
      this.leak.ticker.setRate(perSecond);
    }
    log.info("fault on", { name: "leak", ...params });
  }

  // 붙잡은 메모리를 놓습니다. GC가 거둘 때 힙이 줄어듭니다.
  clearLeak(): void {
    if (this.leak !== undefined) {
      const retainedMb = this.leak.chunks.length / CHUNKS_PER_MB;
      this.leak.ticker.stop();
      this.leak = undefined;
      log.info("fault off", { name: "leak", retainedMb });
    }
  }

  // 이어지는 고장을 모두 끕니다.
  clearAll(): void {
    this.clearSlow();
    this.clearErrors();
    this.clearLeak();
  }

  // 이벤트 루프를 seconds초 동안 막습니다. 그동안 앱의 모든 일(SDK 포함)이 멈춥니다.
  block(params: BlockParams): void {
    log.info("fault on", { name: "block", ...params });
    const start = performance.now();
    const end = start + params.seconds * 1000;
    while (performance.now() < end) {
      // 일부러 아무 일도 하지 않고 돕니다.
    }
    log.info("fault off", {
      name: "block",
      blockedMs: Math.round(performance.now() - start),
    });
  }

  // 100ms 뒤 처리되지 않은 예외나 Promise 거부를 일으킵니다. Node 기본대로 오류를 출력하고 종료 코드 1로 끝납니다.
  crash(params: CrashParams): void {
    log.info("fault on", { name: "crash", ...params });
    setTimeout(() => {
      if (params.kind === "exception") {
        throw new DemoCrashError("demo crash: uncaught exception");
      }
      void Promise.reject(
        new DemoCrashError("demo crash: unhandled rejection"),
      );
    }, 100);
  }
}
