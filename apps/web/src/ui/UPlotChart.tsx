// uPlot(D8) 감싸기입니다(docs/guides/T19.md 결정 15, 22). 칸 너비에 맞춰 그리고, 재시작 시각에 세로 점선을 긋고,
// 마우스가 가리킨 칸을 알립니다. 범례는 화면이 그리므로 uPlot의 범례는 끕니다.
import { useEffect, useLayoutEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartData } from "../view/detailView.js";

// design.md 12장 색입니다(index.css의 @theme와 같은 값). canvas에는 CSS 변수를 쓸 수 없어 값을 씁니다.
const OWN_LINE = "#0e9db5";
const OTHER_LINE = "#b8cbd0";
const RESTART_LINE = "#ff7a59";
const GRID_LINE = "#dde9ec";
const AXIS_TEXT = "#64748b";
const AXIS_FONT = "10px 'JetBrains Mono Variable', 'JetBrains Mono', monospace";

function clock(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Y축 눈금 글입니다. 크면 k로 줄입니다.
function axisNumber(value: number): string {
  const size = Math.abs(value);
  if (size >= 10_000) {
    return `${Math.round(value / 1000)}k`;
  }
  if (size >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  if (size > 0 && size < 10 && !Number.isInteger(value)) {
    return value.toFixed(1);
  }
  return String(Math.round(value));
}

export interface UPlotChartProps {
  // [x(ms), 이 Pod, 다른 Pod...]. 이 Pod 선을 맨 위에 그립니다.
  data: ChartData;
  // X축 범위(ms, 서버 시계)입니다.
  range: readonly [number, number];
  // 재시작 세로 점선을 그을 시각입니다.
  marks: readonly number[];
  height: number;
  label: string;
  // 마우스가 가리킨 칸(data의 index)입니다. 벗어나면 undefined입니다.
  onHover: (index: number | undefined) => void;
}

// uPlot에 넘기는 순서: [x, 다른 Pod..., 이 Pod]. 나중에 그린 선이 위에 옵니다.
function plotData(data: ChartData): uPlot.AlignedData {
  const [xs, own, ...others] = data;
  return [xs, ...others, own ?? []] as unknown as uPlot.AlignedData;
}

export function UPlotChart({
  data,
  range,
  marks,
  height,
  label,
  onHover,
}: UPlotChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | undefined>(undefined);
  // uPlot 콜백이 늘 최신 값을 읽게 ref에 둡니다.
  const latest = useRef({ range, marks, onHover });
  useLayoutEffect(() => {
    latest.current = { range, marks, onHover };
  });

  const seriesCount = data.length - 1;
  useEffect(() => {
    const element = container.current;
    if (element === null) {
      return;
    }
    const others = Array.from({ length: Math.max(seriesCount - 1, 0) }, () => ({
      stroke: OTHER_LINE,
      width: 1,
      points: { show: false },
    }));
    const options: uPlot.Options = {
      width: Math.max(element.clientWidth, 100),
      height,
      // X값이 밀리초입니다.
      ms: 1,
      legend: { show: false },
      cursor: {
        y: false,
        points: { show: false },
        drag: { x: false, y: false },
      },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      scales: {
        x: {
          time: true,
          range: () => [latest.current.range[0], latest.current.range[1]],
        },
        y: {
          range: (_u, _min, max) => [0, max > 0 ? max * 1.15 : 1],
        },
      },
      axes: [
        {
          stroke: AXIS_TEXT,
          font: AXIS_FONT,
          size: 22,
          space: 64,
          grid: { stroke: GRID_LINE, width: 1 },
          ticks: { show: false },
          values: (_u, splits) => splits.map((value) => clock(value)),
        },
        {
          stroke: AXIS_TEXT,
          font: AXIS_FONT,
          size: 40,
          space: 28,
          grid: { stroke: GRID_LINE, width: 1 },
          ticks: { show: false },
          values: (_u, splits) => splits.map((value) => axisNumber(value)),
        },
      ],
      series: [
        {},
        ...others,
        { stroke: OWN_LINE, width: 2, points: { show: false } },
      ],
      hooks: {
        draw: [
          (u) => {
            const { ctx, bbox } = u;
            const ratio = window.devicePixelRatio || 1;
            ctx.save();
            ctx.strokeStyle = RESTART_LINE;
            ctx.lineWidth = 1.5 * ratio;
            ctx.setLineDash([4 * ratio, 3 * ratio]);
            for (const mark of latest.current.marks) {
              const x = Math.round(u.valToPos(mark, "x", true));
              if (x < bbox.left || x > bbox.left + bbox.width) {
                continue;
              }
              ctx.beginPath();
              ctx.moveTo(x, bbox.top);
              ctx.lineTo(x, bbox.top + bbox.height);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
        setCursor: [
          (u) => {
            const index = u.cursor.idx;
            latest.current.onHover(
              index === null || index === undefined ? undefined : index,
            );
          },
        ],
      },
    };
    const chart = new uPlot(
      options,
      [[]] as unknown as uPlot.AlignedData,
      element,
    );
    plot.current = chart;
    const observer = new ResizeObserver(() => {
      chart.setSize({ width: Math.max(element.clientWidth, 100), height });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.destroy();
      plot.current = undefined;
    };
  }, [seriesCount, height]);

  // 데이터와 기간이 바뀌면 다시 그립니다. X축 범위는 scales.x.range가 latest에서 읽습니다.
  useEffect(() => {
    plot.current?.setData(plotData(data));
  }, [data, range, seriesCount]);

  // 재시작 표시만 바뀌어도 다시 그립니다.
  useEffect(() => {
    plot.current?.redraw(false, false);
  }, [marks]);

  return (
    <div ref={container} role="img" aria-label={label} className="w-full" />
  );
}
