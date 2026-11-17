// 상태 배지와 강조 색입니다(design.md 12장 '상태 배지와 강조 색', docs/guides/T18.md '색').
import type { PodStatus } from "@glasspod/protocol";
import { STATUS_LABEL, statusTone } from "../view/podText.js";
import type { Tone } from "../view/podText.js";

// 배지의 면·글자입니다. 코랄 위에는 흰 글자를 쓰지 않습니다(대비가 낮음).
const BADGE: Record<Tone, string> = {
  critical: "bg-coral text-critical-ink",
  warning:
    "bg-warning-wash text-warning-ink ring-1 ring-inset ring-warning-line",
  ok: "bg-mist text-deep-teal",
  neutral: "bg-neutral-wash text-neutral-ink",
};

// 묶음 이름 앞, 타임라인의 점입니다.
export const TONE_DOT: Record<Tone, string> = {
  critical: "bg-coral",
  warning: "bg-warning-ink",
  ok: "bg-glass-cyan",
  neutral: "bg-neutral-mark",
};

// Deployment 요약 막대와 목록 항목 왼쪽 띠입니다.
export const TONE_BAR: Record<Tone, string> = {
  critical: "bg-coral",
  warning: "bg-warning-line",
  ok: "bg-glass-cyan",
  neutral: "bg-neutral-mark",
};

export function StatusBadge({ status }: { status: PodStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${BADGE[statusTone(status)]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}
