// 상세 맨 아래의 조치 기록 칸입니다(docs/guides/T21.md 결정 20). 이 Pod의 조치를 늦은 것부터 보여 줍니다.
import type { ActionItem } from "@glasspod/protocol";
import { Link } from "react-router";
import { ActionName, ResultBadge } from "../actions/ActionParts.js";
import { actionsLink } from "../shell/shellContext.js";
import { HistoryIcon } from "../ui/icons.js";
import {
  actionSentence,
  actorLabel,
  formatActionTime,
} from "../view/actionText.js";

export function ActionHistory({
  actions,
  now,
  filter,
}: {
  // 늦은 것부터입니다.
  actions: readonly ActionItem[];
  now: number;
  filter: string | undefined;
}) {
  return (
    <section
      aria-labelledby="action-history-title"
      className="rounded-xl border border-line bg-white px-5 py-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="action-history-title"
          className="flex items-center gap-2 text-[15px] font-bold text-slate-900"
        >
          <HistoryIcon className="size-4 text-glass-cyan" />
          조치 기록
        </h2>
        <Link
          to={actionsLink(filter)}
          className="text-xs text-deep-teal hover:underline"
        >
          조치 기록 전체 보기
        </Link>
      </div>
      {actions.length === 0 ? (
        <p className="mt-2 text-[13px] text-slate-400">
          이 Pod에 한 조치가 없습니다.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {actions.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]"
            >
              <time
                dateTime={new Date(item.requestedAt).toISOString()}
                className="font-mono text-xs text-slate-500"
              >
                {formatActionTime(item.requestedAt, now)}
              </time>
              <ActionName action={item.action} />
              <ResultBadge item={item} />
              <span className="text-xs text-slate-500">
                {actorLabel(item.actor)}
              </span>
              <span
                className={`w-full break-words sm:w-auto sm:flex-1 ${
                  item.result === "failed"
                    ? "text-warning-ink"
                    : "text-slate-700"
                }`}
              >
                {actionSentence(item)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
