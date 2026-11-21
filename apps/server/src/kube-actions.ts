// 조치가 부르는 쿠버네티스 API입니다(docs/guides/T21.md 결정 8, 9). 조치를 더할 때(T23 patch, T24 scale) 여기에 메서드를 더합니다.
// 서버의 ServiceAccount(클러스터 안) 또는 GLASSPOD_KUBE_CONTEXT의 kubeconfig로 부릅니다. watch와 같은 연결입니다.
import { CoreV1Api, Observable } from "@kubernetes/client-node";
import type {
  ConfigurationOptions,
  ObservableMiddleware,
} from "@kubernetes/client-node";
import type { PodRef } from "@glasspod/protocol";
import type { KubeConnection } from "./kube.js";

// 쿠버네티스가 이 시간 안에 답하지 않으면 요청을 끊습니다. 실행됐는지는 알 수 없습니다(결정 8).
export const KUBE_ACTION_TIMEOUT_MS = 10_000;

export interface KubeActions {
  // Pod를 지웁니다. uid가 다르면(같은 이름의 다른 Pod) 쿠버네티스가 409로 거부합니다.
  deletePod(pod: PodRef, uid: string): Promise<void>;
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

export function createKubeActions(
  connection: KubeConnection,
  timeoutMs = KUBE_ACTION_TIMEOUT_MS,
): KubeActions {
  const core = connection.config.makeApiClient(CoreV1Api);
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
  };
}
