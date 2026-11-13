// 서버가 SDK에 보낸 request와 그 답(response)을 짝짓습니다(design.md 7.3 request / response).
// 연결마다 하나씩 둡니다. 5초 안에 답이 없으면 응답 없음으로 끝내고, 그 뒤에 온 답은 버립니다.
import type { ResponseMessage } from "@glasspod/protocol";

// request를 보낸 뒤 답을 기다리는 시간입니다. 이 안에 답이 없으면 이벤트 루프가 막혔다는 단서로 봅니다.
export const REQUEST_TIMEOUT_MS = 5000;
// 연결마다 답을 기다릴 수 있는 요청 수입니다. 막힌 앱에 요청이 쌓이지 않게 합니다.
export const MAX_PENDING_REQUESTS = 5;

// 요청 하나의 결과입니다.
// - answered: SDK가 답함(ok가 false인 답도 포함). elapsedMs는 보낸 때부터 받을 때까지입니다.
// - no-response: 시간 안에 답이 없음
// - disconnected: 기다리는 동안 연결이 끝남
// - busy: 답을 기다리는 요청이 이미 상한이라 보내지 않음
export type RequestOutcome =
  | { status: "answered"; response: ResponseMessage; elapsedMs: number }
  | { status: "no-response"; timeoutMs: number }
  | { status: "disconnected" }
  | { status: "busy" };

interface Pending {
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: RequestOutcome) => void;
}

export class PendingRequests {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly max: number;
  private closed = false;

  constructor(timeoutMs = REQUEST_TIMEOUT_MS, max = MAX_PENDING_REQUESTS) {
    this.timeoutMs = timeoutMs;
    this.max = max;
  }

  // 답을 기다리는 요청이 상한에 닿았는지입니다. 닿았으면 보내지 않습니다.
  get full(): boolean {
    return this.pending.size >= this.max;
  }

  // 보낸 요청의 id를 등록하고 결과를 기다립니다. 연결이 이미 끝났으면 바로 disconnected입니다.
  // 답은 이벤트 루프의 다음 차례에 오므로, 보낸 직후에 등록해도 답을 놓치지 않습니다.
  add(id: string): Promise<RequestOutcome> {
    if (this.closed) {
      return Promise.resolve({ status: "disconnected" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: "no-response", timeoutMs: this.timeoutMs });
      }, this.timeoutMs);
      this.pending.set(id, { startedAt: performance.now(), timer, resolve });
    });
  }

  // 받은 답을 기다리던 요청과 짝짓습니다. 기다리던 것이면 true, 늦었거나 모르는 replyTo면 false입니다.
  settle(response: ResponseMessage): boolean {
    const entry = this.pending.get(response.replyTo);
    if (entry === undefined) {
      return false;
    }
    this.pending.delete(response.replyTo);
    clearTimeout(entry.timer);
    entry.resolve({
      status: "answered",
      response,
      elapsedMs: Math.round(performance.now() - entry.startedAt),
    });
    return true;
  }

  // 연결이 끝나면 부릅니다. 기다리던 요청을 모두 disconnected로 끝내고, 그 뒤에는 받지 않습니다.
  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ status: "disconnected" });
    }
    this.pending.clear();
  }
}
