// 상세 머리줄입니다(docs/guides/T19.md 결정 4, 10): 상태 배지, Pod 이름, 조치 버튼, 판단 문장과 Pod 정보.
// '재시작'은 서랍을 엽니다(docs/guides/T21.md 결정 18). '트래픽에서 빼기'는 T23까지 흐리게 둡니다.
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
  restartBlocked,
  onRestart,
}: {
  pod: PodRef;
  item: PodItem | undefined;
  now: number;
  // 목록에서 고른 namespace(주소의 ?namespace=)입니다.
  filter: string | undefined;
  // 재시작을 누를 수 없는 이유입니다. 누를 수 있으면 undefined입니다.
  restartBlocked: string | undefined;
  onRestart: () => void;
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
        <div className="flex shrink-0 gap-2">
          <ActionButton
            icon={<IsolateIcon className="size-4" />}
            blocked="준비 중입니다"
          >
            트래픽에서 빼기
          </ActionButton>
          <ActionButton
            icon={<RotateIcon className="size-4" />}
            danger
            blocked={restartBlocked}
            onClick={onRestart}
          >
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

// 누를 수 없으면(blocked) 흐리게 두고 마우스를 올리면 이유를 보입니다.
function ActionButton({
  icon,
  danger = false,
  blocked,
  onClick,
  children,
}: {
  icon: ReactNode;
  danger?: boolean;
  blocked: string | undefined;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={blocked !== undefined}
      title={blocked}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45 ${
        danger
          ? "border-warning-line text-warning-ink hover:bg-warning-wash"
          : "border-line text-deep-teal hover:bg-mist"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
