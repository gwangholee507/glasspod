// 모든 Pod의 상태를 주기마다 판단해 들고 있습니다(docs/guides/T13.md 결정 5).
// 쿠버네티스 Pod(ClusterState)와 SDK 상태가 있는 Pod(AppStates)를 모두 판단합니다.
// 판단이 바뀌면 로그에 한 줄 남기고, 재시작이면 직전 instance의 event에서 원인 후보를 찾아 로그에 남깁니다.
// 판단(status)이 바뀌면 저장소에 판단 변화를 남기고 evaluate()가 돌려줍니다(docs/guides/T14.md 결정 3, 4).
// T14 조회 API와 SSE가 get·list로 읽습니다.
import type { PodRef } from "@glasspod/protocol";
import type { ClusterState, PodSummary } from "./cluster.js";
import { log } from "./log.js";
import type { LogFields } from "./log.js";
import type { AppState, AppStates } from "./pods.js";
import { podKey, podLabel } from "./pod-key.js";
import { judgePod, pickRestartCauses } from "./status.js";
import type { Judgment } from "./status.js";
import { RETENTION_MS } from "./store/store.js";
import type { StatusChangeRecord, Store } from "./store/store.js";

// 판단하는 주기입니다. '3주기째 없음'과 '재시작 30분'은 메시지가 오지 않아도 시간이 지나면 바뀝니다.
export const STATUS_INTERVAL_MS = 1000;
// 원인 후보 event의 message는 이 길이까지만 로그에 씁니다.
const MAX_CAUSE_MESSAGE_LENGTH = 200;

// Pod 하나의 판단입니다. since는 지금 판단(status)이 시작된 시각(서버 시계)입니다.
// deployment는 쿠버네티스 요약이 있으면 ReplicaSet → Deployment, 없으면(지워짐) 앞에서 알던 값입니다.
export interface PodStatusEntry extends Judgment {
  pod: PodRef;
  since: number;
  deployment?: string;
}

export interface StatusMonitorOptions {
  apps: AppStates;
  cluster: ClusterState;
  store: Store;
  metricsIntervalMs: number;
  now?: () => number;
}

interface Sources {
  pod: PodRef;
  summary?: PodSummary;
  app?: AppState;
}

export class StatusMonitor {
  private readonly apps: AppStates;
  private readonly cluster: ClusterState;
  private readonly store: Store;
  private readonly metricsIntervalMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, PodStatusEntry>();
  // Pod마다 원인 후보를 찾은 마지막 직전 instance입니다. 같은 재시작을 두 번 찾지 않습니다.
  private readonly causesFound = new Map<string, string>();

  constructor(options: StatusMonitorOptions) {
    this.apps = options.apps;
    this.cluster = options.cluster;
    this.store = options.store;
    this.metricsIntervalMs = options.metricsIntervalMs;
    this.now = options.now ?? Date.now;
  }

