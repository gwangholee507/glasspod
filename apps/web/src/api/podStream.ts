// 서버의 SSE(GET /api/stream)로 Pod 목록을 실시간으로 들고 있습니다(docs/guides/T14.md 결정 2, 15, 20).
// 연결 직후 pods(목록 전체)를 받고, 그 뒤 changes(바뀐 것)를 목록에 고쳐 끼웁니다.
// 끊기면 브라우저(EventSource)가 3초 뒤 다시 붙고, 서버가 pods부터 다시 보냅니다.
// 다시 붙을 때 SSE가 아닌 응답(개발 서버 프록시의 502, 서버의 503)을 받으면 EventSource는 더 시도하지 않으므로,
// 그때는 이 훅이 3초부터 30초까지 늘려 가며 새로 엽니다.
import { useEffect, useState } from "react";
import type {
  DeploymentItem,
  PodItem,
  PodListBody,
  PodListChanges,
  PodRef,
  PodStatusChange,
} from "@glasspod/protocol";
import { streamPath } from "./pods.js";

// 스트림으로 받은 판단 변화를 들고 있는 최대 수입니다. 넘으면 오래된 것부터 버립니다.
export const MAX_STREAM_STATUS_CHANGES = 500;

export interface PodStreamState {
  list: PodListBody;
  // 이 화면이 스트림으로 받은 판단 변화입니다(받은 순서). 그 전 30분은 GET /api/status-changes로 받습니다.
  statusChanges: PodStatusChange[];
}

// connecting: 처음 붙는 중, open: 받는 중, reconnecting: 끊겨 다시 붙는 중
export type PodStreamStatus = "connecting" | "open" | "reconnecting";

// EventSource가 닫힌 뒤 새로 열기까지 기다리는 시간입니다. 3초부터 2배씩, 30초까지.
const REOPEN_BASE_MS = 3_000;
const REOPEN_MAX_MS = 30_000;

// failures는 pods를 받지 못하고 닫힌 횟수(1부터)입니다.
export function reopenDelayMs(failures: number): number {
  return Math.min(
    REOPEN_BASE_MS * 2 ** Math.max(failures - 1, 0),
    REOPEN_MAX_MS,
  );
}

function refKey(ref: PodRef): string {
  return JSON.stringify([ref.namespace, ref.name]);
}

function compareRefs(a: PodRef, b: PodRef): number {
  if (a.namespace !== b.namespace) {
    return a.namespace < b.namespace ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// 같은 키의 항목을 바꾸고, 새 항목을 더하고, 빠진 것을 지운 뒤 namespace·이름 순서로 둡니다(서버와 같은 순서).
function merge<T>(
  items: readonly T[],
  changed: readonly T[],
  removed: readonly PodRef[],
  refOf: (item: T) => PodRef,
): T[] {
  if (changed.length === 0 && removed.length === 0) {
    return items as T[];
  }
  const byKey = new Map(items.map((item) => [refKey(refOf(item)), item]));
  for (const item of changed) {
    byKey.set(refKey(refOf(item)), item);
  }
  for (const ref of removed) {
    byKey.delete(refKey(ref));
  }
  return [...byKey.values()].sort((a, b) => compareRefs(refOf(a), refOf(b)));
}

// changes 한 건을 목록에 적용합니다. 바뀌지 않은 부분은 같은 배열을 그대로 둡니다.
export function applyPodChanges(
  state: PodStreamState,
  changes: PodListChanges,
): PodStreamState {
  const list: PodListBody = {
    serverTime: changes.serverTime,
    namespaces: changes.namespaces ?? state.list.namespaces,
    deployments: merge<DeploymentItem>(
      state.list.deployments,
      changes.deployments,
      changes.removedDeployments,
      (item) => item,
    ),
    pods: merge<PodItem>(
      state.list.pods,
      changes.pods,
      changes.removedPods,
      (item) => item.pod,
    ),
  };
  const statusChanges =
    changes.statusChanges.length === 0
      ? state.statusChanges
      : [...state.statusChanges, ...changes.statusChanges].slice(
          -MAX_STREAM_STATUS_CHANGES,
        );
  return { list, statusChanges };
}

// 다시 붙어 pods를 받으면 목록은 바꾸고, 받아 둔 판단 변화는 남깁니다.
export function applyPodList(
  state: PodStreamState | undefined,
  list: PodListBody,
): PodStreamState {
  return { list, statusChanges: state?.statusChanges ?? [] };
}

interface Streamed {
  namespace: string | undefined;
  state: PodStreamState | undefined;
  status: PodStreamStatus;
}

// namespace가 바뀌면 다시 엽니다. 화면을 떠나면 닫습니다.
export function usePodStream(namespace?: string): {
  state: PodStreamState | undefined;
  status: PodStreamStatus;
} {
  const [streamed, setStreamed] = useState<Streamed>({
    namespace,
    state: undefined,
    status: "connecting",
  });

  useEffect(() => {
    setStreamed({ namespace, state: undefined, status: "connecting" });
    let source: EventSource | undefined;
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    // 서버가 만든 본문이라 검증하지 않고 타입만 붙입니다(T17 결정 12). JSON이 아니면 그 이벤트는 버립니다.
    const parse = <T>(event: MessageEvent<string>): T | undefined => {
      try {
        return JSON.parse(event.data) as T;
      } catch {
        return undefined;
      }
    };

    const open = () => {
      const current = new EventSource(streamPath(namespace));
      source = current;
      current.addEventListener("pods", (event) => {
        const list = parse<PodListBody>(event);
        if (list !== undefined) {
          failures = 0;
          setStreamed((previous) => ({
            namespace,
            state: applyPodList(previous.state, list),
            status: "open",
          }));
        }
      });
      current.addEventListener("changes", (event) => {
        const changes = parse<PodListChanges>(event);
        if (changes !== undefined) {
          setStreamed((previous) =>
            previous.state === undefined
              ? previous
              : {
                  ...previous,
                  state: applyPodChanges(previous.state, changes),
                },
          );
        }
      });
      current.addEventListener("error", () => {
        setStreamed((previous) => ({ ...previous, status: "reconnecting" }));
        if (current.readyState === EventSource.CLOSED) {
          failures += 1;
          reopenTimer = setTimeout(open, reopenDelayMs(failures));
        }
      });
    };

    open();
    return () => {
      clearTimeout(reopenTimer);
      source?.close();
    };
  }, [namespace]);

  // namespace가 바뀐 직후의 렌더에서는 이전 namespace의 목록을 보이지 않습니다.
  if (streamed.namespace !== namespace) {
    return { state: undefined, status: "connecting" };
  }
  return { state: streamed.state, status: streamed.status };
}
