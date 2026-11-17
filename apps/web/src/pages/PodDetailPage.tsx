// Pod 상세 화면(분할 화면의 오른쪽)입니다(design.md 5.3, docs/guides/T19.md).
// 머리줄, '무슨 일이 있었나', 지표 그래프, snapshot, 조치 기록 자리를 위에서 아래로 둡니다.
// 판단 배지와 문장은 목록 스트림의 항목을 쓰고(없으면 상세 본문의 항목), 상세와 시계열은 그 항목이 바뀔 때 다시 받습니다.
import type { PodRef } from "@glasspod/protocol";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { usePodDetail } from "../api/usePodDetail.js";
import { DetailHeader } from "../detail/DetailHeader.js";
import { MetricsPanel } from "../detail/MetricsPanel.js";
import type { PeriodMinutes } from "../detail/MetricsPanel.js";
import { SnapshotPanel } from "../detail/SnapshotPanel.js";
import { WhatHappened } from "../detail/WhatHappened.js";
import { overviewLink, useShell } from "../shell/shellContext.js";
import { HistoryIcon } from "../ui/icons.js";

export function PodDetailPage() {
  // 라우트가 두 값을 모두 정하므로 비어 있을 수 없습니다.
  const { namespace = "", name = "" } = useParams();
  // filter는 목록에서 고른 namespace(주소의 ?namespace=)이고, namespace는 이 Pod의 namespace입니다.
  const { stream, namespace: filter, now } = useShell();
  const pod: PodRef = useMemo(() => ({ namespace, name }), [namespace, name]);
  const streamItem = stream.state?.list.pods.find(
    (item) => item.pod.namespace === namespace && item.pod.name === name,
  );
  // 기간과 네 번째 그래프는 화면 상태입니다. Pod를 바꿔도 그대로 둡니다(결정 15, 16).
  const [period, setPeriod] = useState<PeriodMinutes>(30);
  const [selectedChart, setSelectedChart] = useState<string | undefined>(
    undefined,
  );
  const data = usePodDetail(pod, [streamItem, stream.opens], selectedChart);
  const item = streamItem ?? data.detail?.item;
  const podKey = JSON.stringify([namespace, name]);

  return (
    <div className="space-y-5 px-6 py-8 lg:px-8">
      <DetailHeader pod={pod} item={item} now={now} filter={filter} />

      {data.refreshFailure !== undefined && (
        <p className="text-xs text-warning-ink">
          상세를 새로 받지 못했습니다({data.refreshFailure.error}). 마지막으로
          받은 내용입니다.
        </p>
      )}

      {data.detail === undefined ? (
        data.failure === undefined ? (
          <p className="text-sm text-slate-500">서버에서 불러오는 중입니다.</p>
        ) : (
          <DetailFailure
            status={data.failure.status}
            error={data.failure.error}
            detail={data.failure.detail}
            filter={filter}
            onReload={data.reload}
          />
        )
      ) : (
        <>
          {item !== undefined && (
            <WhatHappened detail={data.detail} item={item} />
          )}
          <MetricsPanel
            detail={data.detail}
            series={data.series}
            seriesFailure={data.seriesFailure}
            charts={data.charts}
            hasSdk={item?.sdk !== undefined || data.detail.values.length > 0}
            period={period}
            onPeriodChange={setPeriod}
            onChartChange={setSelectedChart}
          />
        </>
      )}

      {/* 서버가 모르는 Pod에는 물을 SDK도 없습니다. */}
      {data.failure?.error !== "pod-not-found" && (
        <SnapshotPanel key={podKey} pod={pod} item={item} now={now} />
      )}

      <section className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-white px-5 py-4">
        <h2 className="flex items-center gap-2 text-[15px] font-bold text-slate-900">
          <HistoryIcon className="size-4 text-glass-cyan" />
          조치 기록
        </h2>
        <span className="text-[13px] text-slate-400">
          조치 기능을 만든 뒤에 이 Pod의 조치가 보입니다.
        </span>
      </section>
    </div>
  );
}

function DetailFailure({
  status,
  error,
  detail,
  filter,
  onReload,
}: {
  status: number;
  error: string;
  detail: string;
  filter: string | undefined;
  onReload: () => void;
}) {
  if (error === "pod-not-found") {
    return (
      <div className="rounded-xl border border-line bg-white px-5 py-5">
        <p className="text-sm text-slate-700">
          서버가 이 Pod를 모릅니다. 지워진 지 오래됐거나 이름이 틀렸습니다.
        </p>
        <Link
          to={overviewLink(filter)}
          className="mt-2 inline-block text-sm text-deep-teal hover:underline"
        >
          한눈에 보기로 돌아갑니다
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-warning-line bg-warning-wash px-5 py-4">
      <p className="font-mono text-sm font-medium text-slate-900">
        {status === 0 ? "응답 없음" : `HTTP ${status}`} · {error}
      </p>
      <p className="text-sm break-words text-slate-700">{detail}</p>
      <button
        type="button"
        onClick={onReload}
        className="rounded-md border border-glass-cyan bg-white px-3 py-1 text-sm text-deep-teal hover:bg-mist"
      >
        다시 불러오기
      </button>
    </div>
  );
}
