// 가운데 Pod 목록입니다: 찾기, 탭, 묶음, 항목(docs/guides/T18.md 결정 7~11, 14~16, 19, 20).
import type { PodItem, PodListBody, PodRef } from "@glasspod/protocol";
import { useState } from "react";
import { Link } from "react-router";
import type { PodStreamStatus } from "../api/podStream.js";
import { SearchIcon } from "../ui/icons.js";
import { StatusBadge, TONE_BAR, TONE_DOT } from "../ui/StatusBadge.js";
import {
  formatDuration,
  formatMegabytes,
  formatMs,
  podSentence,
  statusTone,
  timeLabel,
} from "../view/podText.js";
import { filterPods, groupPods, needsAttention } from "../view/podView.js";
import type { ListTab, PodGroup } from "../view/podView.js";
import { podLink } from "./shellContext.js";

const TABS: readonly { tab: ListTab; label: string }[] = [
  { tab: "all", label: "전체" },
  { tab: "problems", label: "문제" },
  { tab: "deployments", label: "Deployment별" },
];

export function PodListPane({
  list,
  streamStatus,
  sinceUpdateMs,
  now,
  namespace,
  selected,
}: {
  list: PodListBody | undefined;
  streamStatus: PodStreamStatus;
  sinceUpdateMs: number | undefined;
  now: number;
  namespace: string | undefined;
  selected: PodRef | undefined;
}) {
  const [tab, setTab] = useState<ListTab>("all");
  const [query, setQuery] = useState("");

  const pods = list?.pods ?? [];
  // 여러 namespace를 함께 볼 때만 항목과 묶음에 namespace를 붙입니다.
  const showNamespace =
    namespace === undefined &&
    new Set(pods.map((item) => item.pod.namespace)).size > 1;
  const groups = groupPods(filterPods(pods, query), tab, showNamespace);
  const counts: Record<ListTab, number | undefined> = {
    all: pods.length,
    problems: pods.filter(needsAttention).length,
    deployments: undefined,
  };

  return (
    <section
      aria-label="Pod 목록"
      className="flex shrink-0 flex-col border-b border-line bg-white lg:h-full lg:w-[400px] lg:border-r lg:border-b-0"
    >
      <div className="space-y-3 border-b border-line px-5 pt-5 pb-4">
        <h1 className="flex items-baseline gap-2 text-lg font-bold text-slate-900">
          Pod
          {list !== undefined && (
            <span className="text-xs font-normal text-slate-500">
              {pods.length}
            </span>
          )}
        </h1>
        <label className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 focus-within:border-glass-cyan">
          <SearchIcon className="size-4 shrink-0 text-slate-400" />
          <span className="sr-only">Pod 이름으로 찾기</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Pod 이름으로 찾기"
            className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
          />
        </label>
        <div
          role="group"
          aria-label="보기"
          className="grid grid-cols-3 gap-1 rounded-lg bg-tab p-1 text-[13px]"
        >
          {TABS.map((item) => (
            <button
              key={item.tab}
              type="button"
              aria-pressed={tab === item.tab}
              onClick={() => setTab(item.tab)}
              className={
                tab === item.tab
                  ? "rounded-md bg-white px-2 py-1.5 font-semibold text-deep-teal shadow-sm"
                  : "rounded-md px-2 py-1.5 text-slate-600 hover:text-deep-teal"
              }
            >
              {item.label}
              {list !== undefined && counts[item.tab] !== undefined && (
                <span className="ml-1">{counts[item.tab]}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {streamStatus === "reconnecting" && list !== undefined && (
        <p
          role="status"
          className="border-b border-warning-line bg-warning-wash px-5 py-2 text-xs text-warning-ink"
        >
          연결이 끊겨{" "}
          {sinceUpdateMs === undefined
            ? "마지막으로 받은"
            : `${formatDuration(sinceUpdateMs)} 전`}{" "}
          목록입니다. 다시 연결하는 중입니다.
        </p>
      )}

      <div className="flex-1 lg:overflow-y-auto">
        {list === undefined ? (
          <Empty>
            {streamStatus === "reconnecting"
              ? "서버에 닿지 못해 다시 연결하는 중입니다."
              : "서버에서 목록을 받는 중입니다."}
          </Empty>
        ) : pods.length === 0 ? (
          <Empty>판단한 Pod가 없습니다.</Empty>
        ) : groups.length === 0 ? (
          <Empty>
            {query.trim() !== ""
              ? `'${query.trim()}'와 맞는 Pod가 없습니다.`
              : "지금 볼 Pod가 없습니다."}
          </Empty>
        ) : (
          groups.map((group) => (
            <Group
              key={group.key}
              group={group}
              now={now}
              namespace={namespace}
              selected={selected}
              showNamespace={showNamespace}
            />
          ))
        )}
      </div>
    </section>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="px-5 py-6 text-sm text-slate-500">{children}</p>;
}

function Group({
  group,
  now,
  namespace,
  selected,
  showNamespace,
}: {
  group: PodGroup;
  now: number;
  namespace: string | undefined;
  selected: PodRef | undefined;
  showNamespace: boolean;
}) {
  return (
    <section aria-label={group.title}>
      <h2 className="flex items-center gap-2 border-b border-line px-5 pt-4 pb-2 text-xs text-slate-600">
        <span
          className={`size-2 rounded-full ${TONE_DOT[group.tone]}`}
          aria-hidden="true"
        />
        {group.title} · {group.pods.length}
      </h2>
      <ul>
        {group.pods.map((item) => (
          <li key={`${item.pod.namespace}/${item.pod.name}`}>
            <PodCard
              item={item}
              now={now}
              namespace={namespace}
              selected={
                selected !== undefined &&
                selected.namespace === item.pod.namespace &&
                selected.name === item.pod.name
              }
              showNamespace={showNamespace}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PodCard({
  item,
  now,
  namespace,
  selected,
  showNamespace,
}: {
  item: PodItem;
  now: number;
  namespace: string | undefined;
  selected: boolean;
  showNamespace: boolean;
}) {
  const tone = statusTone(item.status);
  const { metrics } = item;
  const errors = metrics.http5xxPerMinute;
  return (
    <Link
      to={podLink(item.pod, namespace)}
      aria-current={selected ? "page" : undefined}
      className={[
        "relative block border-b border-line px-5 py-3.5",
        item.severity === "critical"
          ? "bg-warning-wash"
          : "bg-white hover:bg-paper",
        selected ? "ring-2 ring-glass-cyan ring-inset" : "",
      ].join(" ")}
    >
      {item.severity !== "none" && (
        <span
          className={`absolute inset-y-0 left-0 w-1 ${TONE_BAR[tone]}`}
          aria-hidden="true"
        />
      )}
      <div className="flex items-center gap-2">
        <StatusBadge status={item.status} />
        {errors !== undefined && errors > 0 && (
          <span className="rounded border border-warning-line bg-warning-wash px-1.5 py-px text-xs font-medium whitespace-nowrap text-warning-ink">
            5xx {errors}/분
          </span>
        )}
        <span className="ml-auto text-xs whitespace-nowrap text-slate-500">
          {timeLabel(item, now)}
        </span>
      </div>
      <p className="mt-2 font-mono text-[13px] break-all text-slate-900">
        {showNamespace && (
          <span className="text-slate-400">{item.pod.namespace}/</span>
        )}
        {item.pod.name}
      </p>
      <p className="mt-1 text-[13px] text-slate-600">
        {podSentence(item, now)}
      </p>
      {item.sdk !== undefined && (
        <dl className="mt-2.5 grid grid-cols-3 gap-2">
          <Metric label="루프 p99" value={formatMs(metrics.eventLoopP99Ms)} />
          <Metric
            label="힙"
            value={formatMegabytes(metrics.heapUsedBytes)}
            title={
              metrics.heapLimitBytes === undefined
                ? undefined
                : `한도 ${formatMegabytes(metrics.heapLimitBytes)}`
            }
          />
          <Metric label="요청 p99" value={formatMs(metrics.httpP99Ms)} />
        </dl>
      )}
    </Link>
  );
}

function Metric({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string | undefined;
}) {
  return (
    <div
      title={title}
      className="rounded-md border border-line bg-white px-2 py-1.5"
    >
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="font-mono text-xs text-slate-800">{value}</dd>
    </div>
  );
}
