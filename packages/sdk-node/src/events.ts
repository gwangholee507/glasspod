// 같은 이벤트 묶기, 1분 한도, 연결이 없는 동안의 보관입니다(design.md 7.3, 7.4).
// 묶는 규칙은 docs/guides/T06.md '묶는 규칙', 보관 규칙은 docs/guides/T08.md '보관과 보내기'에 있습니다.
// 첫 건은 바로 보내고, 그 뒤 10초 동안 같은 이벤트는 세기만 했다가 창이 끝날 때 count로 한 건 보냅니다.
// 연결이 없으면 보낼 차례가 된 것을 보관함에 넣고, 다시 연결되면 오래된 것부터 한도 안에서 보냅니다.
import type { EventMessage } from "@glasspod/protocol";
import { guard } from "./guard.js";
import { debug, warn } from "./log.js";

// 같은 이벤트를 세는 창의 길이입니다.
export const GROUP_WINDOW_MS = 10_000;
// 1분 한도(welcome의 maxEventsPerMinute)를 세는 구간입니다.
export const RATE_WINDOW_MS = 60_000;
// 동시에 셀 수 있는 서로 다른 이벤트 수입니다. 메시지마다 다른 이벤트가 쏟아져도 메모리가 늘지 않게 합니다.
export const MAX_GROUPS = 100;
// 연결이 없는 동안 보관하는 event 수입니다(design.md 7.4). 넘치면 오래된 것부터 버립니다.
export const MAX_HELD = 500;
// 창 끝, 한도가 풀렸는지, 보관분을 보낼 수 있는지 확인하는 간격입니다. 할 일이 있을 때만 돕니다.
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

// 지금 event를 어떻게 다룰지입니다.
// "off": SDK가 돌지 않음(start() 전, 꺼짐, stop() 뒤). 버립니다.
// "offline": SDK는 돌지만 연결(welcome)이 없음. 보관합니다.
// 수: 연결됨. 서버가 정한 1분 한도(maxEventsPerMinute)입니다.
export type LinkState = "off" | "offline" | number;
export type ReadLink = () => LinkState;

interface Group {
  // 창이 끝나는 시각(epoch ms)입니다.
  windowEnds: number;
  // 아직 보내지 않은 횟수와, 그 가운데 처음 일어난 것입니다.
  pending: number;
  first: { content: EventContent; ts: number } | undefined;
}

// 보낼 차례가 되었지만 연결이 없어 들고 있는 event입니다.
interface Held {
  content: EventContent;
  ts: number;
  count: number;
}

// sent: 보냄, held: 보관함에 넣음, deferred: 한도나 앞선 보관분 때문에 나중에(묶음에 남김), dropped: 버림
type EmitResult = "sent" | "held" | "deferred" | "dropped";

