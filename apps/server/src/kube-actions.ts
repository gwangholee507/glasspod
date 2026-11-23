// 조치가 부르는 쿠버네티스 API입니다(docs/guides/T21.md 결정 8, 9, docs/guides/T23.md 결정 8). 조치를 더할 때(T24 scale) 여기에 메서드를 더합니다.
// 서버의 ServiceAccount(클러스터 안) 또는 GLASSPOD_KUBE_CONTEXT의 kubeconfig로 부릅니다. watch와 같은 연결입니다.
import {
  AppsV1Api,
  CoreV1Api,
  Observable,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import type {
  ConfigurationOptions,
  ObservableMiddleware,
  V1ObjectMeta,
} from "@kubernetes/client-node";
import type { PodRef } from "@glasspod/protocol";
import { readIsolation } from "./isolation.js";
import type { KubeConnection } from "./kube.js";

// 쿠버네티스가 이 시간 안에 답하지 않으면 요청을 끊습니다. 실행됐는지는 알 수 없습니다(결정 8).
export const KUBE_ACTION_TIMEOUT_MS = 10_000;

// 트래픽에서 빼기를 계획하려고 새로 읽은 Pod입니다.
export interface KubePodObject {
  uid: string;
  resourceVersion: string;
  labels: Record<string, string>;
  terminating: boolean;
  isolated: boolean;
  // 이 Pod를 관리하는 ReplicaSet(controller owner)입니다.
  replicaSet: string | undefined;
}

export interface KubeReplicaSetObject {
  name: string;
  deployment: string | undefined;
  // selector.matchLabels입니다. matchExpressions만 있으면 undefined입니다.
  matchLabels: Record<string, string> | undefined;
}

export interface KubeServiceObject {
  name: string;
  selector: Record<string, string> | undefined;
}

export interface KubeActions {
  // Pod를 지웁니다. uid가 다르면(같은 이름의 다른 Pod) 쿠버네티스가 409로 거부합니다.
  deletePod(pod: PodRef, uid: string): Promise<void>;
  readPod(pod: PodRef): Promise<KubePodObject>;
  readReplicaSet(
    namespace: string,
    name: string,
  ): Promise<KubeReplicaSetObject>;
  listServices(namespace: string): Promise<KubeServiceObject[]>;
  // merge patch입니다. 본문의 metadata.resourceVersion이 지금과 다르면 쿠버네티스가 409로 거부합니다.
  patchPod(pod: PodRef, body: object): Promise<void>;
}

// 요청마다 시간 제한 신호를 넣는 미들웨어입니다. client-node의 기본 미들웨어(User-Agent) 뒤에 붙입니다.
function timeoutOptions(
  timeoutMs: number,
): ConfigurationOptions<ObservableMiddleware> {
  return {
    middleware: [
      {
        pre: (request) => {
          request.setSignal(AbortSignal.timeout(timeoutMs));
          return new Observable(Promise.resolve(request));
        },
        post: (response) => new Observable(Promise.resolve(response)),
      },
    ],
    middlewareMergeStrategy: "append",
  };
}

function controllerName(
  metadata: V1ObjectMeta | undefined,
  kind: string,
): string | undefined {
  return metadata?.ownerReferences?.find(
    (reference) => reference.controller === true && reference.kind === kind,
  )?.name;
}

export function createKubeActions(
  connection: KubeConnection,
  timeoutMs = KUBE_ACTION_TIMEOUT_MS,
): KubeActions {
  const core = connection.config.makeApiClient(CoreV1Api);
  const apps = connection.config.makeApiClient(AppsV1Api);
  return {
    async deletePod(pod, uid) {
      // 유예 시간은 Pod의 terminationGracePeriodSeconds(기본 30초)를 그대로 씁니다(결정 9).
      await core.deleteNamespacedPod(
        {
          namespace: pod.namespace,
          name: pod.name,
          body: { preconditions: { uid } },
        },
        timeoutOptions(timeoutMs),
      );
    },

    async readPod(pod) {
      const object = await core.readNamespacedPod(
        { namespace: pod.namespace, name: pod.name },
        timeoutOptions(timeoutMs),
      );
      const metadata = object.metadata;
      return {
        uid: metadata?.uid ?? "",
        resourceVersion: metadata?.resourceVersion ?? "",
        labels: { ...(metadata?.labels ?? {}) },
        terminating: metadata?.deletionTimestamp != null,
        isolated: readIsolation(metadata) !== undefined,
        replicaSet: controllerName(metadata, "ReplicaSet"),
      };
    },

    async readReplicaSet(namespace, name) {
      const object = await apps.readNamespacedReplicaSet(
        { namespace, name },
        timeoutOptions(timeoutMs),
      );
      const matchLabels = object.spec?.selector.matchLabels;
      return {
        name,
        deployment: controllerName(object.metadata, "Deployment"),
        matchLabels:
          matchLabels === undefined || Object.keys(matchLabels).length === 0
            ? undefined
            : { ...matchLabels },
      };
    },

    async listServices(namespace) {
      const list = await core.listNamespacedService(
        { namespace },
        timeoutOptions(timeoutMs),
      );
      return list.items.map((service) => ({
        name: service.metadata?.name ?? "",
        selector:
          service.spec?.selector === undefined
            ? undefined
            : { ...service.spec.selector },
      }));
    },

    async patchPod(pod, body) {
      // client-node는 patch를 JSON Patch로 보내므로 Content-Type을 merge patch로 바꿉니다.
      await core.patchNamespacedPod(
        { namespace: pod.namespace, name: pod.name, body },
        setHeaderOptions(
          "Content-Type",
          PatchStrategy.MergePatch,
          timeoutOptions(timeoutMs),
        ),
      );
    },
  };
}
