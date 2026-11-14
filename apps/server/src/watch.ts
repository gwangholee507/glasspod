// 쿠버네티스 watch입니다. namespace마다 Deployment·ReplicaSet·Pod·이벤트 informer를 두고 ClusterState를 채웁니다.
// 읽기만 합니다(list와 watch). 결정과 로그 형식은 docs/guides/T12.md에 있습니다.
import { AppsV1Api, CoreV1Api, makeInformer } from "@kubernetes/client-node";
import type {
  CoreV1Event,
  Informer,
  KubernetesListObject,
  KubernetesObject,
  ObjectCache,
  V1Deployment,
  V1Pod,
  V1ReplicaSet,
} from "@kubernetes/client-node";
import {
  summarizeDeployment,
  summarizePod,
  summarizeReplicaSet,
} from "./cluster.js";
import type {
  ClusterState,
  DeploymentSummary,
  PodSummary,
  ReplicaSetSummary,
  SetResult,
} from "./cluster.js";
import { describeError } from "./kube.js";
import type { KubeConnection } from "./kube.js";
import { log } from "./log.js";
import type { LogFields } from "./log.js";

// 실패한 watch를 다시 시작하기까지 기다리는 시간입니다. 1초부터 2배씩, 30초까지.
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
// 클러스터 이벤트의 message는 이 길이까지만 로그에 씁니다.
const MAX_MESSAGE_LENGTH = 200;

type ResourceName = "deployments" | "replicasets" | "pods" | "events";

interface Handlers<T extends KubernetesObject> {
  // 처음 list가 끝나기 전이면 synced가 false입니다.
  upsert(object: T, synced: boolean): void;
  remove(object: T): void;
}

export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_MS);
}

// informer 하나입니다. client-node의 informer는 실패하면 멈추므로 여기서 다시 시작합니다.
class WatchedResource<T extends KubernetesObject> {
  private readonly informer: Informer<T> & ObjectCache<T>;
  private stopped = false;
  private synced = false;
  private failures = 0;
  private lastDetail: string | undefined;
  private failedDuringStart = false;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    connection: KubeConnection,
    private readonly resource: ResourceName,
    private readonly namespace: string,
    path: string,
    list: () => Promise<KubernetesListObject<T>>,
    handlers: Handlers<T>,
  ) {
    this.informer = makeInformer(connection.config, path, list);
    // 콜백에서 예외가 나면 informer 안에서 처리되지 않은 예외가 되므로 모두 잡습니다.
    const guarded = (action: (object: T) => void) => (object: T) => {
      try {
        action(object);
      } catch (error) {
        log.error("kube watch handler failed", {
          resource,
          namespace,
          detail: describeError(error),
        });
      }
    };
    this.informer.on(
      "add",
      guarded((object) => handlers.upsert(object, this.synced)),
    );
    this.informer.on(
      "update",
      guarded((object) => handlers.upsert(object, this.synced)),
    );
    this.informer.on(
      "delete",
      guarded((object) => handlers.remove(object)),
    );
    this.informer.on("error", (error) => this.fail(error));
  }

  private fields(): LogFields {
    return { resource: this.resource, namespace: this.namespace };
  }

  // list를 끝내고 watch를 연 뒤 끝납니다. 실패하면 error 콜백(fail)이 먼저 불리고 예외 없이 끝납니다.
  async start(): Promise<void> {
    this.failedDuringStart = false;
    try {
      await this.informer.start();
    } catch (error) {
      this.fail(error);
    }
    if (this.stopped || this.failedDuringStart) {
      return;
    }
    if (!this.synced) {
      this.synced = true;
      log.info("kube watch synced", {
        ...this.fields(),
        count: this.informer.list(this.namespace).length,
      });
    }
    if (this.failures > 0) {
      log.info("kube watch recovered", {
        ...this.fields(),
        failures: this.failures,
      });
      this.failures = 0;
      this.lastDetail = undefined;
    }
  }

  // 실패가 이어지는 동안 첫 실패와 오류 내용이 바뀐 때만 경고합니다.
  private fail(error: unknown): void {
    // stop()이 요청을 끊으면 informer가 AbortError를 한 번 보냅니다.
    if (this.stopped) {
      return;
    }
    this.failedDuringStart = true;
    if (this.retryTimer !== undefined) {
      return;
    }
    this.failures += 1;
    const detail = describeError(error);
    const delay = retryDelayMs(this.failures);
    if (this.failures === 1 || detail !== this.lastDetail) {
      log.warn("kube watch failed", {
        ...this.fields(),
        detail,
        retryInMs: delay,
      });
    }
    this.lastDetail = detail;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.start();
    }, delay);
    this.retryTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.informer.stop();
  }
}

function podLogFields(
  pod: PodSummary,
  deployment: string | undefined,
): LogFields {
  return {
    phase: pod.phase,
    ready: pod.ready,
    terminating: pod.terminating ? true : undefined,
    restarts: pod.restarts,
    waiting: pod.waiting,
    lastTermination: pod.lastTermination?.reason,
    exitCode: pod.lastTermination?.exitCode,
    ip: pod.ip,
    replicaSet: pod.replicaSet,
    deployment,
  };
}

function deploymentLogFields(deployment: DeploymentSummary): LogFields {
  return {
    desired: deployment.desired,
    ready: deployment.ready,
    available: deployment.available,
  };
}

function replicaSetLogFields(replicaSet: ReplicaSetSummary): LogFields {
  return {
    deployment: replicaSet.deployment,
    revision: replicaSet.revision,
    desired: replicaSet.desired,
  };
}

