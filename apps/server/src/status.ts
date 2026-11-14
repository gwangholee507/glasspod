// Pod마다 SDK 신호(T11의 지금 상태)와 쿠버네티스 Pod 상태(T12의 요약)를 합쳐 상태를 판단합니다(design.md 7.5).
// 판단 표와 결정은 docs/guides/T13.md에 있습니다. 여기 함수는 시각을 인자로 받는 순수 함수입니다.
import type { EventLevel, PodSeverity, PodStatus } from "@glasspod/protocol";
import type { PodSummary } from "./cluster.js";
import type { AppState } from "./pods.js";
import { RETENTION_MS } from "./store/store.js";
import type { EventRecord } from "./store/store.js";

// metrics가 이 주기 수만큼 없으면 앱 멈춤 의심입니다.
export const STALL_PERIODS = 3;
// SDK는 이보다 짧은 주기를 받아도 이 주기로 보냅니다(T05). 3주기를 셀 때 함께 봅니다.
export const MIN_METRICS_INTERVAL_MS = 1000;
// 재시작을 판단에 남기는 시간입니다. 직전 instance의 기록이 저장소에 남아 있는 동안과 같습니다(사용자 결정).
export const RESTART_WINDOW_MS = RETENTION_MS;
// 재시작 원인 후보로 고르는 event 수입니다.
export const MAX_RESTART_CAUSES = 5;

// 쿠버네티스가 정상 시작 중에 쓰는 waiting 이유입니다. 그 밖의 이유(CrashLoopBackOff 등)는 Pod 이상으로 봅니다.
const STARTING_WAIT_REASONS: ReadonlySet<string> = new Set([
  "ContainerCreating",
  "PodInitializing",
]);

const SEVERITY: Readonly<Record<PodStatus, PodSeverity>> = {
  terminated: "none",
  "pod-failing": "critical",
  stalled: "critical",
  disconnected: "critical",
  restarted: "warning",
  "not-ready": "warning",
  starting: "none",
  "no-sdk": "none",
  ok: "none",
};

// 원인 후보를 고를 때 앞에 둘 수준입니다.
const LEVEL_RANK: Readonly<Record<EventLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
};

export interface RestartInfo {
  // 재시작 시각(epoch ms)입니다. 쿠버네티스가 알린 직전 컨테이너의 종료 시각, 없으면 새 instance가 붙은 시각(서버 시계)입니다.
  at: number;
  // 쿠버네티스가 알린 종료 이유와 종료 코드입니다(예: OOMKilled 137, Error 1).
  reason?: string;
  exitCode?: number;
  // SDK가 새 instance로 다시 붙어 알게 된 직전 instance입니다. 원인 후보 event를 찾는 데 씁니다.
  previousInstanceId?: string;
}

export interface Judgment {
  status: PodStatus;
  severity: PodSeverity;
  // 판단의 근거입니다: 쿠버네티스 waiting 이유·phase·종료 이유, deleted, terminating, no-metrics.
  reason?: string;
  // stalled일 때만: 그 연결에서 마지막 metrics(없으면 연결) 뒤로 지난 시간입니다.
  silentMs?: number;
  // 30분 안의 재시작입니다. 판단이 restarted가 아니어도 붙습니다.
  restart?: RestartInfo;
}

export interface JudgeInput {
  now: number;
  // welcome으로 SDK에 알린 metrics 주기입니다(GLASSPOD_METRICS_INTERVAL_MS).
  metricsIntervalMs: number;
  // SDK 쪽 지금 상태입니다. SDK가 붙은 적이 없으면(또는 정리됐으면) 없습니다.
  app: AppState | undefined;
  // 쿠버네티스 Pod 요약입니다. watch가 꺼졌거나 쿠버네티스에 없는 Pod면 없습니다.
  pod: PodSummary | undefined;
}

// 연결이 열려 있는데 metrics가 이 시간과 같거나 길게 없으면 앱 멈춤 의심입니다.
export function stallLimitMs(metricsIntervalMs: number): number {
  return STALL_PERIODS * Math.max(metricsIntervalMs, MIN_METRICS_INTERVAL_MS);
}

