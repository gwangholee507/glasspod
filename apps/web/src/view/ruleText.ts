// 자동 규칙을 화면 글로 바꾸고 기록을 합치는 순수 함수입니다(docs/guides/T28.md 결정 2, 18, 24).
// 서버는 규칙과 기록을 코드로 보내므로(skipReason, actionError) 문장은 여기서 만듭니다.
import type {
  PodRef,
  RuleAction,
  RuleCondition,
  RuleConditionMatch,
  RuleFiring,
  RuleItem,
  RuleMode,
  RuleNote,
  RuleOutcome,
  RuleSkipReason,
} from "@glasspod/protocol";
import { errorSentence } from "./actionText.js";
import {
  STATUS_LABEL,
  formatDuration,
  formatOutlierValue,
  outlierLabel,
} from "./podText.js";
import type { Tone } from "./podText.js";

export const MODE_LABEL: Record<RuleMode, string> = {
  off: "꺼짐",
  notify: "알림만",
  auto: "자동",
};

export const OUTCOME_LABEL: Record<RuleOutcome, string> = {
  notified: "실행했을 것",
  executed: "실행함",
  skipped: "건너뜀",
};

// 규칙 시간(30s, 2m, 1h)을 그대로 읽히게 씁니다. 0이면 빈 글입니다.
export function ruleDuration(ms: number): string {
  if (ms <= 0) {
    return "";
  }
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}시간`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}분`;
  }
  return `${Math.round(ms / 1000)}초`;
}

// 조건 하나입니다. 예: '판단 앱 멈춤 의심 · 30초 이어짐', '다른 Pod보다 높음: 요청 p99 · 30초 이어짐',
// 'app.queue.length > 1,000 · 2분 이어짐'
export function conditionText(condition: RuleCondition): string {
  const body = ((): string => {
    switch (condition.signal) {
      case "status":
        return `판단 ${condition.statuses.map((status) => STATUS_LABEL[status]).join(" 또는 ")}`;
      case "outlier":
        return `다른 Pod보다 높음: ${outlierLabel(condition.metric)}`;
      case "metric":
        return `${outlierLabel(condition.metric)} ${condition.compare === "above" ? ">" : "<"} ${formatOutlierValue(condition.metric, condition.threshold)}`;
    }
  })();
  const lasting = ruleDuration(condition.forMs);
  return lasting === "" ? body : `${body} · ${lasting} 이어짐`;
}

// 조치입니다. 예: '조건이 맞은 Pod 재시작', 'replica +1 (최대 5개)'
export function ruleActionText(action: RuleAction): string {
  switch (action.kind) {
    case "restart":
      return "조건이 맞은 Pod 재시작";
    case "isolate":
      return "조건이 맞은 Pod를 트래픽에서 빼기";
    case "scale":
      return action.by > 0
        ? `replica +${action.by} (최대 ${action.max ?? 20}개)`
        : `replica ${action.by} (최소 ${action.min ?? 0}개)`;
  }
}

// 쉬는 시간과 시간당 횟수입니다. 예: '10분 쉼 · 시간당 2번까지'
export function ruleLimitsText(rule: RuleItem): string {
  const parts = [`${ruleDuration(rule.cooldownMs)} 쉼`];
  if (rule.maxPerHour !== undefined) {
    parts.push(`시간당 ${rule.maxPerHour}번까지`);
  }
  return parts.join(" · ");
}

const NOTE_SENTENCE: Record<RuleNote, string> = {
  "namespace-not-watched":
    "서버가 보지 않는 namespace입니다(GLASSPOD_NAMESPACES). 발동하지 않습니다.",
  "actions-disabled":
    "이 namespace는 조치가 꺼져 있어(GLASSPOD_ACTION_NAMESPACES) 자동 실행은 실패로 남습니다.",
  "deployment-not-found": "쿠버네티스에 이 Deployment가 없습니다.",
  hpa: "HPA가 붙어 있어 자동 스케일은 건너뜁니다.",
};

export function noteSentence(note: RuleNote): string {
  return NOTE_SENTENCE[note];
}

// 규칙의 지금 상태 한 줄입니다. 조건이 맞는 Pod는 화면이 따로 줄로 보입니다.
export function ruleStateText(rule: RuleItem, now: number): string {
  const { state } = rule;
  if (rule.mode === "off") {
    return "꺼져 있어 보지 않습니다.";
  }
  if (state.running === true) {
    return "자동 조치를 실행하는 중입니다.";
  }
  if (state.coolingUntil !== undefined) {
    return `쉬는 중입니다(${formatDuration(state.coolingUntil - now)} 남음).`;
  }
  if (state.matching.length === 0) {
    return "조건이 맞는 Pod가 없습니다.";
  }
  return `조건이 맞는 Pod ${state.matching.length}개`;
}

