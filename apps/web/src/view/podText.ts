// 판단을 화면 글로 바꾸는 순수 함수입니다(docs/guides/T18.md '판단 문장', 결정 11, 13, 14).
// 서버의 reason은 코드(no-metrics, OOMKilled 등)이므로 화면 문장은 여기서 만듭니다. 목록은 명사형, 타임라인은 '~습니다'입니다.
import type {
  PodItem,
  PodRestart,
  PodSeverity,
  PodStatus,
  PodStatusChange,
} from "@glasspod/protocol";

// 판단 이름입니다(design.md 7.5).
export const STATUS_LABEL: Record<PodStatus, string> = {
  terminated: "종료됨",
  "pod-failing": "Pod 이상",
  stalled: "앱 멈춤 의심",
  disconnected: "연결 끊김",
  restarted: "재시작",
  "not-ready": "준비 안 됨",
  starting: "시작 중",
  "no-sdk": "SDK 없음",
  ok: "정상",
};

// 판단 표의 순서입니다(위가 먼저). 같은 강조 안에서 정렬할 때 씁니다.
export const STATUS_ORDER: readonly PodStatus[] = [
  "terminated",
  "pod-failing",
  "stalled",
  "disconnected",
  "restarted",
  "not-ready",
  "starting",
  "no-sdk",
  "ok",
];

// 화면의 강조 색입니다(design.md 12장 '상태 배지와 강조 색'). 강조 없음 가운데 정상만 따로 칠합니다.
export type Tone = "critical" | "warning" | "ok" | "neutral";

// 판단마다 정해진 강조입니다. 타임라인의 이전 판단처럼 severity가 함께 오지 않는 값에도 씁니다.
const STATUS_TONE: Record<PodStatus, Tone> = {
  terminated: "neutral",
  "pod-failing": "critical",
  stalled: "critical",
  disconnected: "critical",
  restarted: "warning",
  "not-ready": "warning",
  starting: "neutral",
  "no-sdk": "neutral",
  ok: "ok",
};

export function statusTone(status: PodStatus): Tone {
  return STATUS_TONE[status];
}

export function severityRank(severity: PodSeverity): number {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
}

