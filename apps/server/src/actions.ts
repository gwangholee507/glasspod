// 조치의 공통 길입니다(docs/guides/T21.md). 요청 검사 → namespace 제한 → 대상 확인 → 쿠버네티스 호출 → 기록.
// 형식이 맞는 요청은 결과와 상관없이 저장소에 남기고, 다음 판단 주기의 SSE로 화면에 알립니다(결정 6, 12).
// 조치를 더할 때(T23·T24)는 ACTION_KINDS와 execute의 분기, kube-actions.ts의 호출을 더합니다.
import { randomUUID } from "node:crypto";
import { ApiException } from "@kubernetes/client-node";
import type {
  ActionActor,
  ActionErrorCode,
  ActionItem,
  ActionKind,
  ActionRequest,
  PodRef,
} from "@glasspod/protocol";
import type { ClusterState, PodSummary } from "./cluster.js";
import { isNamespaceName } from "./config.js";
import { describeError } from "./kube.js";
import type { KubeActions } from "./kube-actions.js";
import { KUBE_ACTION_TIMEOUT_MS } from "./kube-actions.js";
import { log } from "./log.js";
import { podKey, podLabel } from "./pod-key.js";
import type { Store } from "./store/store.js";

export const ACTION_KINDS = [
  "restart-pod",
] as const satisfies readonly ActionKind[];

// 쿠버네티스 객체 이름 규칙(DNS-1123 subdomain)입니다. Pod 이름은 이것을 따릅니다.
const OBJECT_NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const MAX_OBJECT_NAME_LENGTH = 253;
// 쿠버네티스 uid는 UUID(36자)입니다. 넉넉히 받습니다.
const MAX_UID_LENGTH = 128;
// 기록과 로그에 남기는 설명의 길이입니다(결정 10).
const MAX_DETAIL_LENGTH = 200;

export type ActionRequestParse =
  { ok: true; request: ActionRequest } | { ok: false; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionKind(value: unknown): value is ActionKind {
  return ACTION_KINDS.some((kind) => kind === value);
}

function isObjectName(value: string): boolean {
  return (
    value.length <= MAX_OBJECT_NAME_LENGTH && OBJECT_NAME_PATTERN.test(value)
  );
}

// POST /api/actions 본문을 검사합니다(결정 5). 모르는 필드는 무시합니다.
export function parseActionRequest(body: unknown): ActionRequestParse {
  if (!isRecord(body)) {
    return { ok: false, detail: "body must be a JSON object" };
  }
  const { action, target, expectedUid } = body;
  if (!isActionKind(action)) {
    return {
      ok: false,
      detail: `action must be one of: ${ACTION_KINDS.join(", ")}`,
    };
  }
  if (!isRecord(target)) {
    return { ok: false, detail: "target must be { namespace, name }" };
  }
  const { namespace, name } = target;
  if (typeof namespace !== "string" || !isNamespaceName(namespace)) {
    return { ok: false, detail: "target.namespace must be a namespace name" };
  }
  if (typeof name !== "string" || !isObjectName(name)) {
    return { ok: false, detail: "target.name must be a pod name" };
  }
  if (
    typeof expectedUid !== "string" ||
    expectedUid === "" ||
    expectedUid.length > MAX_UID_LENGTH
  ) {
    return { ok: false, detail: "expectedUid must be the pod uid" };
  }
  return {
    ok: true,
    request: { action, target: { namespace, name }, expectedUid },
  };
}

interface Failure {
  status: number;
  error: ActionErrorCode;
  detail: string;
  kubeStatus?: number;
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_LENGTH
    ? `${text.slice(0, MAX_DETAIL_LENGTH)}…`
    : text;
}

// 쿠버네티스가 돌려준 Status 본문의 message입니다. 없으면 undefined입니다.
function statusMessage(body: unknown): string | undefined {
  let value: unknown = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body);
    } catch {
      return body === "" ? undefined : body;
    }
  }
  if (isRecord(value) && typeof value["message"] === "string") {
    return value["message"];
  }
  return undefined;
}

// 쿠버네티스 호출 실패를 오류 코드로 바꿉니다(결정 6 ⑦).
export function kubeFailure(
  error: unknown,
  timeoutMs = KUBE_ACTION_TIMEOUT_MS,
): Failure {
  if (error instanceof ApiException) {
    const code = error.code;
    const detail = truncate(statusMessage(error.body) ?? `http ${code}`);
    if (code === 404) {
      return {
        status: 404,
        error: "target-not-found",
        detail,
        kubeStatus: code,
      };
    }
    if (code === 409) {
      return { status: 409, error: "target-changed", detail, kubeStatus: code };
    }
    if (code === 403) {
      return { status: 502, error: "kube-forbidden", detail, kubeStatus: code };
    }
    return { status: 502, error: "kube-error", detail, kubeStatus: code };
  }
  // AbortSignal.timeout은 TimeoutError, 그 밖의 중단은 AbortError로 옵니다.
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return {
      status: 504,
      error: "kube-timeout",
      detail: `kubernetes did not answer in ${timeoutMs}ms`,
    };
  }
  return { status: 502, error: "kube-error", detail: describeError(error) };
}

export interface ActionOutcome {
  // HTTP 상태 코드입니다. 성공이면 200입니다.
  status: number;
  item: ActionItem;
}