// 조건이 맞는 Pod 한 줄입니다. 예: '12초째 · 18초 뒤 발동'
export function matchText(
  match: { since: number; readyAt: number },
  now: number,
): string {
  const lasting = `${formatDuration(now - match.since)}째`;
  return match.readyAt > now
    ? // 1초 안쪽이 '0초 뒤'로 보이지 않게 올림합니다.
      `${lasting} · ${formatDuration(Math.ceil((match.readyAt - now) / 1000) * 1000)} 뒤 발동`
    : `${lasting} · 조건을 채움`;
}

// 맞은 조건과 그때 값입니다. 예: '요청 p99 1,003 ms (다른 Pod 31 ms)', '판단 앱 멈춤 의심', 'app.queue.length 120'
export function conditionValueText(match: RuleConditionMatch): string {
  const { condition } = match;
  switch (condition.signal) {
    case "status":
      return `판단 ${match.status === undefined ? "—" : STATUS_LABEL[match.status]}`;
    case "outlier":
      return match.value === undefined || match.peerMedian === undefined
        ? `다른 Pod보다 높음: ${outlierLabel(condition.metric)}`
        : `${outlierLabel(condition.metric)} ${formatOutlierValue(condition.metric, match.value)} (다른 Pod ${formatOutlierValue(condition.metric, match.peerMedian)})`;
    case "metric":
      return `${outlierLabel(condition.metric)} ${match.value === undefined ? "—" : formatOutlierValue(condition.metric, match.value)}`;
  }
}

export function firingConditionsText(firing: RuleFiring): string {
  return firing.conditions.map(conditionValueText).join(" · ");
}

function skipSentence(firing: RuleFiring): string {
  const reason: RuleSkipReason = firing.skipReason ?? "no-deployment";
  switch (reason) {
    case "max-per-hour":
      return "최근 1시간 발동 횟수가 한도(maxPerHour)에 닿았습니다.";
    case "no-deployment":
      return "쿠버네티스에 Deployment가 없습니다.";
    case "isolated-limit":
      return "이 Deployment에 이미 격리된 Pod가 있습니다(규칙은 1개까지 뺌).";
    case "too-few-healthy":
      return `이 Pod를 빼면 건강한 Pod가 ${firing.healthy ?? 0}개라 필요한 ${firing.needed ?? 1}개보다 적습니다.`;
    case "hpa":
      return "HPA가 이 Deployment의 replica 수를 정하고 있습니다.";
    case "at-limit":
      return `replica가 이미 ${firing.scale?.from ?? "?"}개로 한도입니다.`;
  }
}

function doneText(firing: RuleFiring, would: boolean): string {
  switch (firing.action) {
    case "restart-pod":
      return would ? "재시작했을 것입니다." : "재시작했습니다.";
    case "isolate-pod":
      return would ? "트래픽에서 뺐을 것입니다." : "트래픽에서 뺐습니다.";
    case "scale-deployment": {
      const change =
        firing.scale === undefined
          ? "replica 수를 바꿨"
          : `replica 수를 ${firing.scale.from}개에서 ${firing.scale.to}개로 바꿨`;
      return would ? `${change}을 것입니다.` : `${change}습니다.`;
    }
  }
}

// 기록 한 건의 문장입니다.
export function firingSentence(firing: RuleFiring): string {
  switch (firing.outcome) {
    case "notified":
      return `알림만이라 실행하지 않았습니다. 자동이었으면 ${doneText(firing, true)}`;
    case "skipped":
      return `건너뛰었습니다. ${skipSentence(firing)}`;
    case "executed":
      return firing.actionResult === "failed"
        ? `실행했지만 실패했습니다. ${errorSentence(firing.actionError ?? "kube-error", firing.target.kind)}`
        : doneText(firing, false);
  }
}

export function firingTone(firing: RuleFiring): Tone {
  switch (firing.outcome) {
    case "notified":
      return "neutral";
    case "skipped":
      return "warning";
    case "executed":
      return firing.actionResult === "failed" ? "warning" : "ok";
  }
}

// GET으로 받은 기록과 스트림으로 받은 기록을 합칩니다. 같은 id는 하나로, 늦은 것부터입니다.
export function mergeFirings(
  lists: readonly (readonly RuleFiring[])[],
): RuleFiring[] {
  const byId = new Map<string, RuleFiring>();
  for (const list of lists) {
    for (const firing of list) {
      byId.set(firing.id, firing);
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// 이 Pod가 조건에 맞아 남은 기록입니다.
export function isFiringOn(firing: RuleFiring, pod: PodRef): boolean {
  return firing.pod.namespace === pod.namespace && firing.pod.name === pod.name;
}
