// 조치 기록 화면, 상세의 조치 기록 칸, 서랍이 함께 쓰는 작은 조각입니다(docs/guides/T21.md 결정 17, 19, 20).
import type { ActionItem, ActionKind } from "@glasspod/protocol";
import { IsolateIcon, RotateIcon, TrashIcon } from "../ui/icons.js";
import { StatusBadge } from "../ui/StatusBadge.js";
import { ACTION_LABEL, RESULT_LABEL } from "../view/actionText.js";
import type { RestartImpact } from "../view/actionText.js";
import type { Tone } from "../view/podText.js";

const NOTE_TEXT: Record<Tone, string> = {
  critical: "text-warning-ink",
  warning: "text-warning-ink",
  ok: "text-slate-500",
  neutral: "text-slate-500",
};

// 조치 아이콘입니다. 크기와 색은 className으로 정합니다.
export function ActionIcon({
  action,
  className,
}: {
  action: ActionKind;
  className?: string;
}) {
  switch (action) {
    case "restart-pod":
      return <RotateIcon className={className ?? "size-4"} />;
    case "isolate-pod":
      return <IsolateIcon className={className ?? "size-4"} />;
    case "delete-pod":
      return <TrashIcon className={className ?? "size-4"} />;
  }
}

// 조치 아이콘과 이름입니다.
export function ActionName({ action }: { action: ActionKind }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-slate-800">
      <ActionIcon action={action} className="size-4 text-deep-teal" />
      {ACTION_LABEL[action]}
    </span>
  );
}

// 결과 배지입니다. 성공은 정상 색, 실패는 위험 색(design.md 12장)입니다.
export function ResultBadge({ item }: { item: ActionItem }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${
        item.result === "succeeded"
          ? "bg-mist text-deep-teal"
          : "bg-coral text-critical-ink"
      }`}
    >
      {RESULT_LABEL[item.result]}
    </span>
  );
}

// 재시작·트래픽에서 빼기 서랍의 영향 칸입니다. 같은 Deployment의 다른 Pod와 새 Pod 줄입니다.
export function ImpactList({ impact }: { impact: RestartImpact | undefined }) {
  if (
    impact === undefined ||
    (impact.others.length === 0 && impact.replicaSet === undefined)
  ) {
    return (
      <p className="text-[13px] text-slate-500">
        같은 Deployment에 다른 Pod가 없습니다.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {impact.others.map((row) => (
        <li
          key={row.pod.name}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
        >
          <StatusBadge status={row.status} />
          <span className="min-w-0 flex-1 font-mono text-[13px] break-all text-slate-800">
            {row.pod.name}
          </span>
          <span className={`text-xs ${NOTE_TEXT[row.tone]}`}>{row.note}</span>
        </li>
      ))}
      {impact.replicaSet !== undefined && (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <StatusBadge status="starting" />
          <span className="min-w-0 flex-1 text-[13px] text-slate-800">
            새 Pod
          </span>
          <span className="text-xs text-slate-500">ReplicaSet이 만듭니다</span>
        </li>
      )}
    </ul>
  );
}
