// 같은 Deployment의 다른 Pod와 지표를 비교해 눈에 띄게 높은 Pod를 찾습니다(docs/guides/T34.md).
// 판단(status.ts, design.md 7.5)과 따로입니다. 판단 주기마다 statuses.evaluate() 뒤에 evaluate()를 부르고,
// 목록(feed.ts)이 get()으로 Pod 항목의 outliers를 채웁니다.
import type { PodOutlier, PodRef } from "@glasspod/protocol";
import type { ClusterState, PodSummary } from "./cluster.js";
import { log } from "./log.js";
import type { AppState, AppStates } from "./pods.js";
import { recentErrorEvents, recentIncrease } from "./pods.js";
import { podKey, podLabel } from "./pod-key.js";
import { stallLimitMs } from "./status.js";
import type { PodStatusEntry, StatusMonitor } from "./status-monitor.js";
import { HTTP_ERRORS_COUNTER } from "./views.js";

// 다른 Pod 값의 중앙값의 몇 배부터 높다고 보는지입니다(결정 2).
export const OUTLIER_RATIO = 2;
// 예외/분의 이름입니다. SDK 지표 이름에는 ':'를 쓸 수 없어 겹치지 않습니다(결정 11).
export const ERROR_EVENTS_METRIC = "event:error";
// 앱이 등록한 gauge의 최소 차이입니다. 단위를 몰라 개수로 봅니다(결정 5).
export const APP_GAUGE_FLOOR = 10;

const MIB = 1024 * 1024;

// 늘 비교하는 값과 최소 차이입니다(결정 1, 5). 본문의 outliers도 이 순서, 그 뒤 app.* gauge를 이름순으로 둡니다.
export const FIXED_OUTLIER_METRICS: readonly {
  metric: string;
  floor: number;
}[] = [
  { metric: "runtime.event_loop.lag_p99_ms", floor: 50 },
  { metric: "runtime.heap.used_bytes", floor: 50 * MIB },
  { metric: "http.requests.duration_p99_ms", floor: 100 },
  { metric: HTTP_ERRORS_COUNTER, floor: 5 },
  { metric: ERROR_EVENTS_METRIC, floor: 5 },
];

const FIXED_GAUGES = FIXED_OUTLIER_METRICS.slice(0, 3).map(
  (entry) => entry.metric,
);
const FIXED_ORDER = new Map(
  FIXED_OUTLIER_METRICS.map((entry, index) => [entry.metric, index]),
);
const FIXED_FLOOR = new Map(
  FIXED_OUTLIER_METRICS.map((entry) => [entry.metric, entry.floor]),
);

export function outlierFloor(metric: string): number {
  return FIXED_FLOOR.get(metric) ?? APP_GAUGE_FLOOR;
}

