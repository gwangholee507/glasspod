// 자동 규칙의 순수 함수입니다(docs/guides/T28.md 결정 11, 14, 15). 시각과 상태를 인자로 받습니다.
// 상태를 들고 발동하는 쪽은 rule-engine.ts의 RuleEngine입니다.
import type {
  PodOutlier,
  PodSeverity,
  PodStatus,
  RuleAction,
  RuleCondition,
} from "@glasspod/protocol";
import { MAX_SCALE_REPLICAS } from "./actions.js";
import { ERROR_EVENTS_METRIC } from "./outliers.js";
import type { AppState } from "./pods.js";
import { recentErrorEvents, recentIncrease } from "./pods.js";

// 규칙이 Pod 하나를 볼 때 쓰는 것입니다.
export interface ConditionInput {
  status: PodStatus;
  // SDK 쪽 지금 상태입니다. SDK가 붙은 적이 없으면 없습니다.
  app: AppState | undefined;
  // 이 Pod에서 켜진 '다른 Pod보다 높은 값'입니다(T34).
  outliers: readonly PodOutlier[];
  now: number;
  // 이보다 오래 전에 받은 지표 값은 쓰지 않습니다(3 × max(주기, 1000ms), T34 결정 4).
  freshMs: number;
}

// 조건 하나를 지금 본 결과입니다. 값은 기록(RuleConditionMatch)에 남깁니다.
export interface ConditionResult {
  holds: boolean;
  status?: PodStatus;
  value?: number;
  peerMedian?: number;
}

// 지표 값입니다(결정 11). gauge는 마지막 값, counter는 최근 60초 증가량, event:error는 error event의 최근 60초 count 합입니다.
// 받은 지 freshMs보다 지났거나 없으면 undefined입니다.
export function metricValue(
  app: AppState | undefined,
  metric: string,
  now: number,
  freshMs: number,
): number | undefined {
  if (app === undefined) {
    return undefined;
  }
  const since = now - freshMs;
  if (metric === ERROR_EVENTS_METRIC) {
    return app.lastMetricsAt !== undefined && app.lastMetricsAt >= since
      ? recentErrorEvents(app, now)
      : undefined;
  }
  const latest = app.values.get(metric);
  if (latest === undefined || latest.receivedAt < since) {
    return undefined;
  }
  return latest.kind === "gauge"
    ? latest.value
    : recentIncrease(app, metric, now);
}

// 조건 하나가 지금 맞는지입니다(결정 11). 값이 없으면 맞지 않습니다.
export function evaluateCondition(
  condition: RuleCondition,
  input: ConditionInput,
): ConditionResult {
  switch (condition.signal) {
    case "status":
      return {
        holds: condition.statuses.includes(input.status),
        status: input.status,
      };
    case "outlier": {
      const outlier = input.outliers.find(
        (entry) => entry.metric === condition.metric,
      );
      return outlier === undefined
        ? { holds: false }
        : {
            holds: true,
            value: outlier.value,
            peerMedian: outlier.peerMedian,
          };
    }
    case "metric": {
      const value = metricValue(
        input.app,
        condition.metric,
        input.now,
        input.freshMs,
      );
      if (value === undefined) {
        return { holds: false };
      }
      return {
        holds:
          condition.compare === "above"
            ? value > condition.threshold
            : value < condition.threshold,
        value,
      };
    }
  }
}

// 건강한 Pod를 셀 때 보는 것입니다(결정 15 ②).
export interface PeerPod {
  key: string;
  ready: boolean;
  severity: PodSeverity;
  // 이 규칙의 조건이 지금 모두 맞습니다(지속 시간은 보지 않음).
  matching: boolean;
}

// 대상(targetKey)을 뺀 건강한 Pod 수입니다. peers는 규칙이 보는 Pod(결정 10: 쿠버네티스에 있고, 지워지는 중이 아니고,
// 격리되지 않은 같은 Deployment의 Pod)입니다.
export function healthyPeers(
  peers: readonly PeerPod[],
  targetKey: string,
): number {
  return peers.filter(
    (peer) =>
      peer.key !== targetKey &&
      peer.ready &&
      peer.severity !== "critical" &&
      !peer.matching,
  ).length;
}

// Pod 조치(재시작·트래픽에서 빼기)에 필요한 건강한 Pod 수입니다. 원하는 replica 수의 절반(올림), 적어도 1개입니다.
export function neededHealthy(desired: number): number {
  return Math.max(1, Math.ceil(desired / 2));
}

// 스케일 규칙이 바꿀 replica 수입니다(결정 14). 지금 원하는 수에 by를 더하고 min~max(없으면 0~20)로 자릅니다.
export function scaleTarget(
  desired: number,
  action: Extract<RuleAction, { kind: "scale" }>,
): number {
  const min = action.min ?? 0;
  const max = action.max ?? MAX_SCALE_REPLICAS;
  return Math.min(max, Math.max(min, desired + action.by));
}
