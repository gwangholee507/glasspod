// 상세 화면의 순수 함수입니다(docs/guides/T19.md): '무슨 일이 있었나' 줄, 원인 후보, 그래프 지표 고르기,
// 시계열을 uPlot 데이터로 바꾸기, 지표 단위, 다시 받기 간격.
import type {
  MetricKind,
  MetricSeriesBody,
  PodDetailBody,
  PodEvent,
  PodItem,
  PodMetricValue,
  PodStatus,
} from "@glasspod/protocol";
import {
  ACTION_LABEL,
  actionSentence,
  actionTone,
  actorLabel,
  isIsolation,
} from "./actionText.js";
import { changeSentence, formatMs, statusTone } from "./podText.js";
import type { Tone } from "./podText.js";

// ── 다시 받기(결정 11) ──

// 상세와 시계열을 다시 받는 최소 간격입니다. 지표가 5초마다 오므로 그보다 자주 받지 않습니다.
export const DETAIL_REFRESH_MS = 5_000;

// 마지막으로 받기 시작한 때(lastStartedAt)부터 지금(now)까지를 보고 얼마 뒤에 받을지 정합니다. 0이면 바로입니다.
export function refreshDelayMs(
  lastStartedAt: number | undefined,
  now: number,
  minIntervalMs = DETAIL_REFRESH_MS,
): number {
  if (lastStartedAt === undefined) {
    return 0;
  }
  return Math.max(0, lastStartedAt + minIntervalMs - now);
}

// ── '무슨 일이 있었나'(결정 12~14) ──

export const WHAT_HAPPENED_LIMIT = 100;

export type TimelineKind =
  "event" | "kube" | "connection" | "status" | "restart" | "action";

export interface TimelineRow {
  key: string;
  // 일어난 시각입니다. SDK event는 SDK 시계, 그 밖은 서버·쿠버네티스 시계입니다.
  at: number;
  kind: TimelineKind;
  tone: Tone;
  // 줄 앞의 작은 글(error, warn, info, 쿠버네티스, SDK, 판단, 조치)입니다.
  label: string;
  title: string;
  // 아랫줄입니다. 없으면 감춥니다.
  detail?: string;
  // 재시작 원인 후보 번호(1부터)입니다.
  cause?: number;
  // 판단 변화 줄의 이전·새 판단입니다.
  status?: { previous?: PodStatus; next: PodStatus };
  // 성공한 '트래픽에서 빼기' 줄입니다. '격리됨' 배지를 붙입니다(docs/guides/T23.md 결정 21).
  isolated?: true;
}

// instance id를 줄여 씁니다(예: 3f9c…a21).
export function shortInstance(instanceId: string): string {
  return instanceId.length > 10
    ? `${instanceId.slice(0, 4)}…${instanceId.slice(-3)}`
    : instanceId;
}

function eventKey(event: Pick<PodEvent, "instanceId" | "seq">): string {
  return `${event.instanceId}/${event.seq}`;
}

// 원인 후보의 순서(1부터)입니다. 서버가 고른 순서(error 먼저, 늦은 것 먼저)를 그대로 씁니다.
export function causeRanks(detail: PodDetailBody): Map<string, number> {
  return new Map(
    detail.restartCauses.map((event, index) => [eventKey(event), index + 1]),
  );
}

