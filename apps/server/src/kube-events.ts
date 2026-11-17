// 쿠버네티스 Event(core/v1)를 저장소 기록으로 바꿉니다(docs/guides/T19.md 결정 8).
// Pod에 대한 Event만 남깁니다. 상세 화면의 '무슨 일이 있었나'가 읽습니다.
import type { CoreV1Event } from "@kubernetes/client-node";
import type { KubeEventRecord } from "./store/store.js";

// client-node는 처음 list로 받은 시각을 Date로, watch로 받은 시각을 문자열로 줄 때가 있습니다(T12, T14).
function timeMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

function firstTime(...values: unknown[]): number | undefined {
  for (const value of values) {
    const time = timeMs(value);
    if (time !== undefined) {
      return time;
    }
  }
  return undefined;
}

// Pod에 대한 Event면 기록을, 아니면(Deployment, ReplicaSet 등) undefined를 돌려줍니다.
// 시각이 하나도 없는 Event는 받은 시각을 씁니다.
export function kubeEventRecord(
  event: CoreV1Event,
  receivedAt: number,
): KubeEventRecord | undefined {
  const object = event.involvedObject;
  const namespace = object.namespace ?? event.metadata?.namespace;
  const uid = event.metadata?.uid;
  if (
    object.kind !== "Pod" ||
    object.name === undefined ||
    namespace === undefined ||
    uid === undefined
  ) {
    return undefined;
  }
  const message = event.message?.trim();
  const firstAt = firstTime(event.firstTimestamp, event.eventTime);
  return {
    pod: { namespace, name: object.name },
    uid,
    type: event.type ?? "Normal",
    reason: event.reason ?? "Unknown",
    ...(message === undefined || message === "" ? {} : { message }),
    // events.k8s.io/v1로 만든 Event는 count 대신 series.count를 씁니다.
    count: event.count ?? event.series?.count ?? 1,
    ...(firstAt === undefined ? {} : { firstAt }),
    lastAt:
      firstTime(
        event.lastTimestamp,
        event.series?.lastObservedTime,
        event.eventTime,
        event.metadata?.creationTimestamp,
      ) ?? receivedAt,
    receivedAt,
  };
}
