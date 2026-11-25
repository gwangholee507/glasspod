// 상세와 그래프용 시계열을 받아 들고 있는 훅입니다(docs/guides/T19.md 결정 1, 11).
// 화면을 열 때 받고, 스트림의 이 Pod 항목이 바뀌거나 스트림이 다시 붙으면(trigger) 5초에 한 번까지 다시 받습니다.
// 상세를 먼저 받아 네 번째 그래프의 지표를 정한 뒤 시계열을 받습니다. 다시 받다 실패해도 이전 값을 그대로 둡니다.
import type {
  MetricSeriesBody,
  PodDetailBody,
  PodRef,
} from "@glasspod/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  FIXED_CHARTS,
  chooseFourthChart,
  refreshDelayMs,
} from "../view/detailView.js";
import type { ChartSpec } from "../view/detailView.js";
import type { ApiFailure } from "./client.js";
import { getPod, getSeries } from "./pods.js";

export interface PodDetailData {
  // 마지막으로 받은 상세와 시계열입니다.
  detail: PodDetailBody | undefined;
  series: MetricSeriesBody | undefined;
  // 상세를 한 번도 받지 못했을 때의 실패입니다.
  failure: ApiFailure | undefined;
  // 이전 값을 보이는 중에 다시 받기가 실패했으면 그 실패입니다.
  refreshFailure: ApiFailure | undefined;
  seriesFailure: ApiFailure | undefined;
  // 그래프 4개입니다. 네 번째는 이 Pod가 보낼 때만 있습니다.
  charts: ChartSpec[];
  reload: () => void;
}

interface Loaded {
  key: string;
  detail: PodDetailBody | undefined;
  series: MetricSeriesBody | undefined;
  failure: ApiFailure | undefined;
  refreshFailure: ApiFailure | undefined;
  seriesFailure: ApiFailure | undefined;
}

function empty(key: string): Loaded {
  return {
    key,
    detail: undefined,
    series: undefined,
    failure: undefined,
    refreshFailure: undefined,
    seriesFailure: undefined,
  };
}

function chartsFor(
  detail: PodDetailBody | undefined,
  selected: string | undefined,
): ChartSpec[] {
  // 다른 Pod보다 높은 값을 네 번째 그래프의 기본값으로 먼저 고릅니다(docs/guides/T34.md 결정 16).
  const fourth = chooseFourthChart(
    detail?.values ?? [],
    selected,
    detail?.item.outliers?.map((outlier) => outlier.metric),
  );
  return fourth === undefined ? [...FIXED_CHARTS] : [...FIXED_CHARTS, fourth];
}

interface Runner {
  controller: AbortController | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastStartedAt: number | undefined;
  // 받는 중에 다시 받을 일이 생겼습니다.
  pending: boolean;
}

export function usePodDetail(
  pod: PodRef,
  // 바뀌면 다시 받습니다(이 Pod의 스트림 항목, 스트림이 붙은 횟수).
  trigger: readonly unknown[],
  selectedChart: string | undefined,
): PodDetailData {
  const key = JSON.stringify([pod.namespace, pod.name]);
  const [loaded, setLoaded] = useState<Loaded>(() => empty(key));

  // 콜백이 늘 최신 값을 읽게 ref에 둡니다.
  const latest = useRef({ pod, selectedChart, loaded });
  useLayoutEffect(() => {
    latest.current = { pod, selectedChart, loaded };
  });
  const runner = useRef<Runner>({
    controller: undefined,
    timer: undefined,
    lastStartedAt: undefined,
    pending: false,
  });

  const run = useCallback(async () => {
    const state = runner.current;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.pending = false;
    state.lastStartedAt = Date.now();
    const { pod: target } = latest.current;
    const runKey = JSON.stringify([target.namespace, target.name]);

    const detailResult = await getPod(target, controller.signal);
    if (controller.signal.aborted) {
      return;
    }
    const previous = latest.current.loaded;
    const known = previous.key === runKey ? previous.detail : undefined;
    const detail = detailResult.ok ? detailResult.data : known;
    let seriesResult: Awaited<ReturnType<typeof getSeries>> | undefined;
    if (detail !== undefined) {
      const names = chartsFor(detail, latest.current.selectedChart).map(
        (chart) => chart.name,
      );
      seriesResult = await getSeries(target, names, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
    }
    setLoaded((current) => {
      const base = current.key === runKey ? current : empty(runKey);
      const next: Loaded = { ...base };
      if (detailResult.ok) {
        next.detail = detailResult.data;
        next.failure = undefined;
        next.refreshFailure = undefined;
      } else if (base.detail === undefined) {
        next.failure = detailResult;
      } else {
        next.refreshFailure = detailResult;
      }
      if (seriesResult !== undefined) {
        if (seriesResult.ok) {
          next.series = seriesResult.data;
          next.seriesFailure = undefined;
        } else {
          next.seriesFailure = seriesResult;
        }
      }
      return next;
    });
    state.controller = undefined;
    if (state.pending) {
      schedule();
    }
  }, []);

  // 5초 간격을 지켜 다시 받습니다. 받는 중이면 끝난 뒤에 한 번 받습니다.
  const schedule = useCallback(() => {
    const state = runner.current;
    if (state.controller !== undefined) {
      state.pending = true;
      return;
    }
    if (state.timer !== undefined) {
      return;
    }
    state.timer = setTimeout(
      () => void run(),
      refreshDelayMs(state.lastStartedAt, Date.now()),
    );
  }, [run]);

  // Pod가 바뀌면 처음부터 받습니다. 화면을 떠나면 받는 것과 기다리는 것을 모두 멈춥니다.
  useEffect(() => {
    setLoaded((current) => (current.key === key ? current : empty(key)));
    runner.current.lastStartedAt = undefined;
    void run();
    const state = runner.current;
    return () => {
      state.controller?.abort();
      state.controller = undefined;
      clearTimeout(state.timer);
      state.timer = undefined;
      state.pending = false;
    };
  }, [key, run]);

  // 스트림의 항목이 바뀌면 간격을 지켜 다시 받습니다. 처음 그린 때와 Pod가 바뀐 때는 위 effect가 받으므로 건너뜁니다.
  const triggerSeen = useRef<
    { key: string; trigger: readonly unknown[] } | undefined
  >(undefined);
  useEffect(() => {
    const before = triggerSeen.current;
    triggerSeen.current = { key, trigger };
    if (
      before !== undefined &&
      before.key === key &&
      (before.trigger.length !== trigger.length ||
        before.trigger.some(
          (value, index) => !Object.is(value, trigger[index]),
        ))
    ) {
      schedule();
    }
  });

  // 네 번째 그래프를 바꾸면 기다리지 않고 바로 받습니다.
  const fourth =
    loaded.key === key
      ? chartsFor(loaded.detail, selectedChart)[3]?.name
      : undefined;
  const fourthKey = useRef(fourth);
  useEffect(() => {
    if (fourthKey.current !== fourth) {
      const before = fourthKey.current;
      fourthKey.current = fourth;
      // 상세를 처음 받아 기본값이 정해진 것은 run이 이미 그 이름으로 받았습니다.
      if (before !== undefined && fourth !== undefined) {
        void run();
      }
    }
  }, [fourth, run]);

  const reload = useCallback(() => void run(), [run]);
  const current = loaded.key === key ? loaded : empty(key);
  return {
    detail: current.detail,
    series: current.series,
    failure: current.failure,
    refreshFailure: current.refreshFailure,
    seriesFailure: current.seriesFailure,
    charts: chartsFor(current.detail, selectedChart),
    reload,
  };
}