// 고정 값이 먼저(결정 1의 순서), 그 뒤 app.* gauge를 이름순으로 둡니다.
export function compareOutlierMetrics(a: string, b: string): number {
  const rankA = FIXED_ORDER.get(a) ?? FIXED_ORDER.size;
  const rankB = FIXED_ORDER.get(b) ?? FIXED_ORDER.size;
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// 값들의 중앙값입니다. 짝수 개면 가운데 둘의 평균입니다(결정 8). 빈 배열이면 undefined입니다.
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

// 다른 Pod 값의 중앙값(peerMedian)과 비교해 높은지입니다(결정 2, 5).
export function isHigh(
  metric: string,
  value: number,
  peerMedian: number,
): boolean {
  return (
    value - peerMedian >= outlierFloor(metric) &&
    value >= OUTLIER_RATIO * peerMedian
  );
}

// 비교에 드는 Pod인지입니다(결정 6, 7). Deployment가 있고, 트래픽에서 빼지 않았고, 지워지는 중이 아니고, SDK가 연결된 Pod입니다.
export function isComparable(
  entry: PodStatusEntry,
  summary: PodSummary | undefined,
  app: AppState | undefined,
): app is AppState {
  return (
    entry.deployment !== undefined &&
    summary !== undefined &&
    !summary.terminating &&
    summary.isolation === undefined &&
    app !== undefined &&
    app.connected &&
    app.deletedAt === undefined
  );
}

// 이 Pod에서 비교할 값입니다. 받은 지 freshMs보다 지난 값은 뺍니다(결정 1, 4).
// 5xx/분은 그 counter가 새로울 때, 예외/분은 metrics가 새로울 때만 있습니다(예외가 없으면 0).
export function comparableValues(
  app: AppState,
  now: number,
  freshMs: number,
): Map<string, number> {
  const since = now - freshMs;
  const values = new Map<string, number>();
  for (const name of FIXED_GAUGES) {
    const value = app.values.get(name);
    if (
      value !== undefined &&
      value.kind === "gauge" &&
      value.receivedAt >= since
    ) {
      values.set(name, value.value);
    }
  }
  const errors = app.values.get(HTTP_ERRORS_COUNTER);
  if (errors !== undefined && errors.receivedAt >= since) {
    values.set(
      HTTP_ERRORS_COUNTER,
      recentIncrease(app, HTTP_ERRORS_COUNTER, now),
    );
  }
  if (app.lastMetricsAt !== undefined && app.lastMetricsAt >= since) {
    values.set(ERROR_EVENTS_METRIC, recentErrorEvents(app, now));
  }
  for (const [name, value] of app.values) {
    if (
      name.startsWith("app.") &&
      value.kind === "gauge" &&
      value.receivedAt >= since
    ) {
      values.set(name, value.value);
    }
  }
  return values;
}

// 비교할 Pod 하나입니다. group은 namespace와 Deployment를 합친 키입니다.
export interface OutlierSubject {
  key: string;
  group: string;
  values: ReadonlyMap<string, number>;
}

// 값 하나를 다른 Pod와 비교한 결과입니다.
export interface MetricComparison {
  metric: string;
  value: number;
  peerMedian: number;
  peers: number;
  high: boolean;
}

// 같은 group의 다른 Pod와 값마다 비교합니다. 그 값을 가진 다른 Pod가 없으면 그 값은 결과에 없습니다.
// 돌려주는 Map의 키는 subject.key입니다.
export function compareSubjects(
  subjects: readonly OutlierSubject[],
): Map<string, MetricComparison[]> {
  const groups = new Map<string, OutlierSubject[]>();
  for (const subject of subjects) {
    const members = groups.get(subject.group) ?? [];
    members.push(subject);
    groups.set(subject.group, members);
  }
  const result = new Map<string, MetricComparison[]>();
  for (const members of groups.values()) {
    for (const subject of members) {
      const comparisons: MetricComparison[] = [];
      for (const [metric, value] of subject.values) {
        const peerValues: number[] = [];
        for (const other of members) {
          const peerValue = other.values.get(metric);
          if (other !== subject && peerValue !== undefined) {
            peerValues.push(peerValue);
          }
        }
        const peerMedian = median(peerValues);
        if (peerMedian === undefined) {
          continue;
        }
        comparisons.push({
          metric,
          value,
          peerMedian,
          peers: peerValues.length,
          high: isHigh(metric, value, peerMedian),
        });
      }
      comparisons.sort((a, b) => compareOutlierMetrics(a.metric, b.metric));
      result.set(subject.key, comparisons);
    }
  }
  return result;
}

export interface OutlierMonitorOptions {
  statuses: StatusMonitor;
  apps: AppStates;
  cluster: ClusterState;
  metricsIntervalMs: number;
  now?: () => number;
}

// Pod와 값 하나의 켜고 끄기 상태입니다(결정 10).
interface Track {
  pod: PodRef;
  metric: string;
  // 높음이 시작된 시각입니다. 강조의 since입니다.
  highSince: number;
  // 켜진 뒤 아님이 시작된 시각입니다.
  lowSince: number | undefined;
  on: boolean;
  // 마지막으로 비교한 값입니다. 비교할 수 없게 된 뒤에는 그 앞 값입니다.
  last: MetricComparison;
}

export class OutlierMonitor {
  private readonly statuses: StatusMonitor;
  private readonly apps: AppStates;
  private readonly cluster: ClusterState;
  private readonly metricsIntervalMs: number;
  private readonly now: () => number;
  // 'Pod 키 + 값 이름'마다 상태입니다.
  private readonly tracks = new Map<string, Track>();

  constructor(options: OutlierMonitorOptions) {
    this.statuses = options.statuses;
    this.apps = options.apps;
    this.cluster = options.cluster;
    this.metricsIntervalMs = options.metricsIntervalMs;
    this.now = options.now ?? Date.now;
  }

  // 판단(StatusMonitor.evaluate) 바로 뒤에 부릅니다. 같은 Deployment의 Pod끼리 비교하고 켜고 끕니다.
  evaluate(): void {
    const now = this.now();
    // 오래된 값의 기준과 켜고 끄는 시간은 '앱 멈춤 의심'과 같은 3주기입니다(결정 2, 4).
    const periodMs = stallLimitMs(this.metricsIntervalMs);
    const subjects: OutlierSubject[] = [];
    const pods = new Map<string, PodRef>();
    for (const entry of this.statuses.list()) {
      const summary = this.cluster.pods.get(
        entry.pod.namespace,
        entry.pod.name,
      );
      const app = this.apps.get(entry.pod);
      if (!isComparable(entry, summary, app)) {
        continue;
      }
      const key = podKey(entry.pod);
      pods.set(key, entry.pod);
      subjects.push({
        key,
        group: JSON.stringify([entry.pod.namespace, entry.deployment]),
        values: comparableValues(app, now, periodMs),
      });
    }

    const seen = new Set<string>();
    for (const [key, comparisons] of compareSubjects(subjects)) {
      const pod = pods.get(key) as PodRef;
      for (const comparison of comparisons) {
        const trackKey = `${key}\n${comparison.metric}`;
        const track = this.tracks.get(trackKey);
        if (!comparison.high) {
          if (track !== undefined) {
            // 켜지기 전이면 처음부터, 켜진 뒤면 지금 값으로 바꾸고 아래에서 끌지 봅니다.
            if (track.on) {
              track.last = comparison;
            } else {
              this.tracks.delete(trackKey);
            }
          }
          continue;
        }
        seen.add(trackKey);
        if (track === undefined) {
          this.tracks.set(trackKey, {
            pod,
            metric: comparison.metric,
            highSince: now,
            lowSince: undefined,
            on: false,
            last: comparison,
          });
          continue;
        }
        track.last = comparison;
        track.lowSince = undefined;
        if (!track.on && now - track.highSince >= periodMs) {
          track.on = true;
          log.warn("pod outlier", {
            pod: podLabel(pod),
            metric: comparison.metric,
            value: round(comparison.value),
            peerMedian: round(comparison.peerMedian),
            peers: comparison.peers,
          });
        }
      }
    }

    // 이번에 높지 않은 값입니다. 비교에서 빠진 Pod(트래픽에서 뺌, 지워지는 중, SDK 끊김, Deployment 없음)는 바로 끄고,
    // 비교하는 Pod는 아님이 3주기 이어지면 끕니다(결정 10).
    for (const [trackKey, track] of this.tracks) {
      if (seen.has(trackKey)) {
        continue;
      }
      const leftComparison = !pods.has(podKey(track.pod));
      if (!track.on) {
        this.tracks.delete(trackKey);
        continue;
      }
      track.lowSince ??= now;
      if (leftComparison || now - track.lowSince >= periodMs) {
        this.tracks.delete(trackKey);
        log.info("pod outlier cleared", {
          pod: podLabel(track.pod),
          metric: track.metric,
          ...(leftComparison ? { reason: "not-compared" } : {}),
        });
      }
    }
  }

  // 이 Pod에서 켜진 값입니다. 결정 1의 순서, app.* gauge는 이름순입니다.
  get(pod: PodRef): PodOutlier[] {
    const prefix = `${podKey(pod)}\n`;
    const outliers: PodOutlier[] = [];
    for (const [trackKey, track] of this.tracks) {
      if (!track.on || !trackKey.startsWith(prefix)) {
        continue;
      }
      outliers.push({
        metric: track.metric,
        value: track.last.value,
        peerMedian: track.last.peerMedian,
        peers: track.last.peers,
        since: track.highSince,
      });
    }
    return outliers.sort((a, b) => compareOutlierMetrics(a.metric, b.metric));
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
