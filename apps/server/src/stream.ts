// 웹 화면에 SSE(D2)로 목록 변화를 보냅니다(docs/guides/T14.md 결정 2, 15, 17).
// 연결 직후 pods(목록 전체) 한 번, 그 뒤 판단 주기마다 바뀐 것이 있으면 changes 한 건을 보냅니다.
// 이어받기는 없습니다. 브라우저가 다시 붙으면 pods부터 다시 받습니다.
import type {
  PodListBody,
  PodListChanges,
  PodStreamEvent,
} from "@glasspod/protocol";
import { filterChanges } from "./feed.js";
import { log } from "./log.js";
import type { LogFields } from "./log.js";

// 동시에 여는 SSE 연결의 상한입니다. 로그인이 없는 1차 범위(D4)에서 메모리를 묶어 둡니다.
export const MAX_STREAMS = 20;
// 소켓에 쌓인 데이터가 이보다 많으면 느린 연결로 보고 끊습니다.
export const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
// 조용할 때도 이 주기로 주석 줄을 보내 중간의 프록시가 연결을 끊지 않게 합니다.
export const KEEPALIVE_INTERVAL_MS = 15_000;
// 브라우저(EventSource)가 끊긴 뒤 다시 붙기까지 기다리는 시간입니다.
export const RETRY_MS = 3_000;

// SSE 응답의 헤더입니다. Connection: close는 서버가 내려갈 때 end() 뒤 소켓이 바로 닫히게 합니다.
export const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "close",
  // nginx 같은 프록시가 응답을 모아 두지 않게 합니다.
  "X-Accel-Buffering": "no",
} as const;

// SSE 이벤트 한 건입니다. JSON.stringify는 줄바꿈을 그대로 쓰지 않으므로 data는 한 줄입니다.
export function formatEvent(event: PodStreamEvent, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// 쓰기 대상입니다. Node의 ServerResponse가 이 모양입니다.
export interface StreamTarget {
  write(chunk: string): boolean;
  readonly writableLength: number;
  end(): void;
  destroy(): void;
}

export interface StreamInfo {
  remote: string | undefined;
  namespace: string | undefined;
}

export type StreamCloseReason = "client" | "slow" | "shutdown";

// 열린 SSE 연결 하나입니다. 응답의 close 이벤트에서 release("client")를 부릅니다. 이미 닫혔으면 아무 일도 하지 않습니다.
export interface StreamHandle {
  release(reason: StreamCloseReason): void;
}

interface OpenStream extends StreamInfo {
  target: StreamTarget;
  openedAt: number;
}

export interface StreamHubOptions {
  maxStreams?: number;
  maxBufferBytes?: number;
  keepaliveMs?: number;
  now?: () => number;
}

export class StreamHub {
  private readonly streams = new Set<OpenStream>();
  private readonly maxStreams: number;
  private readonly maxBufferBytes: number;
  private readonly keepaliveMs: number;
  private readonly now: () => number;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: StreamHubOptions = {}) {
    this.maxStreams = options.maxStreams ?? MAX_STREAMS;
    this.maxBufferBytes = options.maxBufferBytes ?? MAX_STREAM_BUFFER_BYTES;
    this.keepaliveMs = options.keepaliveMs ?? KEEPALIVE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.streams.size;
  }

  get full(): boolean {
    return this.streams.size >= this.maxStreams;
  }

  get limit(): number {
    return this.maxStreams;
  }

  // 헤더를 보낸 응답을 받아 retry와 pods를 보내고 목록에 넣습니다. 상한이면 부르기 전에 full로 거릅니다.
  open(
    target: StreamTarget,
    info: StreamInfo,
    initial: PodListBody,
  ): StreamHandle {
    const stream: OpenStream = { ...info, target, openedAt: this.now() };
    this.streams.add(stream);
    log.info("stream opened", { ...fields(stream), streams: this.size });
    this.startKeepalive();
    this.send(stream, `retry: ${RETRY_MS}\n\n${formatEvent("pods", initial)}`);
    return {
      release: (reason) => this.remove(stream, reason),
    };
  }

  // 판단 주기마다 부릅니다. 연결마다 그 namespace로 거른 변화를 보내고, 보낼 것이 없으면 건너뜁니다.
  broadcast(changes: PodListChanges): void {
    // 같은 namespace를 보는 연결끼리는 한 번만 만듭니다.
    const texts = new Map<string | undefined, string | undefined>();
    for (const stream of [...this.streams]) {
      let text = texts.get(stream.namespace);
      if (!texts.has(stream.namespace)) {
        const filtered = filterChanges(changes, stream.namespace);
        text =
          filtered === undefined ? undefined : formatEvent("changes", filtered);
        texts.set(stream.namespace, text);
      }
      if (text !== undefined) {
        this.send(stream, text);
      }
    }
  }

  // 서버가 내려갈 때 모든 연결을 닫습니다.
  closeAll(): void {
    for (const stream of [...this.streams]) {
      this.remove(stream, "shutdown");
      try {
        stream.target.end();
      } catch {
        // 이미 끊긴 소켓이면 할 일이 없습니다.
      }
    }
  }

  private send(stream: OpenStream, text: string): void {
    if (!this.streams.has(stream)) {
      return;
    }
    try {
      stream.target.write(text);
    } catch {
      this.remove(stream, "client");
      return;
    }
    if (stream.target.writableLength > this.maxBufferBytes) {
      const bufferedBytes = stream.target.writableLength;
      this.remove(stream, "slow", bufferedBytes);
      stream.target.destroy();
    }
  }

  private remove(
    stream: OpenStream,
    reason: StreamCloseReason,
    bufferedBytes?: number,
  ): void {
    if (!this.streams.delete(stream)) {
      return;
    }
    const line: LogFields = {
      ...fields(stream),
      streams: this.size,
      reason,
      durationMs: this.now() - stream.openedAt,
      bufferedBytes,
    };
    if (reason === "slow") {
      log.warn("stream closed", line);
    } else {
      log.info("stream closed", line);
    }
    if (this.streams.size === 0) {
      this.stopKeepalive();
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer !== undefined) {
      return;
    }
    this.keepaliveTimer = setInterval(() => {
      for (const stream of [...this.streams]) {
        this.send(stream, ": keepalive\n\n");
      }
    }, this.keepaliveMs);
    this.keepaliveTimer.unref();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }
}

function fields(stream: StreamInfo): LogFields {
  return { remote: stream.remote, namespace: stream.namespace };
}