  // 모든 Pod를 판단합니다. 쿠버네티스에도 SDK 상태에도 없는 Pod는 목록에서 뺍니다.
  // 판단(status)이 바뀐 Pod의 판단 변화를 돌려줍니다. 저장소에도 남깁니다(기다리지 않음).
  evaluate(): StatusChangeRecord[] {
    const now = this.now();
    const changes: StatusChangeRecord[] = [];
    const sources = new Map<string, Sources>();
    for (const summary of this.cluster.pods.list()) {
      const pod = { namespace: summary.namespace, name: summary.name };
      sources.set(podKey(pod), { pod, summary });
    }
    for (const app of this.apps.list()) {
      const key = podKey(app.pod);
      const known = sources.get(key);
      if (known === undefined) {
        sources.set(key, { pod: app.pod, app });
      } else {
        known.app = app;
      }
    }

    for (const [key, source] of sources) {
      const judgment = judgePod({
        now,
        metricsIntervalMs: this.metricsIntervalMs,
        app: source.app,
        pod: source.summary,
      });
      const deployment =
        source.summary === undefined
          ? this.entries.get(key)?.deployment
          : this.cluster.deploymentOf(source.summary);
      const change = this.update(key, source.pod, judgment, deployment, now);
      if (change !== undefined) {
        changes.push(change);
      }
    }

    for (const [key, entry] of this.entries) {
      if (!sources.has(key)) {
        this.entries.delete(key);
        this.causesFound.delete(key);
        log.info("pod status removed", {
          pod: podLabel(entry.pod),
          previous: entry.status,
        });
      }
    }

    for (const change of changes) {
      this.store.addStatusChange(change).catch((error: unknown) => {
        log.warn("store write failed", {
          kind: "statusChanges",
          pod: podLabel(change.pod),
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return changes;
  }

  get(pod: PodRef): PodStatusEntry | undefined {
    return this.entries.get(podKey(pod));
  }

  list(): PodStatusEntry[] {
    return [...this.entries.values()];
  }

  // 판단을 바꾸고, 판단(status)이 바뀌었으면 판단 변화를 돌려줍니다.
  private update(
    key: string,
    pod: PodRef,
    judgment: Judgment,
    deployment: string | undefined,
    now: number,
  ): StatusChangeRecord | undefined {
    const previous = this.entries.get(key);
    const since =
      previous !== undefined && previous.status === judgment.status
        ? previous.since
        : now;
    const entry: PodStatusEntry = {
      pod,
      ...judgment,
      since,
      ...(deployment === undefined ? {} : { deployment }),
    };
    this.entries.set(key, entry);

    if (previous === undefined || changed(previous, entry)) {
      const fields = statusFields(entry, previous);
      if (entry.severity === "none") {
        log.info("pod status", fields);
      } else {
        log.warn("pod status", fields);
      }
    }

    const previousInstanceId = entry.restart?.previousInstanceId;
    if (
      previousInstanceId !== undefined &&
      this.causesFound.get(key) !== previousInstanceId
    ) {
      this.causesFound.set(key, previousInstanceId);
      void this.logRestartCauses(pod, previousInstanceId, now);
    }

    if (previous !== undefined && previous.status === entry.status) {
      return undefined;
    }
    return {
      pod,
      at: now,
      status: entry.status,
      severity: entry.severity,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(previous === undefined ? {} : { previous: previous.status }),
      ...(deployment === undefined ? {} : { deployment }),
    };
  }

  // 직전 instance의 event에서 원인 후보를 골라 한 줄씩 남깁니다. 화면 표시는 T19입니다.
  private async logRestartCauses(
    pod: PodRef,
    previousInstanceId: string,
    now: number,
  ): Promise<void> {
    const fields: LogFields = {
      pod: podLabel(pod),
      previousInstance: previousInstanceId,
    };
    try {
      const records = await this.store.podRecords(pod, now - RETENTION_MS);
      const causes = pickRestartCauses(records.events, previousInstanceId);
      causes.forEach((event, index) => {
        const data = event.data ?? {};
        log.info("restart cause", {
          ...fields,
          rank: index + 1,
          level: event.level,
          name: event.name,
          count: event.count,
          at: new Date(event.ts).toISOString(),
          errorType:
            typeof data.errorType === "string" ? data.errorType : undefined,
          fatal: data.fatal === true ? true : undefined,
          message: event.message?.slice(0, MAX_CAUSE_MESSAGE_LENGTH),
        });
      });
      log.info("restart causes", { ...fields, count: causes.length });
    } catch (error) {
      log.warn("restart causes failed", {
        ...fields,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// 로그를 남길 만큼 바뀌었는지입니다. silentMs처럼 매번 바뀌는 값은 보지 않습니다.
function changed(previous: PodStatusEntry, next: PodStatusEntry): boolean {
  return (
    previous.status !== next.status ||
    previous.reason !== next.reason ||
    previous.restart?.at !== next.restart?.at ||
    previous.restart?.reason !== next.restart?.reason ||
    previous.restart?.exitCode !== next.restart?.exitCode ||
    previous.restart?.previousInstanceId !== next.restart?.previousInstanceId
  );
}

function statusFields(
  entry: PodStatusEntry,
  previous: PodStatusEntry | undefined,
): LogFields {
  const { restart } = entry;
  return {
    pod: podLabel(entry.pod),
    status: entry.status,
    previous: previous?.status,
    severity: entry.severity,
    reason: entry.reason,
    silentMs: entry.silentMs,
    restartAt:
      restart === undefined ? undefined : new Date(restart.at).toISOString(),
    restartReason: restart?.reason,
    exitCode: restart?.exitCode,
    previousInstance: restart?.previousInstanceId,
  };
}
