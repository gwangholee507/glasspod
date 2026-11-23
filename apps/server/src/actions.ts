// 조치의 공통 길입니다(docs/guides/T21.md). 요청 검사 → namespace 제한 → 대상 확인 → 쿠버네티스 호출 → 기록.
// 형식이 맞는 요청은 결과와 상관없이 저장소에 남기고, 다음 판단 주기의 SSE로 화면에 알립니다(결정 6, 12).
// 조치를 더할 때(T24)는 ACTION_KINDS와 execute의 분기, kube-actions.ts의 호출을 더합니다.
// 트래픽에서 빼기(isolate-pod)와 격리된 Pod 삭제(delete-pod)는 docs/guides/T23.md입니다.
import { randomUUID } from "node:crypto";
import { ApiException } from "@kubernetes/client-node";
import type {
  ActionActor,
  ActionErrorCode,
  ActionItem,
  ActionKind,
  ActionRequest,
  IsolationPlan,
  PodRef,
  PodStatus,
} from "@glasspod/protocol";
import type { ClusterState, PodSummary } from "./cluster.js";
import { isNamespaceName } from "./config.js";
import { isolationPatch, planIsolation } from "./isolation.js";
import { describeError } from "./kube.js";
import type { KubeActions, KubeReplicaSetObject } from "./kube-actions.js";
import { KUBE_ACTION_TIMEOUT_MS } from "./kube-actions.js";
import { log } from "./log.js";
import { podKey, podLabel } from "./pod-key.js";
import type { Store } from "./store/store.js";

export const ACTION_KINDS = [
  "restart-pod",
  "isolate-pod",
  "delete-pod",
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

export interface Failure {
  status: number;
  error: ActionErrorCode;
  detail: string;
  kubeStatus?: number;
}

// 쿠버네티스 호출 사이에 서버가 정한 실패입니다(새로 읽은 Pod가 바뀜, 뗄 라벨을 정하지 못함 등).
class ActionFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.detail);
  }
}

