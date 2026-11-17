// '무슨 일이 있었나'입니다(design.md 5.3, docs/guides/T19.md 결정 12~14).
// SDK event, 쿠버네티스 이벤트, SDK 연결, 판단 변화, 재시작을 늦은 것부터 한 줄씩 보여 줍니다.
import type { PodDetailBody, PodItem } from "@glasspod/protocol";
import { ChevronRightIcon, ClockIcon } from "../ui/icons.js";
import { StatusBadge, TONE_DOT } from "../ui/StatusBadge.js";
import { WHAT_HAPPENED_LIMIT, whatHappened } from "../view/detailView.js";
import type { TimelineRow } from "../view/detailView.js";
import { formatClock } from "../view/podText.js";
import type { Tone } from "../view/podText.js";

// 줄 앞 작은 글의 색입니다. error·warn만 강조합니다.
const LABEL_TEXT: Record<Tone, string> = {
  critical: "text-warning-ink",
  warning: "text-warning-ink",
  ok: "text-slate-500",
  neutral: "text-slate-500",
};

export function WhatHappened({
  detail,
  item,
}: {
  detail: PodDetailBody;
  item: PodItem;
}) {
  const { rows, truncated } = whatHappened(detail, item);
  return (
    <section
      aria-labelledby="what-happened-title"
      className="rounded-xl border border-line bg-white px-5 py-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="what-happened-title"
          className="flex items-center gap-2 text-[17px] font-bold text-slate-900"
        >
          <ClockIcon className="size-4 text-glass-cyan" />
          무슨 일이 있었나
        </h2>
        <span className="text-xs text-slate-500">
          {detail.restartCauses.length > 0
            ? "재시작 직전 event는 원인 후보로 표시합니다"
            : "최근 30분"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          최근 30분 동안 기록된 일이 없습니다.
        </p>
      ) : (
        <ol className="mt-4">
          {rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </ol>
      )}
      {truncated && (
        <p className="mt-2 text-xs text-slate-500">
          최근 {WHAT_HAPPENED_LIMIT}줄만 보입니다.
        </p>
      )}
    </section>
  );
}

function Row({ row }: { row: TimelineRow }) {
  return (
    <li className="group grid grid-cols-[4.25rem_0.75rem_minmax(0,1fr)] gap-x-3">
      <time
        dateTime={new Date(row.at).toISOString()}
        className="pt-0.5 font-mono text-xs text-slate-500"
      >
        {formatClock(row.at)}
      </time>
      <div className="relative flex justify-center">
        <span
          className={`relative z-10 mt-1.5 size-2.5 rounded-full ${TONE_DOT[row.tone]}`}
          aria-hidden="true"
        />
        <span
          className="absolute top-4 -bottom-1.5 w-px bg-line group-last:hidden"
          aria-hidden="true"
        />
      </div>
      <div className="min-w-0 pb-4 group-last:pb-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`font-mono text-xs ${LABEL_TEXT[row.tone]}`}>
            {row.label}
          </span>
          {row.status !== undefined && (
            <>
              {row.status.previous !== undefined && (
                <>
                  <StatusBadge status={row.status.previous} />
                  <ChevronRightIcon className="size-3.5 text-slate-400" />
                </>
              )}
              <StatusBadge status={row.status.next} />
            </>
          )}
          <span className="text-[13px] font-semibold break-words text-slate-800">
            {row.title}
          </span>
          {row.cause !== undefined && (
            <span className="rounded-md bg-warning-wash px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-warning-ink">
              후보 {row.cause}
            </span>
          )}
        </div>
        {row.detail !== undefined && (
          <p className="mt-0.5 text-xs break-words text-slate-500">
            {row.detail}
          </p>
        )}
      </div>
    </li>
  );
}