// 걸린 시간을 'N초', 'N분', 'N시간 M분', 'N일 M시간'으로 씁니다. 음수는 0초로 봅니다.
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}초`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}분`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}일` : `${days}일 ${rest}시간`;
}

// 항목 오른쪽 위의 시간입니다. 재시작은 재시작한 때부터, 위험·주의는 판단이 시작된 때부터, 그 밖은 이어진 시간입니다.
export function timeLabel(item: PodItem, now: number): string {
  if (item.status === "restarted" && item.restart !== undefined) {
    return `${formatDuration(now - item.restart.at)} 전`;
  }
  if (item.severity !== "none") {
    return `${formatDuration(now - item.since)} 전부터`;
  }
  return `${formatDuration(now - item.since)}째`;
}

// 브라우저 시간대의 'HH:MM:SS'입니다. 타임라인의 시각에 씁니다.
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

const integerFormat = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const BYTES_PER_MB = 1024 * 1024;

// 밀리초 지표입니다. 10ms보다 작으면 소수 한 자리, 그 밖은 정수에 천 단위 쉼표입니다. 없으면 '—'.
export function formatMs(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  if (value < 10) {
    return `${value.toFixed(1)} ms`;
  }
  return `${integerFormat.format(Math.round(value))} ms`;
}

// 바이트를 MB(1024² 바이트) 정수로 씁니다. 없으면 '—'.
export function formatMegabytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "—";
  }
  return `${integerFormat.format(Math.round(bytes / BYTES_PER_MB))} MB`;
}

function restartPhrase(restart: PodRestart | undefined): string {
  if (restart?.reason === undefined) {
    return "새 instance로 다시 붙음";
  }
  return restart.exitCode === undefined
    ? `${restart.reason}로 재시작`
    : `${restart.reason} (${restart.exitCode})로 재시작`;
}

function terminatedPhrase(reason: string | undefined): string {
  switch (reason) {
    case "terminating":
      return "Pod를 끝내는 중";
    case "deleted":
      return "쿠버네티스에서 지워짐";
    case "Succeeded":
      return "Pod가 끝남 (Succeeded)";
    default:
      return "Pod가 종료됨";
  }
}

// 목록 항목의 판단 문장(명사형)입니다. now는 서버 시계입니다.
export function podSentence(item: PodItem, now: number): string {
  const base = ((): string => {
    switch (item.status) {
      case "terminated":
        return terminatedPhrase(item.reason);
      case "pod-failing":
        return item.reason === "Failed"
          ? "Pod 실패 (Failed)"
          : `컨테이너를 띄우지 못함 (${item.reason ?? "이유 없음"})`;
      case "stalled": {
        const from = item.sdk?.lastMetricsAt ?? item.sdk?.connectedAt;
        return from === undefined
          ? "metrics 없음 · 이벤트 루프 막힘 의심"
          : `metrics ${formatDuration(now - from)}째 없음 · 이벤트 루프 막힘 의심`;
      }
      case "disconnected": {
        const at = item.sdk?.disconnectedAt;
        return at === undefined
          ? "SDK 연결 끊김"
          : `SDK 연결이 ${formatDuration(now - at)} 전에 끊김`;
      }
      case "restarted":
        return restartPhrase(item.restart);
      case "not-ready":
        return "SDK는 정상 · 쿠버네티스 Ready 아님";
      case "starting":
        return item.reason === undefined
          ? "시작 중"
          : `시작 중 (${item.reason})`;
      case "no-sdk":
        return "쿠버네티스 정보만 봄";
      case "ok":
        return "이상 신호 없음";
    }
  })();
  // 우선순위가 높은 판단에 가려진 30분 안의 재시작도 알립니다(docs/guides/T13.md 결정 8).
  if (item.status !== "restarted" && item.restart !== undefined) {
    return `${base} · ${formatDuration(now - item.restart.at)} 전 재시작`;
  }
  return base;
}

// 타임라인 한 줄의 문장('~습니다')입니다. 판단 변화 기록에는 재시작의 종료 코드가 없으므로 이유만 씁니다.
export function changeSentence(change: PodStatusChange): string {
  switch (change.status) {
    case "terminated":
      switch (change.reason) {
        case "terminating":
          return "Pod를 끝내는 중입니다.";
        case "deleted":
          return "쿠버네티스에서 지워졌습니다.";
        case "Succeeded":
          return "Pod가 끝났습니다 (Succeeded).";
        default:
          return "Pod가 종료됐습니다.";
      }
    case "pod-failing":
      return change.reason === "Failed"
        ? "Pod가 실패했습니다 (Failed)."
        : `쿠버네티스가 컨테이너를 띄우지 못합니다 (${change.reason ?? "이유 없음"}).`;
    case "stalled":
      return "metrics가 3주기 동안 오지 않았습니다.";
    case "disconnected":
      return "SDK 연결이 끊겼습니다.";
    case "restarted":
      return change.reason === undefined
        ? "새 instance로 다시 붙었습니다."
        : `Pod가 재시작했습니다. 쿠버네티스 종료 이유 ${change.reason}.`;
    case "not-ready":
      return "쿠버네티스가 Pod를 Ready로 보지 않습니다.";
    case "starting":
      return change.reason === undefined
        ? "Pod를 시작하는 중입니다."
        : `Pod를 시작하는 중입니다 (${change.reason}).`;
    case "no-sdk":
      return "SDK가 붙지 않은 Pod입니다.";
    case "ok":
      return change.previous === undefined
        ? "이상 신호가 없습니다."
        : "다시 정상입니다.";
  }
}