// 30분 안의 재시작입니다. 쿠버네티스와 SDK 가운데 한쪽만 알아도 재시작으로 봅니다(두 신호가 오는 순서는 정해져 있지 않음).
export function recentRestart(
  app: AppState | undefined,
  pod: PodSummary | undefined,
  now: number,
): RestartInfo | undefined {
  const since = now - RESTART_WINDOW_MS;

  let kube:
    Required<Pick<RestartInfo, "at" | "reason" | "exitCode">> | undefined;
  const termination = pod?.lastTermination;
  if (pod !== undefined && pod.restarts > 0 && termination !== undefined) {
    const finishedAt =
      termination.finishedAt === undefined
        ? NaN
        : Date.parse(termination.finishedAt);
    if (!Number.isNaN(finishedAt) && finishedAt >= since) {
      kube = {
        at: finishedAt,
        reason: termination.reason,
        exitCode: termination.exitCode,
      };
    }
  }

  const previousInstanceId =
    app !== undefined &&
    app.previousInstanceId !== undefined &&
    app.instanceSince >= since
      ? app.previousInstanceId
      : undefined;

  if (kube === undefined && previousInstanceId === undefined) {
    return undefined;
  }
  return {
    ...(kube ?? { at: app?.instanceSince ?? now }),
    ...(previousInstanceId === undefined ? {} : { previousInstanceId }),
  };
}

// Pod 하나의 판단입니다. 판단 표(docs/guides/T13.md)의 위쪽 조건부터 봅니다.
export function judgePod(input: JudgeInput): Judgment {
  const { now, app, pod } = input;
  const restart = recentRestart(app, pod, now);
  const judge = (
    status: PodStatus,
    extra: Pick<Judgment, "reason" | "silentMs"> = {},
  ): Judgment => ({
    status,
    severity: SEVERITY[status],
    ...extra,
    ...(restart === undefined ? {} : { restart }),
  });

  // 종료됨: 쿠버네티스가 Pod를 끝내는 중이거나 지웠습니다. SDK 연결과 상관없습니다.
  if (pod?.terminating === true) {
    return judge("terminated", { reason: "terminating" });
  }
  if (pod === undefined && app?.deletedAt !== undefined) {
    return judge("terminated", { reason: "deleted" });
  }
  if (pod?.phase === "Succeeded") {
    return judge("terminated", { reason: "Succeeded" });
  }

  // Pod 이상: 쿠버네티스가 컨테이너를 띄우지 못하거나 Pod가 실패했습니다.
  if (pod?.phase === "Failed") {
    return judge("pod-failing", { reason: "Failed" });
  }
  if (pod?.waiting !== undefined && !STARTING_WAIT_REASONS.has(pod.waiting)) {
    return judge("pod-failing", { reason: pod.waiting });
  }
  // 여기까지 오면 waiting 이유는 시작 중인 것뿐입니다.
  const starting =
    pod !== undefined && (pod.phase === "Pending" || pod.waiting !== undefined);

  // SDK 신호: 연결이 열렸는데 metrics가 없거나, 연결이 끊겼습니다.
  if (app?.connected === true) {
    const silentMs = now - (app.lastMetricsAt ?? app.connectedAt);
    if (silentMs >= stallLimitMs(input.metricsIntervalMs)) {
      return judge("stalled", { reason: "no-metrics", silentMs });
    }
  } else if (app !== undefined && !starting) {
    return judge("disconnected");
  }

  if (restart !== undefined) {
    return judge(
      "restarted",
      restart.reason === undefined ? {} : { reason: restart.reason },
    );
  }

  if (app?.connected === true) {
    return pod !== undefined && !pod.ready ? judge("not-ready") : judge("ok");
  }

  // SDK 상태가 없거나, 끊겼는데 Pod가 시작 중입니다.
  if (starting) {
    return judge("starting", { reason: pod.waiting ?? pod.phase });
  }
  return judge("no-sdk");
}

// 재시작 원인 후보입니다. 직전 instance의 event를 error → warn → info, 같은 수준은 늦게 일어난 것부터 고릅니다.
// events는 저장소가 돌려준 순서(일어난 순서)입니다. ts가 같으면 나중에 받은 것을 앞에 둡니다.
export function pickRestartCauses(
  events: readonly EventRecord[],
  previousInstanceId: string,
  limit: number = MAX_RESTART_CAUSES,
): EventRecord[] {
  return events
    .filter((event) => event.instanceId === previousInstanceId)
    .reverse()
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.ts - a.ts)
    .slice(0, limit);
}
