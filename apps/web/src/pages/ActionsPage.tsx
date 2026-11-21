// 조치 기록 화면입니다(design.md 5.3 '조치 기록', Figma 확정-5, docs/guides/T21.md 결정 19).
// 가운데 Pod 목록 칸 없이 넓게 씁니다. namespace는 왼쪽 메뉴가 고르고, 여기서는 조치·결과·대상 이름으로 거릅니다.
import type { ActionKind, ActionResult } from "@glasspod/protocol";
import { useState } from "react";
import { Link } from "react-router";
import { ActionName, ResultBadge } from "../actions/ActionParts.js";
import { useActionHistory } from "../api/useActionHistory.js";
import { podLink, useShell } from "../shell/shellContext.js";
import { ChevronDownIcon, InfoIcon, SearchIcon } from "../ui/icons.js";
import {
  ACTION_KINDS,
  ACTION_LABEL,
  NO_ACTION_FILTER,
  RESULT_LABEL,
  actionSentence,
  actorLabel,
  filterActions,
  formatActionTime,
} from "../view/actionText.js";
import type { ActionFilter } from "../view/actionText.js";

const RESULTS: readonly ActionResult[] = ["succeeded", "failed"];

export function ActionsPage() {
  const { stream, namespace, now } = useShell();
  const history = useActionHistory(
    namespace,
    stream.opens,
    stream.state?.actions ?? [],
  );
  const [filter, setFilter] = useState<ActionFilter>(NO_ACTION_FILTER);
  const rows = filterActions(history.actions, filter);
  const showNamespace =
    namespace === undefined &&
    new Set(history.actions.map((item) => item.target.namespace)).size > 1;

  return (
    <div className="space-y-5 px-6 py-8 lg:px-8">
      <header className="space-y-1">
        <h1 className="text-[22px] font-bold text-slate-900">조치 기록</h1>
        <p className="text-[13px] text-slate-500">
          Glasspod에서 실행한 조치를 모두 남깁니다. 수동이든 자동 규칙이든 실행
          주체, 시각, 대상, 결과를 기록합니다.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="조치"
          value={filter.action}
          options={[
            ["all", "전체"],
            ...ACTION_KINDS.map(
              (kind) => [kind, ACTION_LABEL[kind]] as [string, string],
            ),
          ]}
          onChange={(value) =>
            setFilter({ ...filter, action: value as ActionKind | "all" })
          }
        />
        <FilterSelect
          label="결과"
          value={filter.result}
          options={[
            ["all", "전체"],
            ...RESULTS.map(
              (result) => [result, RESULT_LABEL[result]] as [string, string],
            ),
          ]}
          onChange={(value) =>
            setFilter({ ...filter, result: value as ActionResult | "all" })
          }
        />
        <label className="relative ml-auto w-full sm:w-64">
          <span className="sr-only">대상 이름으로 찾기</span>
          <SearchIcon className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
          <input
            type="search"
            value={filter.query}
            onChange={(event) =>
              setFilter({ ...filter, query: event.target.value })
            }
            placeholder="대상 이름으로 찾기"
            className="w-full rounded-lg border border-line bg-white py-2 pr-3 pl-9 text-sm outline-none focus:border-glass-cyan"
          />
        </label>
      </div>

      {history.error !== undefined && (
        <p className="text-xs text-warning-ink">
          지난 기록을 불러오지 못했습니다({history.error}). 이 화면을 연 뒤의
          조치만 보입니다.
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-white">
        <table className="w-full min-w-[760px] text-left text-[13px]">
          <thead className="bg-tab text-xs text-slate-500">
            <tr>
              <th className="px-5 py-3 font-medium">시각</th>
              <th className="px-3 py-3 font-medium">조치</th>
              <th className="px-3 py-3 font-medium">대상</th>
              <th className="px-3 py-3 font-medium">실행</th>
              <th className="px-3 py-3 font-medium">결과</th>
              <th className="px-3 py-3 pr-5 font-medium">내용</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-6 text-sm text-slate-500">
                  {history.loading
                    ? "기록을 불러오는 중입니다."
                    : history.actions.length === 0
                      ? "아직 실행한 조치가 없습니다."
                      : "거른 조건에 맞는 조치가 없습니다."}
                </td>
              </tr>
            ) : (
              rows.map((item) => (
                <tr key={item.id} className="align-top">
                  <td className="px-5 py-3.5 font-mono text-xs whitespace-nowrap text-slate-600">
                    <time dateTime={new Date(item.requestedAt).toISOString()}>
                      {formatActionTime(item.requestedAt, now)}
                    </time>
                  </td>
                  <td className="px-3 py-3">
                    <ActionName action={item.action} />
                  </td>
                  <td className="px-3 py-3.5">
                    <Link
                      to={podLink(item.target, namespace)}
                      className="font-mono text-xs break-all text-deep-teal hover:underline"
                    >
                      {showNamespace ? `${item.target.namespace}/` : ""}
                      {item.target.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap text-slate-700">
                    {actorLabel(item.actor)}
                  </td>
                  <td className="px-3 py-3">
                    <ResultBadge item={item} />
                  </td>
                  <td
                    className={`px-3 py-3 pr-5 break-words ${
                      item.result === "failed"
                        ? "text-warning-ink"
                        : "text-slate-700"
                    }`}
                  >
                    {actionSentence(item)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-1 text-xs text-slate-500">
        <p className="flex items-center gap-1.5">
          <InfoIcon className="size-4 shrink-0" />
          자동 규칙(확장 기능)이 실행한 조치는 '실행' 칸에 규칙 이름이
          들어갑니다.
        </p>
        <p className="pl-[22px]">
          서버가 켜져 있는 동안 최근 1,000건을 남깁니다. 서버를 다시 시작하면
          사라집니다.
        </p>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative inline-flex items-center gap-2 rounded-lg border border-line bg-white py-1.5 pr-8 pl-3 text-sm focus-within:border-glass-cyan">
      <span className="text-xs text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="cursor-pointer appearance-none bg-transparent font-semibold text-slate-800 outline-none"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 size-4 text-slate-500" />
    </label>
  );
}
