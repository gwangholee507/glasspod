// 지표 그래프 4개입니다(design.md 5.3, docs/guides/T19.md 결정 2, 15~18).
// 이 Pod 선과 같은 Deployment의 다른 Pod 선, 재시작 점선을 그리고, 기간은 5·15·30분입니다.
import type {
  MetricSeriesBody,
  PodDetailBody,
  PodMetricValue,
} from "@glasspod/protocol";
import { useMemo, useState } from "react";
import type { ApiFailure } from "../api/client.js";
import { UPlotChart } from "../ui/UPlotChart.js";
import {
  chartSeries,
  formatDisplayValue,
  fourthChartOptions,
  nearestValueIndex,
  restartMarks,
} from "../view/detailView.js";
import type { ChartSpec } from "../view/detailView.js";
import { formatClock } from "../view/podText.js";

export const PERIODS_MINUTES = [5, 15, 30] as const;
export type PeriodMinutes = (typeof PERIODS_MINUTES)[number];

const CHART_HEIGHT = 120;

export function MetricsPanel({
  detail,
  series,
  seriesFailure,
  charts,
  hasSdk,
  period,
  onPeriodChange,
  onChartChange,
}: {
  detail: PodDetailBody;
  series: MetricSeriesBody | undefined;
  seriesFailure: ApiFailure | undefined;
  charts: readonly ChartSpec[];
  // SDK가 붙은 적이 있는 Pod인지입니다.
  hasSdk: boolean;
  period: PeriodMinutes;
  onPeriodChange: (period: PeriodMinutes) => void;
  onChartChange: (name: string) => void;
}) {
  const options = fourthChartOptions(detail.values);
  return (
    <section aria-labelledby="metrics-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2
            id="metrics-title"
            className="text-[17px] font-bold text-slate-900"
          >
            지표
          </h2>
          <div
            role="tablist"
            aria-label="기간"
            className="flex rounded-lg bg-tab p-0.5 text-xs"
          >
            {PERIODS_MINUTES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                role="tab"
                aria-selected={period === minutes}
                onClick={() => onPeriodChange(minutes)}
                className={`rounded-md px-2.5 py-1 ${
                  period === minutes
                    ? "bg-white font-semibold text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {minutes}분
              </button>
            ))}
          </div>
        </div>
        <Legend />
      </div>

      {!hasSdk ? (
        <p className="rounded-xl border border-line bg-white px-5 py-6 text-sm text-slate-500">
          SDK가 붙지 않은 Pod라 지표가 없습니다.
        </p>
      ) : (
        <>
          {seriesFailure !== undefined && (
            <p className="text-xs text-warning-ink">
              그래프를 새로 받지 못했습니다({seriesFailure.error}).
              {series === undefined ? "" : " 마지막으로 받은 값입니다."}
            </p>
          )}
          <div className="@container">
            <div className="grid gap-3 @xl:grid-cols-2">
              {charts.map((chart, index) => (
                <ChartCard
                  key={index}
                  chart={chart}
                  detail={detail}
                  series={series}
                  period={period}
                  {...(index === 3 ? { options, onChartChange } : {})}
                />
              ))}
              {charts.length < 4 && (
                <div className="rounded-xl border border-line bg-white px-4 py-3">
                  <p className="text-[13px] font-semibold text-slate-700">
                    앱 지표
                  </p>
                  <p className="mt-3 text-xs text-slate-500">
                    고를 지표가 없습니다.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-4 rounded bg-glass-cyan" aria-hidden="true" />
        이 Pod
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="h-0.5 w-4 rounded bg-neutral-mark"
          aria-hidden="true"
        />
        같은 Deployment의 다른 Pod
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="h-3 w-0 border-l-2 border-dashed border-coral"
          aria-hidden="true"
        />
        재시작
      </span>
    </div>
  );
}

function ChartCard({
  chart,
  detail,
  series,
  period,
  options,
  onChartChange,
}: {
  chart: ChartSpec;
  detail: PodDetailBody;
  series: MetricSeriesBody | undefined;
  period: PeriodMinutes;
  // 네 번째 그래프만: 고를 수 있는 지표입니다.
  options?: readonly PodMetricValue[];
  onChartChange?: (name: string) => void;
}) {
  const [hover, setHover] = useState<number | undefined>(undefined);
  const drawn = useMemo(
    () =>
      series === undefined
        ? undefined
        : chartSeries(series, chart.name, chart.unit),
    [series, chart.name, chart.unit],
  );
  const range = useMemo(
    () =>
      series === undefined
        ? undefined
        : ([series.serverTime - period * 60_000, series.serverTime] as const),
    [series, period],
  );
  const marks = useMemo(
    () => (range === undefined ? [] : restartMarks(detail, range[0])),
    [detail, range],
  );

  const own = drawn?.data[1];
  const hoverIndex =
    hover === undefined || own === undefined
      ? undefined
      : nearestValueIndex(own, hover);
  const hoverTime =
    hoverIndex === undefined ? undefined : drawn?.data[0][hoverIndex];
  const shown =
    hoverIndex === undefined ? drawn?.last : (own?.[hoverIndex] ?? undefined);

  return (
    <div className="min-w-0 rounded-xl border border-line bg-white px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        {options !== undefined && onChartChange !== undefined ? (
          <select
            value={chart.name}
            onChange={(event) => onChartChange(event.target.value)}
            aria-label="네 번째 그래프 지표"
            className="max-w-[60%] truncate rounded-md border border-line bg-white px-1.5 py-0.5 font-mono text-xs text-slate-700"
          >
            {options.map((option) => (
              <option key={option.name} value={option.name}>
                {option.name}
              </option>
            ))}
          </select>
        ) : (
          <h3 className="text-[13px] font-semibold text-slate-700">
            {chart.title}
          </h3>
        )}
        <span className="font-mono text-[13px] whitespace-nowrap text-slate-900">
          {hoverTime !== undefined && (
            <span className="mr-1.5 text-xs text-slate-500">
              {formatClock(hoverTime)}
            </span>
          )}
          {formatDisplayValue(shown, chart.unit)}
        </span>
      </div>
      <div className="mt-2" style={{ minHeight: CHART_HEIGHT }}>
        {drawn === undefined || range === undefined ? (
          <p className="pt-10 text-center text-xs text-slate-500">
            불러오는 중입니다.
          </p>
        ) : !drawn.hasOwnData ? (
          <p className="pt-10 text-center text-xs text-slate-500">
            이 Pod는 이 지표를 보내지 않습니다.
          </p>
        ) : (
          <UPlotChart
            data={drawn.data}
            range={range}
            marks={marks}
            height={CHART_HEIGHT}
            label={`${chart.title} 그래프`}
            onHover={setHover}
          />
        )}
      </div>
    </div>
  );
}
