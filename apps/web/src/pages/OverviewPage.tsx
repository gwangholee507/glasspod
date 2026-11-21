// 오른쪽 자리, Pod를 고르기 전입니다: Deployment별 요약과 최근 30분 판단 변화(design.md 5.3, docs/guides/T18.md 결정 17, 18).
// 타임라인에는 조치도 섞습니다(docs/guides/T21.md 결정 21).
import type {
  ActionItem,
  PodStatusChange,
  StatusChangesBody,
} from "@glasspod/protocol";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ApiResult } from "../api/client.js";
import { getStatusChanges } from "../api/pods.js";
import { useActionHistory } from "../api/useActionHistory.js";
import { ResultBadge } from "../actions/ActionParts.js";
import { podLink, useShell } from "../shell/shellContext.js";
import { ChevronRightIcon, ClockIcon, HexagonIcon } from "../ui/icons.js";
import { StatusBadge, TONE_BAR, TONE_DOT } from "../ui/StatusBadge.js";
import {
  ACTION_LABEL,
  actionSentence,
  actionTone,
  actorLabel,
} from "../view/actionText.js";
import { changeSentence, formatClock, statusTone } from "../view/podText.js";
import {
  TIMELINE_LIMIT,
  mergeOverviewTimeline,
  summarizeDeployments,
} from "../view/podView.js";
import type { DeploymentSummary } from "../view/podView.js";

interface Fetched {
  namespace: string | undefined;
  result: ApiResult<StatusChangesBody>;
}

export function OverviewPage() {
  const { stream, namespace, now } = useShell();
  const list = stream.state?.list;
  const timeline = useStatusTimeline(namespace, stream.opens);
  const history = useActionHistory(
    namespace,
    stream.opens,
    stream.state?.actions ?? [],
  );

  const showNamespace =
    namespace === undefined &&
    new Set(list?.pods.map((item) => item.pod.namespace) ?? []).size > 1;
  const summaries =
    list === undefined ? [] : summarizeDeployments(list.deployments, list.pods);
  const { entries, truncated } = mergeOverviewTimeline(
    [
      timeline?.result.ok === true ? timeline.result.data.changes : [],
      stream.state?.statusChanges ?? [],
    ],
    history.actions,
    now,
  );

  return (
    <div className="space-y-6 px-6 py-8 lg:px-8">
      <header className="space-y-1">
        <h1 className="text-[22px] font-bold break-all text-slate-900">
          {namespace ?? "모든 namespace"} 한눈에 보기
        </h1>
        <p className="text-[13px] text-slate-500">
          목록에서 Pod를 고르면 이 자리에 상세가 열립니다.
        </p>
      </header>

      {list === undefined ? (
        <p className="text-sm text-slate-500">
          서버에서 목록을 받으면 Deployment 요약이 보입니다.
        </p>
      ) : summaries.length === 0 ? (
        <p className="text-sm text-slate-500">
          이 namespace에 Deployment와 Pod가 없습니다.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {summaries.map((summary) => (
            <DeploymentCard
              key={summary.key}
              summary={summary}
              showNamespace={showNamespace}
            />
          ))}
        </div>
      )}

      <section
        aria-labelledby="timeline-title"
        className="rounded-xl border border-line bg-white px-5 py-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="timeline-title"
            className="flex items-center gap-2 text-[17px] font-bold text-slate-900"
          >
            <ClockIcon className="size-4 text-glass-cyan" />
            최근 30분 판단 변화와 조치
          </h2>
          <span className="text-xs text-slate-500">
            판단이 바뀌거나 조치하면 한 줄
          </span>
        </div>
        {timeline !== undefined && !timeline.result.ok && (
          <p className="mt-3 text-xs text-warning-ink">
            지난 기록을 불러오지 못했습니다({timeline.result.error}). 이 화면을
            연 뒤의 변화만 보입니다.
          </p>
        )}
        {entries.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            {timeline === undefined
              ? "기록을 불러오는 중입니다."
              : "최근 30분 동안 판단이 바뀌지 않았고 조치도 없었습니다."}
          </p>
        ) : (
          <ol className="mt-4">
            {entries.map((entry) =>
              entry.kind === "action" ? (
                <ActionTimelineRow
                  key={`action/${entry.action.id}`}
                  action={entry.action}
                  namespace={namespace}
                  showNamespace={showNamespace}
                />
              ) : (
                <TimelineRow
                  key={`${entry.change.pod.namespace}/${entry.change.pod.name}/${entry.change.at}/${entry.change.status}`}
                  change={entry.change}
                  namespace={namespace}
                  showNamespace={showNamespace}
                />
              ),
            )}
          </ol>
        )}
        {truncated && (
          <p className="mt-2 text-xs text-slate-500">
            최근 {TIMELINE_LIMIT}건만 보입니다.
          </p>
        )}
      </section>
    </div>
  );
}