export class EventAggregator {
  private readonly send: SendEvent;
  private readonly link: ReadLink;
  private readonly now: () => number;
  // 같은 이벤트끼리 묶은 것입니다. Map은 넣은 순서대로 돌므로 오래된 것부터 보냅니다.
  private readonly groups = new Map<string, Group>();
  // 연결이 없어 들고 있는 event입니다. 오래된 것이 앞에 있습니다.
  private held: Held[] = [];
  // 최근 RATE_WINDOW_MS 동안 보낸 시각입니다. 오래된 것이 앞에 있습니다.
  private readonly sentTimes: number[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private limitWarned = false;
  private zeroWarned = false;
  private overflowWarned = false;
  // 이번에 끊긴 동안 보관함이 넘쳐 경고했는지입니다. 다시 연결되면 지웁니다.
  private heldOverflowWarned = false;

  constructor(send: SendEvent, link: ReadLink, now: () => number = Date.now) {
    this.send = send;
    this.link = link;
    this.now = now;
  }

  // 보관한 event 수입니다.
  get heldCount(): number {
    return this.held.length;
  }

  // 이벤트가 일어났을 때 부릅니다.
  record(content: EventContent): void {
    const link = this.link();
    if (link === "off") {
      debug(`event dropped (not started) name=${content.name}`);
      return;
    }
    // 서버가 한도를 0으로 정했으면 보내지도 세지도 않습니다.
    if (link !== "offline" && link <= 0) {
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
    // 첫 건은 바로 보냅니다(연결이 없으면 보관). 한도에 걸리면 세어 두었다가 나중에 묶어 보냅니다.
    if (this.emit(content, now, 1) === "deferred") {
      created.pending = 1;
      created.first = { content, ts: now };
    }
  }

  // 연결되면(welcome) 부릅니다. 보관분을 오래된 것부터 한도 안에서 보내고, 남으면 확인 타이머가 이어서 보냅니다.
  connected(): void {
    this.heldOverflowWarned = false;
    if (this.held.length === 0) {
      return;
    }
    debug(`sending held events held=${this.held.length}`);
    this.drain();
    if (this.held.length > 0) {
      this.startTimer();
    }
  }

  // 처리되지 않은 예외로 프로세스가 끝날 때 부릅니다. 묶기와 1분 한도를 거치지 않고 바로 보내고,
  // 같은 예외를 세고 있었으면 그 횟수를 더합니다. 이어서 보관분과 세고 있던 다른 이벤트도 보냅니다.
  // 보냈으면 그 seq와 함께 보낸 event 수, 연결이 없거나 한도가 0이면 undefined입니다.
  flushFatal(
    content: EventContent,
  ): { seq: number; flushed: number } | undefined {
    const link = this.link();
    if (typeof link !== "number" || link <= 0) {
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
    for (const item of this.held) {
      this.send(item.content, item.ts, item.count);
      flushed += 1;
    }
    for (const group of this.groups.values()) {
      if (group.pending > 0 && group.first !== undefined) {
        this.send(group.first.content, group.first.ts, group.pending);
        flushed += 1;
      }
    }
    this.reset();
    return { seq, flushed };
  }

  // 세던 것과 보관분을 모두 버리고 타이머를 멈춥니다. stop()에서 부릅니다.
  reset(): void {
    this.groups.clear();
    this.held = [];
    this.heldOverflowWarned = false;
    this.stopTimer();
  }

  // 보관분을 보내고, 창이 끝난 묶음을 보냅니다. 한도에 걸린 것은 남겨 두고 다음 확인 때 다시 시도합니다.
  private check(): void {
    this.drain();
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
      const result = this.emit(
        group.first.content,
        group.first.ts,
        group.pending,
      );
      if (result === "deferred") {
        continue;
      }
      if (result === "dropped") {
        this.groups.delete(key);
        continue;
      }
      // 보냈거나 보관했으면 다시 10초를 셉니다. 계속 쏟아져도 같은 이벤트는 10초에 한 건입니다.
      group.pending = 0;
      group.first = undefined;
      group.windowEnds = now + GROUP_WINDOW_MS;
    }
    // 연결이 없는 동안 보관분만 남았으면 타이머를 멈춥니다. 다시 연결되면 connected()가 켭니다.
    const draining = this.held.length > 0 && typeof this.link() === "number";
    if (this.groups.size === 0 && !draining) {
      this.stopTimer();
    }
  }

  // 보낼 차례가 된 event 하나를 연결 상태에 따라 보내거나, 보관하거나, 미루거나, 버립니다.
  private emit(content: EventContent, ts: number, count: number): EmitResult {
    const link = this.link();
    if (link === "off") {
      debug(`event dropped (not started) name=${content.name} count=${count}`);
      return "dropped";
    }
    if (link === "offline") {
      this.hold(content, ts, count);
      return "held";
    }
    // 세는 동안 다시 연결한 서버의 한도가 0이면 센 것을 버립니다.
    if (link <= 0) {
      debug(`event dropped (limit 0) name=${content.name} count=${count}`);
      return "dropped";
    }
    // 보관분이 남아 있으면 그것부터 보냅니다. 새 것은 묶음에서 기다립니다.
    if (this.held.length > 0 || !this.hasRoom(link)) {
      return "deferred";
    }
    const seq = this.send(content, ts, count);
    if (seq === undefined) {
      this.hold(content, ts, count);
      return "held";
    }
    this.sentTimes.push(this.now());
    debug(`event sent seq=${seq} name=${content.name} count=${count}`);
    return "sent";
  }

  // 보관함에 넣습니다. 넘치면 가장 오래된 것을 버립니다.
  private hold(content: EventContent, ts: number, count: number): void {
    if (this.held.length >= MAX_HELD) {
      const dropped = this.held.shift();
      if (!this.heldOverflowWarned) {
        this.heldOverflowWarned = true;
        warn(
          `event buffer full (${MAX_HELD} events while disconnected); dropping the oldest`,
        );
      }
      if (dropped !== undefined) {
        debug(
          `event dropped (buffer full) name=${dropped.content.name} count=${dropped.count}`,
        );
      }
    }
    this.held.push({ content, ts, count });
    debug(
      `event held (not connected) name=${content.name} held=${this.held.length}`,
    );
  }

  // 연결돼 있으면 보관분을 오래된 것부터 한도 안에서 보냅니다.
  private drain(): void {
    const link = this.link();
    if (typeof link !== "number" || this.held.length === 0) {
      return;
    }
    if (link <= 0) {
      debug(`held events dropped (limit 0) held=${this.held.length}`);
      this.held = [];
      return;
    }
    while (this.held.length > 0) {
      if (!this.hasRoom(link)) {
        return;
      }
      const item = this.held[0];
      if (item === undefined) {
        return;
      }
      const seq = this.send(item.content, item.ts, item.count);
      if (seq === undefined) {
        return;
      }
      this.held.shift();
      this.sentTimes.push(this.now());
      debug(
        `held event sent seq=${seq} name=${item.content.name} count=${item.count}`,
      );
    }
  }

  // 최근 1분 동안 보낸 수가 한도보다 적은지 봅니다. 처음 한도에 걸릴 때 경고합니다.
  private hasRoom(limit: number): boolean {
    const since = this.now() - RATE_WINDOW_MS;
    while (this.sentTimes.length > 0 && (this.sentTimes[0] ?? 0) <= since) {
      this.sentTimes.shift();
    }
    if (this.sentTimes.length < limit) {
      return true;
    }
    if (!this.limitWarned) {
      this.limitWarned = true;
      warn(
        `event limit reached (${limit} per minute from the server); events are grouped and sent later`,
      );
    }
    return false;
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
