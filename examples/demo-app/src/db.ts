// 가짜 DB입니다(docs/guides/T10.md 결정 8, 14).
// 호출마다 10~30ms 기다리고, 느려짐 스위치가 켜지면 그만큼 더 기다립니다.
// 시간 제한(1000ms)을 넘으면 시간 제한만큼 기다린 뒤 TimeoutError를 던집니다.
import { setTimeout as sleep } from "node:timers/promises";

export const DB_TIMEOUT_MS = 1000;
const BASE_MS = 10;
const JITTER_MS = 20;

// name을 따로 정하지 않아 SDK가 생성자 이름(TimeoutError)을 errorType으로 씁니다.
export class TimeoutError extends Error {}

export class FakeDb {
  // extraDelayMs는 느려짐 스위치가 더하는 지연(ms)을 돌려줍니다.
  constructor(private readonly extraDelayMs: () => number) {}

  async query(): Promise<void> {
    const latency = BASE_MS + Math.random() * JITTER_MS + this.extraDelayMs();
    if (latency > DB_TIMEOUT_MS) {
      await sleep(DB_TIMEOUT_MS);
      throw new TimeoutError(`DB timeout after ${DB_TIMEOUT_MS}ms`);
    }
    await sleep(latency);
  }
}
