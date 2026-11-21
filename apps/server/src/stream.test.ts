import type { PodListBody, PodListChanges } from "@glasspod/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamHub, formatEvent } from "./stream.js";
import type { StreamTarget } from "./stream.js";

// 쓴 내용을 모으는 가짜 응답입니다. buffered로 소켓에 쌓인 양을 흉내 냅니다.
class FakeTarget implements StreamTarget {
  chunks: string[] = [];
  buffered = 0;
  ended = false;
  destroyed = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get writableLength(): number {
    return this.buffered;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  // 받은 SSE 이벤트 이름과 data입니다.
  events(): [string, unknown][] {
    return this.chunks
      .join("")
      .split("\n\n")
      .flatMap((block) => {
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        return event === undefined || data === undefined
          ? []
          : [[event, JSON.parse(data)] as [string, unknown]];
      });
  }
}

const LIST: PodListBody = {
  serverTime: 1,
  namespaces: ["shop", "pay"],
  actionNamespaces: [],
  deployments: [],
  pods: [],
};

function changes(fields: Partial<PodListChanges>): PodListChanges {
  return {
    serverTime: 2,
    pods: [],
    removedPods: [],
    deployments: [],
    removedDeployments: [],
    statusChanges: [],
    actions: [],
    ...fields,
  };
}

function lines(): string[] {
  return [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
  ].map((call) => String(call[0]));
}

describe("formatEvent", () => {
  it("writes one event with one data line", () => {
    expect(formatEvent("pods", { text: "a\nb" })).toBe(
      'event: pods\ndata: {"text":"a\\nb"}\n\n',
    );
  });
});

describe("StreamHub", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts with retry and the whole list, then sends changes per namespace", () => {
    const hub = new StreamHub();
    const shop = new FakeTarget();
    const all = new FakeTarget();
    hub.open(shop, { remote: "::1", namespace: "shop" }, LIST);
    hub.open(all, { remote: "::1", namespace: undefined }, LIST);
    expect(shop.chunks[0]).toMatch(/^retry: 3000\n\nevent: pods\n/);

    hub.broadcast(
      changes({ removedPods: [{ namespace: "pay", name: "api-1" }] }),
    );
    // shop만 보는 연결에는 보낼 것이 없습니다.
    expect(shop.events().map(([event]) => event)).toEqual(["pods"]);
    expect(all.events().at(-1)).toEqual([
      "changes",
      changes({ removedPods: [{ namespace: "pay", name: "api-1" }] }),
    ]);
    expect(lines()[0]).toMatch(
      /INFO {2}stream opened remote=::1 namespace=shop streams=1$/,
    );
  });

  it("drops a slow stream once and ignores its later close", () => {
    const hub = new StreamHub({ maxBufferBytes: 10 });
    const slow = new FakeTarget();
    const handle = hub.open(
      slow,
      { remote: "::1", namespace: undefined },
      LIST,
    );
    slow.buffered = 11;
    hub.broadcast(changes({ removedPods: [{ namespace: "a", name: "b" }] }));
    expect(slow.destroyed).toBe(true);
    expect(hub.size).toBe(0);

    handle.release("client");
    const closed = lines().filter((line) => line.includes("stream closed"));
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatch(/WARN .*reason=slow .*bufferedBytes=11$/);
  });

  it("refuses more streams than the limit", () => {
    const hub = new StreamHub({ maxStreams: 1 });
    expect(hub.full).toBe(false);
    hub.open(new FakeTarget(), { remote: "::1", namespace: undefined }, LIST);
    expect(hub.full).toBe(true);
  });

  it("sends keepalive while streams are open", () => {
    vi.useFakeTimers();
    const hub = new StreamHub({ keepaliveMs: 1_000 });
    const target = new FakeTarget();
    const handle = hub.open(
      target,
      { remote: "::1", namespace: undefined },
      LIST,
    );
    vi.advanceTimersByTime(2_000);
    expect(
      target.chunks.filter((chunk) => chunk === ": keepalive\n\n"),
    ).toHaveLength(2);

    handle.release("client");
    vi.advanceTimersByTime(2_000);
    expect(
      target.chunks.filter((chunk) => chunk === ": keepalive\n\n"),
    ).toHaveLength(2);
  });

  it("ends every stream on shutdown", () => {
    const hub = new StreamHub();
    const targets = [new FakeTarget(), new FakeTarget()];
    for (const target of targets) {
      hub.open(target, { remote: "::1", namespace: undefined }, LIST);
    }
    hub.closeAll();
    expect(targets.map((target) => target.ended)).toEqual([true, true]);
    expect(hub.size).toBe(0);
    expect(
      lines().filter((line) => line.includes("reason=shutdown")),
    ).toHaveLength(2);
  });
});
