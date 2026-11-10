// 같은 이벤트 묶기와 1분 한도입니다(design.md 7.3, docs/guides/T06.md '묶는 규칙').
// 첫 건은 바로 보내고, 그 뒤 10초 동안 같은 이벤트는 세기만 했다가 창이 끝날 때 count로 한 건 보냅니다.
// 끊긴 동안의 보관과 재전송은 T08에서 합니다. 지금은 연결이 없으면 버립니다.
import type { EventMessage } from "@glasspod/protocol";
import { guard } from "./guard.js";
import { debug, warn } from "./log.js";

// 같은 이벤트를 세는 창의 길이입니다.
export const GROUP_WINDOW_MS = 10_000;
// 1분 한도(welcome의 maxEventsPerMinute)를 세는 구간입니다.
export const RATE_WINDOW_MS = 60_000;
// 동시에 셀 수 있는 서로 다른 이벤트 수입니다. 메시지마다 다른 이벤트가 쏟아져도 메모리가 늘지 않게 합니다.
export const MAX_GROUPS = 100;
// 창 끝과 한도가 풀렸는지 확인하는 간격입니다. 세는 이벤트가 있을 때만 돕니다.
export const CHECK_INTERVAL_MS = 1000;

// seq, ts, count를 붙이기 전의 이벤트 내용입니다.
export type EventContent = Pick<
  EventMessage,
  "level" | "name" | "message" | "data"
>;

// 이벤트 하나를 보냅니다. ts는 일어난 시각입니다. 보냈으면 seq, 연결이 없어 못 보냈으면 undefined입니다.
export type SendEvent = (
  content: EventContent,
  ts: number,
  count: number,
) => number | undefined;

// 연결된 동안 서버가 정한 1분 한도입니다. 연결이 없으면 undefined입니다.
export type ReadLimit = () => number | undefined;

interface Group {
  // 창이 끝나는 시각(epoch ms)입니다.
  windowEnds: number;
  // 아직 보내지 않은 횟수와, 그 가운데 처음 일어난 것입니다.
  pending: number;
  first: { content: EventContent; ts: number } | undefined;
}

type SendResult = "sent" | "deferred" | "dropped";