function stringField(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = data?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

const EVENT_TONE: Record<PodEvent["level"], Tone> = {
  error: "critical",
  warn: "warning",
  info: "neutral",
};

function eventRow(
  event: PodEvent,
  currentInstanceId: string | undefined,
  cause: number | undefined,
): TimelineRow {
  const parts: string[] = [];
  let title: string;
  if (event.name === "exception") {
    title = `${stringField(event.data, "errorType") ?? "Error"}: ${event.message ?? ""}`;
    if (stringField(event.data, "origin") !== undefined) {
      parts.push("처리되지 않은 예외");
    }
  } else if (event.name === "state") {
    title = event.message ?? event.name;
  } else {
    title = event.name;
    if (event.message !== undefined && event.message !== "") {
      parts.push(event.message);
    }
  }
  const where =
    stringField(event.data, "route") ?? stringField(event.data, "job");
  if (where !== undefined) {
    parts.unshift(where);
  }
  if (event.count > 1) {
    parts.push(`${event.count}번`);
  }
  if (
    currentInstanceId !== undefined &&
    event.instanceId !== currentInstanceId
  ) {
    parts.push(`이전 instance ${shortInstance(event.instanceId)}`);
  }
  return {
    key: `event/${eventKey(event)}`,
    at: event.ts,
    kind: "event",
    tone: EVENT_TONE[event.level],
    label: event.level,
    title,
    ...(parts.length === 0 ? {} : { detail: parts.join(" · ") }),
    ...(cause === undefined ? {} : { cause }),
  };
}

// 상세 본문과 목록 항목으로 '무슨 일이 있었나' 줄을 만듭니다. 늦은 것부터 limit줄까지입니다.
// 같은 시각이면 조치 → 재시작 → 쿠버네티스 → 판단 → 연결 → event 순서입니다.
// 조치는 30분이 지나도 상세 본문에 남아 있으므로 그 줄도 그대로 보입니다(docs/guides/T21.md 결정 21).
export function whatHappened(
  detail: PodDetailBody,
  item: PodItem,
  limit = WHAT_HAPPENED_LIMIT,
): { rows: TimelineRow[]; truncated: boolean } {
  const rows: TimelineRow[] = [];
  for (const action of detail.actions) {
    rows.push({
      key: `action/${action.id}`,
      at: action.requestedAt,
      kind: "action",
      tone: actionTone(action),
      label: "조치",
      title: `${ACTION_LABEL[action.action]} · ${actorLabel(action.actor)}`,
      detail: actionSentence(action),
      ...(isIsolation(action) ? { isolated: true as const } : {}),
    });
  }
  const restart = item.restart;
  if (restart?.reason !== undefined) {
    const exit =
      restart.exitCode === undefined ? "" : ` (exit ${restart.exitCode})`;
    rows.push({
      key: `restart/${restart.at}`,
      at: restart.at,
      kind: "restart",
      tone: "critical",
      label: "쿠버네티스",
      title: `${restart.reason}${exit} → 컨테이너 재시작`,
      ...(restart.previousInstanceId !== undefined && item.sdk !== undefined
        ? {
            detail: `새 instance ${shortInstance(item.sdk.instanceId)}로 다시 붙음`,
          }
        : {}),
    });
  }
  for (const event of detail.kubeEvents) {
    const parts: string[] = [];
    if (event.message !== undefined) {
      parts.push(event.message);
    }
    if (event.count > 1) {
      parts.push(`${event.count}번`);
    }
    rows.push({
      key: `kube/${event.uid}`,
      at: event.lastAt,
      kind: "kube",
      tone: event.type === "Warning" ? "warning" : "neutral",
      label: "쿠버네티스",
      title: event.reason,
      ...(parts.length === 0 ? {} : { detail: parts.join(" · ") }),
    });
  }
  for (const change of detail.statusChanges) {
    rows.push({
      key: `status/${change.at}/${change.status}`,
      at: change.at,
      kind: "status",
      tone: statusTone(change.status),
      label: "판단",
      title: changeSentence(change),
      status:
        change.previous === undefined
          ? { next: change.status }
          : { previous: change.previous, next: change.status },
    });
  }
  for (const connection of detail.connections) {
    const short = shortInstance(connection.instanceId);
    const row = ((): Pick<TimelineRow, "title" | "detail"> => {
      if (connection.change === "disconnected") {
        return {
          title: "연결 끊김",
          ...(connection.code === undefined
            ? {}
            : { detail: `코드 ${connection.code}` }),
        };
      }
      if (connection.newInstance === true) {
        return { title: "새 instance로 연결됨", detail: `instance ${short}` };
      }
      if (connection.newInstance === false) {
        return { title: "다시 연결됨" };
      }
      return { title: "연결됨", detail: `instance ${short}` };
    })();
    rows.push({
      key: `connection/${connection.at}/${connection.change}/${connection.instanceId}`,
      at: connection.at,
      kind: "connection",
      tone: "neutral",
      label: "SDK",
      ...row,
    });
  }
  const ranks = causeRanks(detail);
  for (const event of detail.events) {
    rows.push(
      eventRow(event, item.sdk?.instanceId, ranks.get(eventKey(event))),
    );
  }
  // sort는 안정 정렬이라 같은 시각이면 위에서 넣은 순서가 남습니다.
  rows.sort((a, b) => b.at - a.at);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

// ── 그래프(결정 2, 15~18) ──

export type MetricUnit = "megabytes" | "ms" | "perMinute" | "number";

export interface ChartSpec {
  name: string;
  title: string;
  unit: MetricUnit;
}

export const HEAP_LIMIT_METRIC = "runtime.heap.limit_bytes";
export const HTTP_ERRORS_METRIC = "http.requests.errors_total";

// 고정 그래프 3개입니다(결정 2).
export const FIXED_CHARTS: readonly ChartSpec[] = [
  { name: "runtime.heap.used_bytes", title: "힙 사용", unit: "megabytes" },
  {
    name: "runtime.event_loop.lag_p99_ms",
    title: "이벤트 루프 p99",
    unit: "ms",
  },
  { name: "http.requests.duration_p99_ms", title: "요청 p99", unit: "ms" },
];

const FIXED_NAMES = new Set([
  ...FIXED_CHARTS.map((chart) => chart.name),
  HEAP_LIMIT_METRIC,
]);

// 지표 이름과 종류로 단위를 정합니다. counter는 분당 증가량입니다(결정 7).
export function metricUnit(
  name: string,
  kind: MetricKind | undefined,
): MetricUnit {
  if (kind === "counter") {
    return "perMinute";
  }
  if (name.endsWith("_ms")) {
    return "ms";
  }
  if (name.endsWith("_bytes")) {
    return "megabytes";
  }
  return "number";
}

// 네 번째 그래프로 고를 수 있는 지표입니다. 이름순이고 고정 3개와 힙 한도는 뺍니다(결정 16).
export function fourthChartOptions(
  values: readonly PodMetricValue[],
): PodMetricValue[] {
  return values
    .filter((value) => !FIXED_NAMES.has(value.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// 네 번째 그래프 지표입니다. 고른 것이 없거나 이 Pod에 없으면 기본값: 첫 app.* gauge → 5xx counter → 첫 번째.
export function chooseFourthChart(
  values: readonly PodMetricValue[],
  selected: string | undefined,
): ChartSpec | undefined {
  const options = fourthChartOptions(values);
  const pick =
    options.find((value) => value.name === selected) ??
    options.find(
      (value) => value.name.startsWith("app.") && value.kind === "gauge",
    ) ??
    options.find((value) => value.name === HTTP_ERRORS_METRIC) ??
    options[0];
  if (pick === undefined) {
    return undefined;
  }
  return {
    name: pick.name,
    title: pick.name === HTTP_ERRORS_METRIC ? "5xx" : pick.name,
    unit: metricUnit(pick.name, pick.kind),
  };
}

const BYTES_PER_MB = 1024 * 1024;

// API 값을 그래프에 그리는 값으로 바꿉니다. 힙은 MB, counter의 초당 값은 분당으로.
export function toDisplayValue(value: number, unit: MetricUnit): number {
  switch (unit) {
    case "megabytes":
      return value / BYTES_PER_MB;
    case "perMinute":
      return value * 60;
    default:
      return value;
  }
}

const integerFormat = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});
const decimalFormat = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 2,
});

// 그래프에 그린 값(toDisplayValue 뒤)을 글로 씁니다. 없으면 '—'.
export function formatDisplayValue(
  value: number | null | undefined,
  unit: MetricUnit,
): string {
  if (value === null || value === undefined) {
    return "—";
  }
  switch (unit) {
    case "megabytes":
      return `${integerFormat.format(Math.round(value))} MB`;
    case "ms":
      return formatMs(value);
    case "perMinute":
      return `${value < 10 ? value.toFixed(1) : integerFormat.format(Math.round(value))}/분`;
    case "number":
      return decimalFormat.format(value);
  }
}

// uPlot의 aligned data입니다. [x(ms), 이 Pod, 다른 Pod...]. null은 끊긴 곳, undefined는 그 Pod에 그 시각이 없음입니다.
export type ChartData = [number[], ...(number | null | undefined)[][]];

export interface ChartSeries {
  data: ChartData;
  // 이 Pod가 그 지표를 한 번이라도 보냈는지입니다.
  hasOwnData: boolean;
  // 이 Pod의 마지막 값(그린 값)입니다.
  last: number | undefined;
}

// 시계열 본문에서 지표 하나를 꺼내 Pod들을 한 X축으로 합칩니다. 본문에 그 지표가 없으면 undefined입니다.
export function chartSeries(
  body: MetricSeriesBody,
  name: string,
  unit: MetricUnit,
): ChartSeries | undefined {
  const index = body.metrics.findIndex((metric) => metric.name === name);
  if (index < 0) {
    return undefined;
  }
  const xs = [...new Set(body.pods.flatMap((pod) => pod.times))].sort(
    (a, b) => a - b,
  );
  const position = new Map(xs.map((x, at) => [x, at]));
  const columns = body.pods.map((pod) => {
    const column: (number | null | undefined)[] = new Array<undefined>(
      xs.length,
    ).fill(undefined);
    const values = pod.values[index] ?? [];
    pod.times.forEach((time, at) => {
      const value = values[at];
      column[position.get(time) as number] =
        value === null || value === undefined
          ? null
          : toDisplayValue(value, unit);
    });
    return column;
  });
  const own = body.pods[0]?.values[index] ?? [];
  let last: number | undefined;
  for (let at = own.length - 1; at >= 0; at -= 1) {
    const value = own[at];
    if (typeof value === "number") {
      last = toDisplayValue(value, unit);
      break;
    }
  }
  return {
    data: [xs, ...columns],
    hasOwnData: own.some((value) => typeof value === "number"),
    last,
  };
}

// 마우스가 가리킨 칸(index)에서 가장 가까운 이 Pod의 값 위치입니다. 이 Pod 값이 없으면 undefined입니다.
export function nearestValueIndex(
  values: readonly (number | null | undefined)[],
  index: number,
): number | undefined {
  for (let step = 0; step < values.length; step += 1) {
    for (const at of [index - step, index + step]) {
      if (at >= 0 && at < values.length && typeof values[at] === "number") {
        return at;
      }
    }
  }
  return undefined;
}

// 그래프의 재시작 표시입니다. 기간 안에 새 instance로 연결된 시각입니다(결정 15).
export function restartMarks(detail: PodDetailBody, since: number): number[] {
  return detail.connections
    .filter(
      (connection) =>
        connection.change === "connected" &&
        connection.newInstance === true &&
        connection.at >= since,
    )
    .map((connection) => connection.at);
}

// ── 머리줄(결정 10) ──

// 판단 문장 뒤에 붙는 'Deployment · IP · 나이 N'입니다. 없는 값은 뺍니다.
export function podFacts(
  item: PodItem,
  now: number,
  formatAge: (ms: number) => string,
): string[] {
  const facts: string[] = [];
  const isolation = item.kube?.isolation;
  if (isolation !== undefined) {
    // 격리된 Pod는 Deployment가 놓아주었으므로 원래 Deployment와 뺀 때를 씁니다(docs/guides/T23.md 결정 17).
    if (isolation.deployment !== undefined) {
      facts.push(`원래 Deployment ${isolation.deployment}`);
    }
    if (isolation.at !== undefined) {
      facts.push(`격리 ${formatAge(Math.max(0, now - isolation.at))} 전`);
    }
  } else if (item.deployment !== undefined) {
    facts.push(item.deployment);
  }
  if (item.kube?.ip !== undefined) {
    facts.push(item.kube.ip);
  }
  const created =
    item.kube?.createdAt === undefined ? NaN : Date.parse(item.kube.createdAt);
  if (!Number.isNaN(created)) {
    facts.push(`나이 ${formatAge(now - created)}`);
  }
  return facts;
}
