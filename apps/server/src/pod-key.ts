// Pod(namespace + 이름)를 Map 키와 로그 값으로 바꿉니다.
import type { PodRef } from "@glasspod/protocol";

// namespace와 이름을 이어 붙이면 '/'가 든 값끼리 겹칠 수 있으므로 JSON 배열로 만듭니다.
export function podKey(pod: PodRef): string {
  return JSON.stringify([pod.namespace, pod.name]);
}

// 로그에 쓰는 모양입니다(예: glasspod-demo/demo-app-5f7c9-abcde).
export function podLabel(pod: PodRef): string {
  return `${pod.namespace}/${pod.name}`;
}