export class EventAggregator {
  private readonly send: SendEvent;
  private readonly limit: ReadLimit;
  private readonly now: () => number;
  // 같은 이벤트끼리 묶은 것입니다. Map은 넣은 순서대로 돌므로 오래된 것부터 보냅니다.
  private readonly groups = new Map<string, Group>();
  // 최근 RATE_WINDOW_MS 동안 보낸 시각입니다. 오래된 것이 앞에 있습니다.
  private readonly sentTimes: number[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private limitWarned = false;
  private zeroWarned = false;
  private overflowWarned = false;

  constructor(send: SendEvent, limit: ReadLimit, now: () => number = Date.now) {
    this.send = send;
    this.limit = limit;
    this.now = now;
  }

  // 이벤트가 일어났을 때 부릅니다.
  record(content: EventContent): void {
    const limit = this.limit();
    if (limit === undefined) {
      debug(`event dropped (not connected) name=${content.name}`);
      return;
    }
    // 서버가 한도를 0으로 정했으면 보내지도 세지도 않습니다.
    if (limit <= 0) {
      const message = `event limit is 0 per minute from the server; events are not sent`;
      if (this.zeroWarned) {
        debug(`event dropped (limit 0) name=${content.name}`);
      } else {
        this.zeroWarned = true;
        warn(message);
      }
      return;
    }
    const now = this.now();
    const key = eventKey(content);
    const group = this.groups.get(key);
    if (group !== undefined) {
      group.pending += 1;
      group.first ??= { content, ts: now };
      return;
    }
    if (this.groups.size >= MAX_GROUPS) {
      const message = `event dropped: ${JSON.stringify(content.name)}: more than ${MAX_GROUPS} different events are being grouped`;
      if (this.overflowWarned) {
        debug(message);
      } else {
        this.overflowWarned = true;
        warn(message);
      }
      return;
    }
    const created: Group = {
      windowEnds: now + GROUP_WINDOW_MS,
      pending: 0,
      first: undefined,
    };
    this.groups.set(key, created);
    this.startTimer();
    // 첫 건은 바로 보냅니다. 한도에 걸리면 세어 두었다가 한도가 풀린 뒤 묶어 보냅니다.
    if (this.trySend(content, now, 1, limit) === "deferred") {
      created.pending = 1;
      created.first = { content, ts: now };
    }
  }

  // 처리되지 않은 예외로 프로세스가 끝날 때 부릅니다. 묶기와 1분 한도를 거치지 않고 바로 보내고,
  // 같은 예외를 세고 있었으면 그 횟수를 더합니다. 세고 있던 다른 이벤트도 함께 보냅니다.
  // 보냈으면 그 seq와 함께 보낸 묶음 수, 연결이 없거나 한도가 0이면 undefined입니다.
  flushFatal(
    content: EventContent,
  ): { seq: number; flushed: number } | undefined {
    const limit = this.limit();
    if (limit === undefined || limit <= 0) {
      return undefined;
    }
    const key = eventKey(content);
    const count = 1 + (this.groups.get(key)?.pending ?? 0);
    this.groups.delete(key);
    const seq = this.send(content, this.now(), count);
    if (seq === undefined) {
      return undefined;
    }
    let flushed = 0;
    for (const group of this.groups.values()) {
      if (group.pending > 0 && group.first !== undefined) {
        this.send(group.first.content, group.first.ts, group.pending);
        flushed += 1;
      }
    }
    this.reset();
    return { seq, flushed };
  }

  // 세던 것을 모두 버리고 타이머를 멈춥니다. stop()에서 부릅니다.
  reset(): void {
    this.groups.clear();
    this.stopTimer();
  }

  // 창이 끝난 묶음을 보냅니다. 한도에 걸린 묶음은 남겨 두고 다음 확인 때 다시 시도합니다.
  private check(): void {
    const limit = this.limit();
    const now = this.now();
    for (const [key, group] of this.groups) {
      if (now < group.windowEnds) {
        continue;
      }
      // 창 동안 더 일어나지 않았으면 잊습니다. 다음에 일어나면 다시 첫 건으로 바로 보냅니다.
      if (group.pending === 0 || group.first === undefined) {
        this.groups.delete(key);
        continue;
      }
      // 연결이 끊겼거나 새 연결의 한도가 0이면 센 것을 버립니다.
      if (limit === undefined || limit <= 0) {
        debug(
          `event dropped (${limit === undefined ? "not connected" : "limit 0"}) name=${group.first.content.name} count=${group.pending}`,
        );
        this.groups.delete(key);
        continue;
      }
      const result = this.trySend(
        group.first.content,
        group.first.ts,
        group.pending,
        limit,
      );
      if (result === "deferred") {
        continue;
      }
      // 보냈으면 다시 10초를 셉니다. 계속 쏟아져도 같은 이벤트는 10초에 한 건입니다.
      group.pending = 0;
      group.first = undefined;
      group.windowEnds = now + GROUP_WINDOW_MS;
    }
    if (this.groups.size === 0) {
      this.stopTimer();
    }
  }

  private trySend(
    content: EventContent,
    ts: number,
    count: number,
    limit: number,
  ): SendResult {
    if (!this.hasRoom(limit)) {
      if (!this.limitWarned) {
        this.limitWarned = true;
        warn(
          `event limit reached (${limit} per minute from the server); events are grouped and sent later`,
        );
      }
      return "deferred";
    }
    const seq = this.send(content, ts, count);
    if (seq === undefined) {
      debug(`event dropped (not connected) name=${content.name}`);
      return "dropped";
    }
    this.sentTimes.push(this.now());
    debug(`event sent seq=${seq} name=${content.name} count=${count}`);
    return "sent";
  }

  // 최근 1분 동안 보낸 수가 한도보다 적은지 봅니다.
  private hasRoom(limit: number): boolean {
    const since = this.now() - RATE_WINDOW_MS;
    while (this.sentTimes.length > 0 && (this.sentTimes[0] ?? 0) <= since) {
      this.sentTimes.shift();
    }
    return this.sentTimes.length < limit;
  }

  private startTimer(): void {
    if (this.timer !== undefined) {
      return;
    }
    const timer = setInterval(
      () => guard(() => this.check()),
      CHECK_INTERVAL_MS,
    );
    // SDK 타이머가 앱 종료를 막지 않게 합니다.
    timer.unref();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// 같은 이벤트인지 가르는 값입니다. name, level, message, data.errorType이 모두 같으면 같은 이벤트입니다.
export function eventKey(content: EventContent): string {
  const errorType = content.data?.["errorType"];
  return JSON.stringify([
    content.name,
    content.level,
    content.message ?? "",
    typeof errorType === "string" ? errorType : "",
  ]);
}