function failureOf(error: unknown): Failure {
  return error instanceof ActionFailure ? error.failure : kubeFailure(error);
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

// 트래픽에서 빼기 미리 보기의 결과입니다(T23 결정 10).
export type PlanOutcome =
  | { ok: true; uid: string; plan: IsolationPlan }
  | { ok: false; failure: Failure };

// 새로 읽은 Pod로 세운 계획입니다. 실행은 이 resourceVersion으로 patch합니다.
interface FreshPlan {
  uid: string;
  resourceVersion: string;
  plan: IsolationPlan;
}

// execute가 기록에 더하는 것입니다.
type ExecuteResult = Pick<ActionItem, "isolation">;

export interface ActionServiceOptions {
  // GLASSPOD_ACTION_NAMESPACES입니다(결정 2).
  actionNamespaces: readonly string[];
  cluster: ClusterState;
  // 쿠버네티스 연결 설정이 없으면(watch 꺼짐) undefined입니다.
  kube: KubeActions | undefined;
  store: Store;
  // 기록을 남긴 뒤 부릅니다. 다음 SSE changes에 넣습니다(결정 12).
  onRecorded?: (item: ActionItem) => void;
  // 지금 판단입니다. 트래픽에서 뺄 때 '격리할 때 판단'으로 주석에 남깁니다(T23 결정 5).
  statusOf?: (pod: PodRef) => PodStatus | undefined;
  now?: () => number;
  newId?: () => string;
}

function isolatedFailure(pod: PodRef): Failure {
  return {
    status: 409,
    error: "target-isolated",
    detail: `pod ${podLabel(pod)} is already isolated (label glasspod/isolated=true)`,
  };
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
    let result: ExecuteResult = {};
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
          result = await this.execute(request, actor);
        } catch (error) {
          failure = failureOf(error);
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
      ...(failure === undefined ? result : {}),
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
    // 격리 검사입니다(T23 결정 9). 삭제는 격리된 Pod만, 재시작·트래픽에서 빼기는 격리되지 않은 Pod만 받습니다.
    const isolated = summary.isolation !== undefined;
    if (request.action === "delete-pod" && !isolated) {
      return {
        status: 409,
        error: "target-not-isolated",
        detail: `pod ${namespace}/${name} is not isolated; only isolated pods can be deleted`,
      };
    }
    if (request.action !== "delete-pod" && isolated) {
      return isolatedFailure(request.target);
    }
    return undefined;
  }

  private async execute(
    request: ActionRequest,
    actor: ActionActor,
  ): Promise<ExecuteResult> {
    const kube = this.options.kube;
    if (kube === undefined) {
      throw new Error("kubernetes is not connected");
    }
    switch (request.action) {
      case "restart-pod":
      case "delete-pod":
        await kube.deletePod(request.target, request.expectedUid);
        return {};
      case "isolate-pod": {
        const fresh = await this.freshPlan(
          kube,
          request.target,
          request.expectedUid,
        );
        await kube.patchPod(
          request.target,
          isolationPatch({
            resourceVersion: fresh.resourceVersion,
            plan: fresh.plan,
            at: this.now(),
            status: this.options.statusOf?.(request.target),
            actor,
          }),
        );
        return {
          isolation: {
            labels: fresh.plan.labels,
            services: fresh.plan.services,
          },
        };
      }
    }
  }

  // 트래픽에서 빼기 미리 보기입니다(T23 결정 10). 실행처럼 검사하되 기록하지 않습니다.
  async previewIsolation(pod: PodRef): Promise<PlanOutcome> {
    const summary = this.options.cluster.pods.get(pod.namespace, pod.name);
    const failure = this.check(
      { action: "isolate-pod", target: pod, expectedUid: summary?.uid ?? "" },
      summary,
    );
    if (failure !== undefined) {
      return { ok: false, failure };
    }
    const kube = this.options.kube;
    if (kube === undefined) {
      return {
        ok: false,
        failure: {
          status: 503,
          error: "kube-unavailable",
          detail: "the server is not connected to kubernetes",
        },
      };
    }
    try {
      const fresh = await this.freshPlan(kube, pod, undefined);
      return { ok: true, uid: fresh.uid, plan: fresh.plan };
    } catch (error) {
      return { ok: false, failure: failureOf(error) };
    }
  }

  // Pod를 새로 읽고 ReplicaSet selector와 Service를 읽어 뗄 라벨을 정합니다(T23 결정 6~8).
  // expectedUid를 주면 지금 uid와 견줍니다. 실패는 ActionFailure나 쿠버네티스 오류로 던집니다.
  private async freshPlan(
    kube: KubeActions,
    pod: PodRef,
    expectedUid: string | undefined,
  ): Promise<FreshPlan> {
    const object = await kube.readPod(pod);
    if (expectedUid !== undefined && object.uid !== expectedUid) {
      throw new ActionFailure({
        status: 409,
        error: "target-changed",
        detail: `pod uid is ${object.uid}, not ${expectedUid}`,
      });
    }
    if (object.terminating) {
      throw new ActionFailure({
        status: 409,
        error: "target-terminating",
        detail: `pod ${podLabel(pod)} is already terminating`,
      });
    }
    if (object.isolated) {
      throw new ActionFailure(isolatedFailure(pod));
    }
    let replicaSet: KubeReplicaSetObject | undefined;
    if (object.replicaSet !== undefined) {
      try {
        replicaSet = await kube.readReplicaSet(
          pod.namespace,
          object.replicaSet,
        );
      } catch (error) {
        // ReplicaSet이 막 지워졌으면 컨트롤러가 없는 Pod로 봅니다. 그 밖의 오류는 그대로 던집니다.
        if (!(error instanceof ApiException && error.code === 404)) {
          throw error;
        }
      }
    }
    const services = await kube.listServices(pod.namespace);
    const planned = planIsolation({
      podLabels: object.labels,
      replicaSet:
        replicaSet === undefined
          ? undefined
          : {
              name: replicaSet.name,
              ...(replicaSet.deployment === undefined
                ? {}
                : { deployment: replicaSet.deployment }),
              ...(replicaSet.matchLabels === undefined
                ? {}
                : { matchLabels: replicaSet.matchLabels }),
            },
      services: services.map((service) => ({
        name: service.name,
        ...(service.selector === undefined
          ? {}
          : { selector: service.selector }),
      })),
    });
    if (!planned.ok) {
      throw new ActionFailure({
        status: 409,
        error: "cannot-isolate",
        detail: planned.detail,
      });
    }
    return {
      uid: object.uid,
      resourceVersion: object.resourceVersion,
      plan: planned.plan,
    };
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
      removedLabels:
        item.isolation === undefined
          ? undefined
          : Object.entries(item.isolation.labels)
              .map(([key, value]) => `${key}=${value}`)
              .join(","),
      detail: item.detail,
    };
    if (item.result === "succeeded") {
      log.info("action", fields);
    } else {
      log.warn("action", fields);
    }
  }
}