// 지난 30분 판단 변화를 부릅니다. 스트림이 목록 전체(pods)를 새로 받을 때마다(처음, 다시 붙음) 다시 불러 끊긴 동안의 변화를 채웁니다.
// 다시 부르는 동안에는 이전 결과를 그대로 둡니다. namespace가 바뀌면 이전 namespace의 결과는 쓰지 않습니다.
function useStatusTimeline(
  namespace: string | undefined,
  opens: number,
): Fetched | undefined {
  const [fetched, setFetched] = useState<Fetched | undefined>(undefined);

  useEffect(() => {
    if (opens === 0) {
      return;
    }
    const controller = new AbortController();
    void getStatusChanges(namespace, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setFetched({ namespace, result });
      }
    });
    return () => controller.abort();
  }, [namespace, opens]);

  return fetched?.namespace === namespace ? fetched : undefined;
}

function DeploymentCard({
  summary,
  showNamespace,
}: {
  summary: DeploymentSummary;
  showNamespace: boolean;
}) {
  return (
    <article className="rounded-xl border border-line bg-white px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold text-slate-900">
          <HexagonIcon className="size-4 shrink-0 text-glass-cyan" />
          <span className="break-all">{summary.name ?? "Deployment 없음"}</span>
        </h2>
        {summary.kube !== undefined && (
          <span className="text-xs whitespace-nowrap text-slate-500">
            쿠버네티스 {summary.kube.ready}/{summary.kube.desired} Ready
          </span>
        )}
      </div>
      {showNamespace && (
        <p className="mt-0.5 font-mono text-xs text-slate-500">
          {summary.namespace}
        </p>
      )}
      <div className="mt-3 flex h-1.5 gap-1" aria-hidden="true">
        {summary.segments.length === 0 ? (
          <span className="flex-1 rounded-full bg-line" />
        ) : (
          summary.segments.map((tone, index) => (
            <span
              key={index}
              className={`flex-1 rounded-full ${TONE_BAR[tone]}`}
            />
          ))
        )}
      </div>
      <p className="mt-3 text-[13px] text-slate-600">
        {summary.counts.length === 0
          ? "Pod가 없습니다"
          : summary.counts
              .map((count) => `${count.label} ${count.count}`)
              .join(" · ")}
      </p>
    </article>
  );
}

function TimelineRow({
  change,
  namespace,
  showNamespace,
}: {
  change: PodStatusChange;
  namespace: string | undefined;
  showNamespace: boolean;
}) {
  return (
    <li className="group grid grid-cols-[4.25rem_0.75rem_minmax(0,1fr)] gap-x-3">
      <time
        dateTime={new Date(change.at).toISOString()}
        className="pt-0.5 font-mono text-xs text-slate-500"
      >
        {formatClock(change.at)}
      </time>
      <div className="relative flex justify-center">
        <span
          className={`relative z-10 mt-1.5 size-2.5 rounded-full ${TONE_DOT[statusTone(change.status)]}`}
          aria-hidden="true"
        />
        <span
          className="absolute top-4 -bottom-1.5 w-px bg-line group-last:hidden"
          aria-hidden="true"
        />
      </div>
      <div className="pb-5 group-last:pb-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={podLink(change.pod, namespace)}
            className="font-mono text-xs break-all text-deep-teal hover:underline"
          >
            {showNamespace ? `${change.pod.namespace}/` : ""}
            {change.pod.name}
          </Link>
          {change.previous !== undefined && (
            <>
              <StatusBadge status={change.previous} />
              <ChevronRightIcon className="size-3.5 text-slate-400" />
            </>
          )}
          <StatusBadge status={change.status} />
        </div>
        <p className="mt-1.5 text-[13px] text-slate-700">
          {changeSentence(change)}
        </p>
      </div>
    </li>
  );
}

// 조치 한 줄입니다(docs/guides/T21.md 결정 21). 판단 변화 줄과 같은 칸에 대상, 조치, 결과를 둡니다.
function ActionTimelineRow({
  action,
  namespace,
  showNamespace,
}: {
  action: ActionItem;
  namespace: string | undefined;
  showNamespace: boolean;
}) {
  return (
    <li className="group grid grid-cols-[4.25rem_0.75rem_minmax(0,1fr)] gap-x-3">
      <time
        dateTime={new Date(action.requestedAt).toISOString()}
        className="pt-0.5 font-mono text-xs text-slate-500"
      >
        {formatClock(action.requestedAt)}
      </time>
      <div className="relative flex justify-center">
        <span
          className={`relative z-10 mt-1.5 size-2.5 rounded-full ${TONE_DOT[actionTone(action)]}`}
          aria-hidden="true"
        />
        <span
          className="absolute top-4 -bottom-1.5 w-px bg-line group-last:hidden"
          aria-hidden="true"
        />
      </div>
      <div className="pb-5 group-last:pb-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={podLink(action.target, namespace)}
            className="font-mono text-xs break-all text-deep-teal hover:underline"
          >
            {showNamespace ? `${action.target.namespace}/` : ""}
            {action.target.name}
          </Link>
          <span className="text-[13px] font-semibold text-slate-800">
            {ACTION_LABEL[action.action]} · {actorLabel(action.actor)}
          </span>
          <ResultBadge item={action} />
        </div>
        <p
          className={`mt-1.5 text-[13px] ${
            action.result === "failed" ? "text-warning-ink" : "text-slate-700"
          }`}
        >
          {actionSentence(action)}
        </p>
      </div>
    </li>
  );
}
