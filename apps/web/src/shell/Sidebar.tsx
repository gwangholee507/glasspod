// 왼쪽 메뉴입니다: 로고, namespace 고르기, 메뉴, 실시간 연결 상태(docs/guides/T18.md 결정 2, 3, 6, 19).
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { PodStreamStatus } from "../api/podStream.js";
import {
  ChevronDownIcon,
  HistoryIcon,
  IsolateIcon,
  ListIcon,
} from "../ui/icons.js";
import { formatDuration } from "../view/podText.js";
import { overviewLink } from "./shellContext.js";

const STATUS_TEXT: Record<PodStreamStatus, string> = {
  connecting: "연결하는 중입니다",
  open: "실시간 연결됨",
  reconnecting: "끊겨서 다시 연결하는 중입니다",
};

const STATUS_DOT: Record<PodStreamStatus, string> = {
  connecting: "bg-neutral-mark",
  open: "bg-glass-cyan",
  reconnecting: "bg-coral",
};

export function Sidebar({
  namespace,
  namespaces,
  onNamespaceChange,
  podCount,
  streamStatus,
  sinceUpdateMs,
}: {
  namespace: string | undefined;
  // 서버가 알려 준 namespace입니다. 아직 받지 못했으면 비어 있습니다.
  namespaces: readonly string[];
  onNamespaceChange: (namespace: string | undefined) => void;
  podCount: number | undefined;
  streamStatus: PodStreamStatus;
  sinceUpdateMs: number | undefined;
}) {
  // 주소에만 있는 이름(서버가 아직 모르는 namespace)도 고른 값으로 보여 줍니다.
  const options =
    namespace === undefined || namespaces.includes(namespace)
      ? namespaces
      : [...namespaces, namespace];

  return (
    <aside className="flex shrink-0 flex-col gap-5 border-b border-line bg-white px-4 py-5 lg:h-full lg:w-[232px] lg:border-r lg:border-b-0 lg:overflow-y-auto">
      <Link
        to={overviewLink(namespace)}
        className="flex items-center gap-2 self-start px-1"
      >
        <img src="/logo.svg" alt="" className="size-7" />
        <span className="font-brand text-[22px] font-medium text-deep-teal">
          glasspod
        </span>
      </Link>

      <label className="relative block rounded-lg border border-line bg-white px-3 py-2 focus-within:border-glass-cyan">
        <span className="block text-xs text-slate-500">namespace</span>
        <select
          value={namespace ?? ""}
          onChange={(event) =>
            onNamespaceChange(
              event.target.value === "" ? undefined : event.target.value,
            )
          }
          className="w-full cursor-pointer appearance-none bg-transparent pr-6 text-sm font-semibold text-slate-800 outline-none"
        >
          <option value="">모든 namespace</option>
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-3 bottom-2.5 size-4 text-slate-500" />
      </label>

      <nav aria-label="메뉴" className="flex flex-col gap-1 text-sm">
        <Link
          to={overviewLink(namespace)}
          aria-current="page"
          className="flex items-center gap-3 rounded-lg bg-mist px-3 py-2 font-semibold text-deep-teal"
        >
          <ListIcon />
          <span className="flex-1">Pod</span>
          {podCount !== undefined && (
            <span className="text-xs font-normal">{podCount}</span>
          )}
        </Link>
        <ComingSoon icon={<IsolateIcon />} label="격리된 Pod" />
        <ComingSoon icon={<HistoryIcon />} label="조치 기록" />
      </nav>

      <div
        role="status"
        className="space-y-1 px-1 text-xs text-slate-500 lg:mt-auto"
      >
        <p className="flex items-center gap-2 font-semibold text-deep-teal">
          <span
            className={`size-2 rounded-full ${STATUS_DOT[streamStatus]}`}
            aria-hidden="true"
          />
          {STATUS_TEXT[streamStatus]}
        </p>
        {sinceUpdateMs !== undefined && (
          <p>마지막 갱신 {formatDuration(sinceUpdateMs)} 전</p>
        )}
      </div>
    </aside>
  );
}

// 아직 없는 화면입니다. 흐리게 두고 누를 수 없습니다(결정 2).
function ComingSoon({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span
      aria-disabled="true"
      title="준비 중입니다"
      className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-slate-400"
    >
      {icon}
      <span className="flex-1">{label}</span>
      <span className="text-xs">준비 중</span>
    </span>
  );
}
