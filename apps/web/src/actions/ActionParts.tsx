// 조치 기록 화면, 상세의 조치 기록 칸, 서랍이 함께 쓰는 작은 조각입니다(docs/guides/T21.md 결정 17, 19, 20).
import type { ActionItem, ActionKind, PodStatus } from "@glasspod/protocol";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { overviewLink, podLink } from "../shell/shellContext.js";
import {
  HexagonIcon,
  IsolateIcon,
  RotateIcon,
  ScaleIcon,
  TrashIcon,
} from "../ui/icons.js";
import { StatusBadge } from "../ui/StatusBadge.js";
import { ACTION_LABEL, RESULT_LABEL } from "../view/actionText.js";
import type { ImpactRow, RestartImpact } from "../view/actionText.js";
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
    case "scale-deployment":
      return <ScaleIcon className={className ?? "size-4"} />;
  }
}

// 조치 기록·타임라인의 대상 칸입니다. Pod는 상세로, Deployment(스케일 조정)는 육각형 아이콘과 함께
// 한눈에 보기로 잇습니다(docs/guides/T24.md 결정 14). namespace는 목록에서 고른 namespace입니다.
export function ActionTargetLink({
  item,
  namespace,
  showNamespace,
}: {
  item: ActionItem;
  namespace: string | undefined;
  showNamespace: boolean;
}) {
  const prefix = showNamespace ? `${item.target.namespace}/` : "";
  if (item.target.kind === "deployment") {
    return (
      <Link
        to={overviewLink(namespace)}
        className="inline-flex items-center gap-1 font-mono text-xs whitespace-nowrap text-deep-teal hover:underline"
      >
        <HexagonIcon className="size-3.5 shrink-0 text-glass-cyan" />
        {prefix}
        {item.target.name}
      </Link>
    );
  }
  return (
    <Link
      to={podLink(item.target, namespace)}
      className="font-mono text-xs break-all text-deep-teal hover:underline"
    >
      {prefix}
      {item.target.name}
    </Link>
  );
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

// 영향 칸 맨 아래의 줄입니다(새 Pod, 지울 Pod).
export interface ImpactExtra {
  status: PodStatus;
  label: string;
  note: string;
}

// 영향 칸의 Pod 줄입니다. 재시작·트래픽에서 빼기·스케일 조정 서랍이 함께 씁니다.
export function ImpactRows({
  rows,
  extra,
  empty,
}: {
  rows: readonly ImpactRow[];
  extra?: ImpactExtra | undefined;
  // 줄이 하나도 없을 때의 문장입니다.
  empty: ReactNode;
}) {
  if (rows.length === 0 && extra === undefined) {
    return <p className="text-[13px] text-slate-500">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {rows.map((row) => (
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
      {extra !== undefined && (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <StatusBadge status={extra.status} />
          <span className="min-w-0 flex-1 text-[13px] text-slate-800">
            {extra.label}
          </span>
          <span className="text-xs text-slate-500">{extra.note}</span>
        </li>
      )}
    </ul>
  );
}

// 재시작·트래픽에서 빼기 서랍의 영향 칸입니다. 같은 Deployment의 다른 Pod와 새 Pod 줄입니다.
export function ImpactList({ impact }: { impact: RestartImpact | undefined }) {
  return (
    <ImpactRows
      rows={impact?.others ?? []}
      extra={
        impact?.replicaSet === undefined
          ? undefined
          : {
              status: "starting",
              label: "새 Pod",
              note: "ReplicaSet이 만듭니다",
            }
      }
      empty="같은 Deployment에 다른 Pod가 없습니다."
    />
  );
}