// 요약이 처음 들어왔거나 바뀐 때만 한 줄 남깁니다. 바뀐 때는 대상 바로 뒤에 changed=를 씁니다.
function logSet<K>(
  kind: "pod" | "deployment" | "replicaset",
  subject: LogFields,
  result: SetResult<K>,
  details: LogFields,
): void {
  if (result.kind === "added") {
    log.info(`${kind} added`, { ...subject, ...details });
  } else if (result.kind === "changed") {
    log.info(`${kind} changed`, {
      ...subject,
      changed: result.fields.join(","),
      ...details,
    });
  }
}

interface Startable {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function eventLogFields(event: CoreV1Event): LogFields {
  const message = (event.message ?? "").replace(/\s+/g, " ").trim();
  return {
    namespace: event.metadata?.namespace,
    object: `${event.involvedObject.kind ?? "?"}/${event.involvedObject.name ?? "?"}`,
    type: event.type,
    reason: event.reason,
    // events.k8s.io/v1로 만든 이벤트는 count 대신 series.count를 씁니다.
    count: event.count ?? event.series?.count ?? 1,
    message:
      message.length > MAX_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…`
        : message,
  };
}

export class ClusterWatcher {
  // namespace마다 시작 순서대로 든 watch입니다.
  private readonly resources: Startable[][] = [];

  constructor(
    private readonly connection: KubeConnection,
    private readonly namespaces: readonly string[],
    private readonly state: ClusterState,
  ) {
    const core = connection.config.makeApiClient(CoreV1Api);
    const apps = connection.config.makeApiClient(AppsV1Api);

    for (const namespace of namespaces) {
      // 이 순서로 시작합니다. ReplicaSet을 먼저 받아야 Pod 로그에 Deployment가 나옵니다.
      const deployments = new WatchedResource<V1Deployment>(
        connection,
        "deployments",
        namespace,
        `/apis/apps/v1/namespaces/${namespace}/deployments`,
        () => apps.listNamespacedDeployment({ namespace }),
        {
          upsert: (object) => {
            const summary = summarizeDeployment(object);
            logSet(
              "deployment",
              { deployment: `${namespace}/${summary.name}` },
              state.deployments.set(summary),
              deploymentLogFields(summary),
            );
          },
          remove: (object) => {
            const removed = state.deployments.delete(
              namespace,
              object.metadata?.name ?? "",
            );
            if (removed !== undefined) {
              log.info("deployment deleted", {
                deployment: `${namespace}/${removed.name}`,
              });
            }
          },
        },
      );
      const replicaSets = new WatchedResource<V1ReplicaSet>(
        connection,
        "replicasets",
        namespace,
        `/apis/apps/v1/namespaces/${namespace}/replicasets`,
        () => apps.listNamespacedReplicaSet({ namespace }),
        {
          upsert: (object) => {
            const summary = summarizeReplicaSet(object);
            logSet(
              "replicaset",
              { replicaSet: `${namespace}/${summary.name}` },
              state.replicaSets.set(summary),
              replicaSetLogFields(summary),
            );
          },
          remove: (object) => {
            const removed = state.replicaSets.delete(
              namespace,
              object.metadata?.name ?? "",
            );
            if (removed !== undefined) {
              log.info("replicaset deleted", {
                replicaSet: `${namespace}/${removed.name}`,
              });
            }
          },
        },
      );
      const pods = new WatchedResource<V1Pod>(
        connection,
        "pods",
        namespace,
        `/api/v1/namespaces/${namespace}/pods`,
        () => core.listNamespacedPod({ namespace }),
        {
          upsert: (object) => {
            const summary = summarizePod(object);
            logSet(
              "pod",
              { pod: `${namespace}/${summary.name}` },
              state.pods.set(summary),
              podLogFields(summary, state.deploymentOf(summary)),
            );
          },
          remove: (object) => {
            const removed = state.pods.delete(
              namespace,
              object.metadata?.name ?? "",
            );
            if (removed !== undefined) {
              log.info("pod deleted", { pod: `${namespace}/${removed.name}` });
            }
          },
        },
      );
      // 이벤트는 들고 있지 않습니다(T11). 처음 list는 synced 로그의 개수로만 남깁니다.
      const events = new WatchedResource<CoreV1Event>(
        connection,
        "events",
        namespace,
        `/api/v1/namespaces/${namespace}/events`,
        () => core.listNamespacedEvent({ namespace }),
        {
          upsert: (object, synced) => {
            if (synced) {
              log.info("kube event", eventLogFields(object));
            }
          },
          // 이벤트는 한 시간쯤 지나면 쿠버네티스가 지웁니다. 남기지 않습니다.
          remove: () => {},
        },
      );
      this.resources.push([deployments, replicaSets, pods, events]);
    }
  }

  // namespace끼리는 함께, namespace 안에서는 정한 순서대로 시작합니다. 실패해도 다음 것을 시작합니다.
  async start(): Promise<void> {
    log.info("kube watch starting", {
      source: this.connection.source,
      context: this.connection.context,
      server: this.connection.server,
      namespaces: this.namespaces.join(","),
    });
    await Promise.all(
      this.resources.map(async (group) => {
        for (const resource of group) {
          await resource.start();
        }
      }),
    );
  }

  async stop(): Promise<void> {
    await Promise.all(this.resources.flat().map((resource) => resource.stop()));
  }
}
