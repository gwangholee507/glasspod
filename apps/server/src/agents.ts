// hello를 받아들인 SDK 연결 목록입니다(docs/guides/T09.md).
// Pod(namespace + 이름)로 연결을 찾아 request를 보내고 답을 기다립니다. 같은 Pod의 연결이 둘이면 나중 것을 씁니다.
import type {
  HelloMessage,
  PodRef,
  RequestMessage,
  ResponseMessage,
} from "@glasspod/protocol";
import { log } from "./log.js";
import type { LogFields } from "./log.js";
import { PendingRequests } from "./requests.js";
import type { RequestOutcome } from "./requests.js";

// 요청 id는 서버 프로세스에서 1부터 셉니다(r-1, r-2, ...). 로그에서 요청과 답을 짝짓기 쉽게 합니다.
let lastRequestId = 0;
function nextRequestId(): string {
  lastRequestId += 1;
  return `r-${lastRequestId}`;
}

export interface AgentSessionOptions {
  hello: HelloMessage;
  // 텍스트 프레임 하나를 보냅니다. 연결이 열려 있지 않아 보내지 못했으면 false입니다.
  send: (text: string) => boolean;
  // 로그에 붙이는 연결 정보입니다(remote, pod, instance).
  fields: LogFields;
}

// hello를 받아들인 연결 하나입니다. 연결이 끝나면 close()를 부릅니다.
export class AgentSession {
  readonly hello: HelloMessage;
  readonly fields: LogFields;
  private readonly sendText: (text: string) => boolean;
  private readonly pending = new PendingRequests();

  constructor(options: AgentSessionOptions) {
    this.hello = options.hello;
    this.fields = options.fields;
    this.sendText = options.send;
  }

  // SDK가 hello의 capabilities로 이 action에 답할 수 있다고 알렸는지입니다.
  supports(action: string): boolean {
    return this.hello.capabilities?.includes(action) ?? false;
  }

  // request를 보내고 답을 기다립니다. 기다리는 요청이 상한이면 보내지 않고 busy입니다.
  async request(action: string): Promise<RequestOutcome> {
    if (this.pending.full) {
      log.warn("request failed", { ...this.fields, action, reason: "busy" });
      return { status: "busy" };
    }
    const id = nextRequestId();
    const message: RequestMessage = { type: "request", id, action };
    if (!this.sendText(JSON.stringify(message))) {
      log.warn("request failed", {
        ...this.fields,
        id,
        action,
        reason: "disconnected",
      });
      return { status: "disconnected" };
    }
    log.info("request sent", { ...this.fields, id, action });
    const outcome = await this.pending.add(id);
    if (outcome.status === "answered") {
      log.info("response received", {
        ...this.fields,
        id,
        ok: outcome.response.ok,
        elapsedMs: outcome.elapsedMs,
      });
    } else {
      log.warn("request failed", {
        ...this.fields,
        id,
        action,
        reason: outcome.status,
      });
    }
    return outcome;
  }

  // 받은 response를 기다리던 요청과 짝짓습니다. 늦었거나 모르는 replyTo면 경고만 남기고 false입니다.
  receive(response: ResponseMessage): boolean {
    if (this.pending.settle(response)) {
      return true;
    }
    log.warn("response ignored", {
      ...this.fields,
      replyTo: response.replyTo,
      detail: "no pending request (late or unknown id)",
    });
    return false;
  }

  // 연결이 끝나면 부릅니다. 기다리던 요청은 disconnected로 끝납니다.
  close(): void {
    this.pending.close();
  }
}

export class AgentRegistry {
  private readonly sessions = new Map<string, AgentSession>();

  // 연결을 넣습니다. 같은 Pod의 예전 연결이 있었으면 그것을 돌려줍니다(목록에서는 빠짐).
  add(session: AgentSession): AgentSession | undefined {
    const key = podKey(session.hello.pod);
    const previous = this.sessions.get(key);
    this.sessions.set(key, session);
    return previous === session ? undefined : previous;
  }

  // 그 Pod의 지금 연결이 이 연결일 때만 뺍니다. 새 연결로 바뀐 뒤 예전 연결이 닫혀도 새 연결은 남습니다.
  remove(session: AgentSession): void {
    const key = podKey(session.hello.pod);
    if (this.sessions.get(key) === session) {
      this.sessions.delete(key);
    }
  }

  get(pod: PodRef): AgentSession | undefined {
    return this.sessions.get(podKey(pod));
  }
}

// namespace와 이름을 이어 붙이면 '/'가 든 값끼리 겹칠 수 있으므로 JSON 배열로 만듭니다.
function podKey(pod: PodRef): string {
  return JSON.stringify([pod.namespace, pod.name]);
}
