// snapshot 조회입니다(design.md 7.3 request / response, docs/guides/T09.md).
// 그 Pod의 SDK에 snapshot request를 보내고, 결과를 HTTP 상태 코드와 JSON으로 바꿉니다. 서버는 결과를 보관하지 않습니다.
import { validateSnapshotData } from "@glasspod/protocol";
import type {
  HelloMessage,
  PodRef,
  SnapshotBody,
  SnapshotErrorBody,
  SnapshotErrorCode,
} from "@glasspod/protocol";
import type { AgentRegistry } from "./agents.js";
import { log } from "./log.js";
import { MAX_PENDING_REQUESTS } from "./requests.js";
import type { RequestOutcome } from "./requests.js";

// 본문 타입(SnapshotBody, SnapshotErrorBody)은 웹 화면과 함께 쓰므로 @glasspod/protocol의 http.ts에 있습니다.
export interface SnapshotReply {
  status: number;
  body: SnapshotBody | SnapshotErrorBody;
}

export async function requestSnapshot(
  agents: AgentRegistry,
  pod: PodRef,
): Promise<SnapshotReply> {
  const session = agents.get(pod);
  if (session === undefined) {
    return failure(
      404,
      "not-connected",
      `no SDK connection for ${pod.namespace}/${pod.name}`,
    );
  }
  // 예전 SDK는 request를 무시하므로, 보내면 5초 뒤 앱 멈춤처럼 보입니다. 알리지 않았으면 보내지 않습니다.
  if (!session.supports("snapshot")) {
    return failure(
      501,
      "not-supported",
      "the SDK does not list snapshot in its capabilities",
    );
  }
  const outcome = await session.request("snapshot");
  const reply = snapshotReply(session.hello, outcome);
  if (
    outcome.status === "answered" &&
    "error" in reply.body &&
    reply.body.error === "invalid-response"
  ) {
    log.warn("invalid snapshot", {
      ...session.fields,
      id: outcome.response.replyTo,
      detail: reply.body.detail,
    });
  }
  return reply;
}

// 요청 결과를 HTTP 응답으로 바꿉니다. SDK가 ok: true로 답해도 data가 스키마와 맞지 않으면 502입니다.
export function snapshotReply(
  hello: HelloMessage,
  outcome: RequestOutcome,
): SnapshotReply {
  switch (outcome.status) {
    case "busy":
      return failure(
        429,
        "busy",
        `${MAX_PENDING_REQUESTS} requests are already waiting for this SDK`,
      );
    case "no-response":
      return failure(
        504,
        "no-response",
        `no response within ${outcome.timeoutMs}ms`,
      );
    case "disconnected":
      return failure(
        502,
        "disconnected",
        "the SDK connection closed before it answered",
      );
    case "answered": {
      const { response } = outcome;
      if (!response.ok) {
        return failure(502, "sdk-error", response.error ?? "(no error)");
      }
      const data = validateSnapshotData(response.data);
      if (!data.ok) {
        return failure(502, "invalid-response", data.error);
      }
      return {
        status: 200,
        body: {
          pod: hello.pod,
          instanceId: hello.instanceId,
          ts: response.ts,
          elapsedMs: outcome.elapsedMs,
          snapshot: data.message,
        },
      };
    }
  }
}

function failure(
  status: number,
  error: SnapshotErrorCode,
  detail: string,
): SnapshotReply {
  return { status, body: { error, detail } };
}
