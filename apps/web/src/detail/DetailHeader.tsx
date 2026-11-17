// 상세 머리줄입니다(docs/guides/T19.md 결정 4, 10): 상태 배지, Pod 이름, 조치 버튼 자리, 판단 문장과 Pod 정보.
import type { PodItem, PodRef } from "@glasspod/protocol";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { overviewLink } from "../shell/shellContext.js";
import { ChevronLeftIcon, IsolateIcon, RotateIcon } from "../ui/icons.js";
import { StatusBadge } from "../ui/StatusBadge.js";
import { podFacts } from "../view/detailView.js";
import { formatDuration, podSentence } from "../view/podText.js";

export function DetailHeader({
  pod,
  item,
  now,
  filter,
}: {
  pod: PodRef;
  item: PodItem | undefined;
  now: number;
  // 목록에서 고른 namespace(주소의 ?namespace=)입니다.
  filter: string | undefined;
}) {
  const facts =
    item === undefined
      ? []
      : [podSentence(item, now), ...podFacts(item, now, formatDuration)];
  return (
    <header className="space-y-2">
      <Link
        to={overviewLink(filter)}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-deep-teal"
      >
        <ChevronLeftIcon className="size-4" />
        한눈에 보기로
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {item !== undefined && <StatusBadge status={item.status} />}
          <h1 className="font-mono text-xl font-semibold break-all text-slate-900">
            {pod.name}
          </h1>
        </div>
        {/* 조치는 T21~T23에서 만듭니다. 그때까지 흐리게 둡니다(결정 4). */}
        <div className="flex shrink-0 gap-2">
          <ActionButton icon={<IsolateIcon className="size-4" />}>
            트래픽에서 빼기
          </ActionButton>
          <ActionButton icon={<RotateIcon className="size-4" />} danger>
            재시작
          </ActionButton>
        </div>
      </div>
      <p className="text-[13px] text-slate-600">
        <span className="font-mono text-slate-500">{pod.namespace}</span>
        {facts.map((fact, index) => (
          <span key={index}> · {fact}</span>
        ))}
      </p>
    </header>
  );
}

function ActionButton({
  icon,
  danger = false,
  children,
}: {
  icon: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled
      title="준비 중입니다"
      className={`inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-sm font-medium opacity-45 ${
        danger
          ? "border-warning-line text-warning-ink"
          : "border-line text-deep-teal"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
