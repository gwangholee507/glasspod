// 자동 규칙 화면입니다(design.md 5.5, docs/guides/T28.md 결정 2, 24).
// 가운데 Pod 목록 칸 없이 넓게 씁니다. 규칙은 ConfigMap(deploy/server/rules.yaml)에서 바꾸고, 여기서는 보여 주기만 합니다(D5).
// 위에서부터 규칙 파일 상태, 규칙마다 카드(조건·조치·지금 상태), 기록 표입니다.
import type { RuleFiring, RuleItem, RulesView } from "@glasspod/protocol";
import { useState } from "react";
import { Link } from "react-router";
import { useRuleHistory } from "../api/useRuleHistory.js";
import { ActionName } from "../actions/ActionParts.js";
import {
  FiringTargetLink,
  ModeBadge,
  OutcomeBadge,
} from "../rules/RuleParts.js";
import { podLink, useShell } from "../shell/shellContext.js";
import {
  AlertIcon,
  ChevronDownIcon,
  HexagonIcon,
  InfoIcon,
} from "../ui/icons.js";
import { formatActionTime } from "../view/actionText.js";
import { formatDuration } from "../view/podText.js";
import {
  OUTCOME_LABEL,
  conditionText,
  firingConditionsText,
  firingSentence,
  matchText,
  noteSentence,
  ruleActionText,
  ruleLimitsText,
  ruleStateText,
} from "../view/ruleText.js";

// 기록 표에 그리는 줄 수입니다. 서버는 1,000건까지 남깁니다.
const FIRING_ROWS = 200;

type OutcomeFilter = RuleFiring["outcome"] | "all";

