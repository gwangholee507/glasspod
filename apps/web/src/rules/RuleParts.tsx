// 자동 규칙 화면과 한눈에 보기 타임라인이 함께 쓰는 작은 조각입니다(docs/guides/T28.md 결정 2, 24).
import type { RuleFiring, RuleMode } from "@glasspod/protocol";
import { Link } from "react-router";
import { overviewLink, podLink } from "../shell/shellContext.js";
import { HexagonIcon } from "../ui/icons.js";
import type { Tone } from "../view/podText.js";
import { MODE_LABEL, OUTCOME_LABEL, firingTone } from "../view/ruleText.js";

const MODE_BADGE: Record<RuleMode, string> = {
  off: "bg-neutral-wash text-neutral-ink",
  notify:
    "bg-warning-wash text-warning-ink ring-1 ring-inset ring-warning-line",
  auto: "bg-mist text-deep-teal",
};

const OUTCOME_BADGE: Record<Tone, string> = {
  critical: "bg-coral text-critical-ink",
  warning:
    "bg-warning-wash text-warning-ink ring-1 ring-inset ring-warning-line",
  ok: "bg-mist text-deep-teal",
  neutral: "bg-neutral-wash text-neutral-ink",
};

// 모드 배지입니다. 꺼짐은 회색, 알림만은 주의 색, 자동은 정상 색입니다.
export function ModeBadge({ mode }: { mode: RuleMode }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${MODE_BADGE[mode]}`}
    >
      {MODE_LABEL[mode]}
    </span>
  );
}

// 결과 배지입니다('실행했을 것', '실행함', '건너뜀'). 자동 실행이 실패하면 '실행함 · 실패'입니다.
export function OutcomeBadge({ firing }: { firing: RuleFiring }) {
  const failed = firing.actionResult === "failed";
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${
        failed ? OUTCOME_BADGE.critical : OUTCOME_BADGE[firingTone(firing)]
      }`}
    >
      {OUTCOME_LABEL[firing.outcome]}
      {failed ? " · 실패" : ""}
    </span>
  );
}

// 기록의 대상 칸입니다. 조건이 맞은 Pod는 상세로, 스케일이면 Deployment도 한눈에 보기로 잇습니다.
export function FiringTargetLink({
  firing,
  namespace,
  showNamespace,
}: {
  firing: RuleFiring;
  namespace: string | undefined;
  showNamespace: boolean;
}) {
  const prefix = showNamespace ? `${firing.pod.namespace}/` : "";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {firing.target.kind === "deployment" && (
        <Link
          to={overviewLink(namespace)}
          className="inline-flex items-center gap-1 font-mono text-xs whitespace-nowrap text-deep-teal hover:underline"
        >
          <HexagonIcon className="size-3.5 shrink-0 text-glass-cyan" />
          {prefix}
          {firing.target.name}
        </Link>
      )}
      <Link
        to={podLink(firing.pod, namespace)}
        className="font-mono text-xs break-all text-deep-teal hover:underline"
      >
        {prefix}
        {firing.pod.name}
      </Link>
    </span>
  );
}