export interface ActionServiceOptions {
  // GLASSPOD_ACTION_NAMESPACES입니다(결정 2).
  actionNamespaces: readonly string[];
  cluster: ClusterState;
  // 쿠버네티스 연결 설정이 없으면(watch 꺼짐) undefined입니다.
  kube: KubeActions | undefined;
  store: Store;
  // 기록을 남긴 뒤 부릅니다. 다음 SSE changes에 넣습니다(결정 12).
  onRecorded?: (item: ActionItem) => void;
  now?: () => number;
  newId?: () => string;
}

export class ActionService {
  private readonly options: ActionServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  // 쿠버네티스를 부르는 중인 대상입니다(결정 6 ⑥).
  private readonly running = new Set<string>();

  constructor(options: ActionServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  get actionNamespaces(): readonly string[] {
    return this.options.actionNamespaces;
  }

  async run(
    request: ActionRequest,
    actor: ActionActor,
  ): Promise<ActionOutcome> {
    const requestedAt = this.now();
    const pod: PodRef = request.target;
    const summary = this.options.cluster.pods.get(pod.namespace, pod.name);
    let failure = this.check(request, summary);
    if (failure === undefined) {
      const key = podKey(pod);
      if (this.running.has(key)) {
        failure = {
          status: 409,
          error: "action-in-progress",
          detail: `another action is running on pod ${podLabel(pod)}`,
        };
      } else {
        this.running.add(key);
        try {
          await this.execute(request);
        } catch (error) {
          failure = kubeFailure(error);
        } finally {
          this.running.delete(key);
        }
      }
    }

    const deployment =
      summary === undefined
        ? undefined
        : this.options.cluster.deploymentOf(summary);
    const item: ActionItem = {
      id: this.newId(),
      action: request.action,
      target: {
        kind: "pod",
        namespace: pod.namespace,
        name: pod.name,
        uid: request.expectedUid,
      },
      actor,
      requestedAt,
      finishedAt: this.now(),
      result: failure === undefined ? "succeeded" : "failed",
      ...(failure === undefined
        ? {}
        : {
            error: failure.error,
            detail: failure.detail,
            ...(failure.kubeStatus === undefined
              ? {}
              : { kubeStatus: failure.kubeStatus }),
          }),
      ...(summary?.replicaSet === undefined
        ? {}
        : { replicaSet: summary.replicaSet }),
      ...(deployment === undefined ? {} : { deployment }),
    };

    await this.record(item);
    return { status: failure?.status ?? 200, item };
  }

  // 쿠버네티스를 부르기 전의 검사입니다(결정 6 ①~⑤). 통과하면 undefined입니다.
  private check(
    request: ActionRequest,
    summary: PodSummary | undefined,
  ): Failure | undefined {
    const { namespace, name } = request.target;
    const allowed = this.options.actionNamespaces;
    if (!allowed.includes(namespace)) {
      return {
        status: 403,
        error: "action-not-allowed",
        detail:
          allowed.length === 0
            ? "actions are disabled (GLASSPOD_ACTION_NAMESPACES is empty)"
            : `namespace ${namespace} is not in GLASSPOD_ACTION_NAMESPACES (${allowed.join(",")})`,
      };
    }
    if (this.options.kube === undefined) {
      return {
        status: 503,
        error: "kube-unavailable",
        detail: "the server is not connected to kubernetes",
      };
    }
    if (summary === undefined) {
      return {
        status: 404,
        error: "target-not-found",
        detail: `no pod ${namespace}/${name} in the cluster`,
      };
    }
    if (summary.uid !== request.expectedUid) {
      return {
        status: 409,
        error: "target-changed",
        detail: `pod uid is ${summary.uid}, not ${request.expectedUid}`,
      };
    }
    if (summary.terminating) {
      return {
        status: 409,
        error: "target-terminating",
        detail: `pod ${namespace}/${name} is already terminating`,
      };
    }
    return undefined;
  }

  private async execute(request: ActionRequest): Promise<void> {
    const kube = this.options.kube;
    if (kube === undefined) {
      throw new Error("kubernetes is not connected");
    }
    switch (request.action) {
      case "restart-pod":
        await kube.deletePod(request.target, request.expectedUid);
        return;
    }
  }

  // 저장소에 남기고 화면에 알린 뒤 로그 한 줄을 씁니다. 저장에 실패해도 조치 결과는 그대로 돌려줍니다.
  private async record(item: ActionItem): Promise<void> {
    try {
      await this.options.store.addAction(item);
    } catch (error) {
      log.warn("action not stored", { detail: describeError(error) });
    }
    try {
      this.options.onRecorded?.(item);
    } catch (error) {
      log.warn("action not streamed", { detail: describeError(error) });
    }
    const fields = {
      action: item.action,
      target: `${item.target.namespace}/${item.target.name}`,
      actor: item.actor.kind === "user" ? "user" : `rule:${item.actor.name}`,
      result: item.result,
      error: item.error,
      kubeStatus: item.kubeStatus,
      durationMs: item.finishedAt - item.requestedAt,
      detail: item.detail,
    };
    if (item.result === "succeeded") {
      log.info("action", fields);
    } else {
      log.warn("action", fields);
    }
  }
}