export function RulesPage() {
  const { stream, namespace, now } = useShell();
  const history = useRuleHistory(namespace, stream.opens, stream.state);
  const [rule, setRule] = useState<string>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const view = history.view;
  const rules = view?.rules ?? [];
  const showNamespace =
    namespace === undefined &&
    new Set(rules.map((item) => item.target.namespace)).size > 1;
  const names = [
    ...new Set([
      ...rules.map((item) => item.name),
      ...history.firings.map((firing) => firing.rule),
    ]),
  ];
  const firings = history.firings.filter(
    (firing) =>
      (rule === "all" || firing.rule === rule) &&
      (outcome === "all" || firing.outcome === outcome),
  );

  return (
    <div className="space-y-5 px-6 py-8 lg:px-8">
      <header className="space-y-1">
        <h1 className="text-[22px] font-bold text-slate-900">자동 규칙</h1>
        <p className="text-[13px] text-slate-500">
          조건이 모두 정해진 시간만큼 이어지면 조치합니다. '알림만' 규칙은
          실행하지 않고 실행했을 것만 남깁니다. 판단이 맞는 것을 본 뒤
          '자동'으로 바꿉니다.
        </p>
      </header>

      {history.error !== undefined && (
        <p className="text-xs text-warning-ink">
          규칙을 불러오지 못했습니다({history.error}). 이 화면을 연 뒤의 기록만
          보입니다.
        </p>
      )}

      <FileState view={view} loading={history.loading} now={now} />

      {view !== undefined && rules.length === 0 && (
        <p className="text-sm text-slate-500">
          {namespace === undefined
            ? "규칙이 없습니다."
            : `${namespace}를 대상으로 한 규칙이 없습니다.`}
        </p>
      )}

      {rules.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-2">
          {rules.map((item) => (
            <RuleCard
              key={item.name}
              rule={item}
              now={now}
              namespace={namespace}
              showNamespace={showNamespace}
            />
          ))}
        </div>
      )}

      <section aria-labelledby="firings-title" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id="firings-title"
            className="mr-auto text-[17px] font-bold text-slate-900"
          >
            기록
          </h2>
          <FilterSelect
            label="규칙"
            value={rule}
            options={[
              ["all", "전체"],
              ...names.map((name) => [name, name] as [string, string]),
            ]}
            onChange={setRule}
          />
          <FilterSelect
            label="결과"
            value={outcome}
            options={[
              ["all", "전체"],
              ["notified", OUTCOME_LABEL.notified],
              ["executed", OUTCOME_LABEL.executed],
              ["skipped", OUTCOME_LABEL.skipped],
            ]}
            onChange={(value) => setOutcome(value as OutcomeFilter)}
          />
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead className="bg-tab text-xs text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">시각</th>
                <th className="px-3 py-3 font-medium">규칙</th>
                <th className="px-3 py-3 font-medium">조치</th>
                <th className="px-3 py-3 font-medium">대상</th>
                <th className="px-3 py-3 font-medium">결과</th>
                <th className="px-3 py-3 pr-5 font-medium">내용</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {firings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-6 text-sm text-slate-500">
                    {history.loading
                      ? "기록을 불러오는 중입니다."
                      : history.firings.length === 0
                        ? "아직 발동한 규칙이 없습니다."
                        : "거른 조건에 맞는 기록이 없습니다."}
                  </td>
                </tr>
              ) : (
                firings.slice(0, FIRING_ROWS).map((firing) => (
                  <tr key={firing.id} className="align-top">
                    <td className="px-5 py-3.5 font-mono text-xs whitespace-nowrap text-slate-600">
                      <time dateTime={new Date(firing.at).toISOString()}>
                        {formatActionTime(firing.at, now)}
                      </time>
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs text-slate-800">
                          {firing.rule}
                        </span>
                        <ModeBadge mode={firing.mode} />
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <ActionName action={firing.action} />
                    </td>
                    <td className="px-3 py-3.5">
                      <FiringTargetLink
                        firing={firing}
                        namespace={namespace}
                        showNamespace={showNamespace}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <OutcomeBadge firing={firing} />
                    </td>
                    <td className="px-3 py-3 pr-5 break-words">
                      <p
                        className={
                          firing.outcome === "skipped" ||
                          firing.actionResult === "failed"
                            ? "text-warning-ink"
                            : "text-slate-700"
                        }
                      >
                        {firingSentence(firing)}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        조건: {firingConditionsText(firing)}
                      </p>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {firings.length > FIRING_ROWS && (
          <p className="text-xs text-slate-500">
            최근 {FIRING_ROWS}건만 보입니다.
          </p>
        )}
        <div className="space-y-1 text-xs text-slate-500">
          <p className="flex items-center gap-1.5">
            <InfoIcon className="size-4 shrink-0" />
            규칙은 ConfigMap glasspod-rules(deploy/server/rules.yaml)을 고쳐
            kubectl apply로 바꿉니다. 서버가 파일을 다시 읽기까지 1분쯤 걸릴 수
            있습니다.
          </p>
          <p className="pl-[22px]">
            자동으로 실행한 조치는 조치 기록에도 실행 주체가 규칙 이름으로
            남습니다. 기록은 서버가 켜져 있는 동안 최근 1,000건을 남깁니다.
          </p>
        </div>
      </section>
    </div>
  );
}

// 규칙 파일 상태입니다(결정 1, 9). 틀린 파일이면 이전 규칙을 그대로 쓴다는 것을 알립니다.
function FileState({
  view,
  loading,
  now,
}: {
  view: RulesView | undefined;
  loading: boolean;
  now: number;
}) {
  if (view === undefined) {
    return loading ? (
      <p className="text-sm text-slate-500">규칙을 불러오는 중입니다.</p>
    ) : null;
  }
  const { file } = view;
  if (file.path === undefined) {
    return (
      <p className="rounded-xl border border-line bg-white px-5 py-4 text-sm text-slate-600">
        규칙이 꺼져 있습니다. 서버에 GLASSPOD_RULES_FILE이 없습니다.
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-line bg-white px-5 py-4 text-[13px]">
      <p className="text-slate-700">
        규칙 파일 <span className="font-mono text-xs">{file.path}</span>
        {file.loadedAt === undefined
          ? " · 받아들인 규칙이 없습니다"
          : ` · 규칙 ${view.rules.length}개 · ${formatDuration(now - file.loadedAt)} 전에 받아들임`}
      </p>
      {file.error !== undefined && (
        <p className="flex items-start gap-1.5 text-warning-ink">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            {file.loadedAt === undefined
              ? "규칙 파일을 읽지 못해 규칙이 없습니다"
              : "규칙 파일이 틀려 이전 규칙을 그대로 씁니다"}
            ({formatDuration(now - file.error.at)} 전):{" "}
            <span className="font-mono text-xs break-all">
              {file.error.detail}
            </span>
          </span>
        </p>
      )}
    </div>
  );
}

function RuleCard({
  rule,
  now,
  namespace,
  showNamespace,
}: {
  rule: RuleItem;
  now: number;
  namespace: string | undefined;
  showNamespace: boolean;
}) {
  const { state } = rule;
  return (
    <article className="space-y-3 rounded-xl border border-line bg-white px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-sm font-semibold break-all text-slate-900">
          {rule.name}
        </h3>
        <ModeBadge mode={rule.mode} />
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-xs text-slate-600">
          <HexagonIcon className="size-3.5 text-glass-cyan" />
          {showNamespace ? `${rule.target.namespace}/` : ""}
          {rule.target.deployment}
        </span>
      </div>
      {rule.description !== undefined && (
        <p className="text-[13px] text-slate-600">{rule.description}</p>
      )}
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-xs text-slate-500">조건</dt>
        <dd>
          <ul className="space-y-0.5 text-slate-800">
            {rule.when.map((condition, index) => (
              <li key={index}>
                {index > 0 && (
                  <span className="mr-1 text-xs text-slate-500">그리고</span>
                )}
                {conditionText(condition)}
              </li>
            ))}
          </ul>
        </dd>
        <dt className="text-xs text-slate-500">조치</dt>
        <dd className="text-slate-800">
          {ruleActionText(rule.action)}
          <span className="text-xs text-slate-500">
            {" "}
            · {ruleLimitsText(rule)}
          </span>
        </dd>
        <dt className="text-xs text-slate-500">지금</dt>
        <dd className="space-y-1">
          <p className="text-slate-700">{ruleStateText(rule, now)}</p>
          {rule.mode !== "off" && state.matching.length > 0 && (
            <ul className="space-y-0.5">
              {state.matching.map((match) => (
                <li
                  key={match.pod.name}
                  className="flex flex-wrap items-center gap-x-2 text-xs"
                >
                  <Link
                    to={podLink(match.pod, namespace)}
                    className="font-mono break-all text-deep-teal hover:underline"
                  >
                    {match.pod.name}
                  </Link>
                  <span className="text-slate-500">
                    {matchText(match, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(state.lastFiredAt !== undefined || state.firedLastHour > 0) && (
            <p className="text-xs text-slate-500">
              {state.lastFiredAt === undefined
                ? ""
                : `마지막 발동 ${formatDuration(now - state.lastFiredAt)} 전 · `}
              최근 1시간 {state.firedLastHour}번
              {rule.maxPerHour === undefined ? "" : ` / ${rule.maxPerHour}번`}
            </p>
          )}
        </dd>
      </dl>
      {rule.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-warning-ink">
          {rule.notes.map((note) => (
            <li key={note} className="flex items-start gap-1.5">
              <AlertIcon className="mt-px size-3.5 shrink-0" />
              {noteSentence(note)}
            </li>
          ))}
        </ul>
      )}
    </article>
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
