// Pod 상세 화면(분할 화면의 오른쪽)입니다(design.md 5.3, docs/guides/T19.md).
// 머리줄, '무슨 일이 있었나', 지표 그래프, snapshot, 조치 기록을 위에서 아래로 둡니다.
// 판단 배지와 문장은 목록 스트림의 항목을 쓰고(없으면 상세 본문의 항목), 상세와 시계열은 그 항목이 바뀔 때 다시 받습니다.
// 조치 버튼을 누르면 오른쪽 서랍에서 확인한 뒤 실행합니다(docs/guides/T21.md, docs/guides/T23.md).
import type { ActionKind, PodRef } from "@glasspod/protocol";
import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { DeleteDrawer } from "../actions/DeleteDrawer.js";
import { IsolateDrawer } from "../actions/IsolateDrawer.js";
import { RestartDrawer } from "../actions/RestartDrawer.js";
import { usePodDetail } from "../api/usePodDetail.js";
import { ActionHistory } from "../detail/ActionHistory.js";
import { DetailHeader } from "../detail/DetailHeader.js";
import { MetricsPanel } from "../detail/MetricsPanel.js";
import type { PeriodMinutes } from "../detail/MetricsPanel.js";
import { SnapshotPanel } from "../detail/SnapshotPanel.js";
import { WhatHappened } from "../detail/WhatHappened.js";
import { overviewLink, useShell } from "../shell/shellContext.js";
import {
  ACTION_KINDS,
  actionBlockReason,
  isActionOn,
  mergeActions,
} from "../view/actionText.js";

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

  // 열린 서랍입니다. Pod를 바꾸면 닫힙니다(아래 podKey 비교).
  const [drawer, setDrawer] = useState<
    { podKey: string; action: ActionKind } | undefined
  >();
  const closeDrawer = useCallback(() => setDrawer(undefined), []);
  const actionNamespaces = stream.state?.list.actionNamespaces;
  const blocked = Object.fromEntries(
    ACTION_KINDS.map((action) => [
      action,
      actionBlockReason(action, pod, streamItem, actionNamespaces),
    ]),
  ) as Record<ActionKind, string | undefined>;

  // 상세 본문의 조치와 그 뒤 스트림으로 온 이 Pod의 조치를 합칩니다(결정 20). 늦은 것부터입니다.
  const streamActions = stream.state?.actions;
  const detailActions = data.detail?.actions;
  const actions = useMemo(
    () =>
      mergeActions([
        detailActions ?? [],
        (streamActions ?? []).filter((action) => isActionOn(action, pod)),
      ]),
    [detailActions, streamActions, pod],
  );
  const detail = useMemo(
    () => (data.detail === undefined ? undefined : { ...data.detail, actions }),
    [data.detail, actions],
  );

  return (
    <div className="space-y-5 px-6 py-8 lg:px-8">
      <DetailHeader
        pod={pod}
        item={item}
        now={now}
        filter={filter}
        blocked={blocked}
        onAction={(action) => setDrawer({ podKey, action })}
      />

      {data.refreshFailure !== undefined && (
        <p className="text-xs text-warning-ink">
          상세를 새로 받지 못했습니다({data.refreshFailure.error}). 마지막으로
          받은 내용입니다.
        </p>
      )}

      {detail === undefined ? (
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
          {item !== undefined && <WhatHappened detail={detail} item={item} />}
          <MetricsPanel
            detail={detail}
            series={data.series}
            seriesFailure={data.seriesFailure}
            charts={data.charts}
            hasSdk={item?.sdk !== undefined || detail.values.length > 0}
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

      <ActionHistory actions={actions} now={now} filter={filter} />

      {/* 연 Pod에서만 그립니다. 다른 Pod로 옮기면 닫히고, 다시 열면 새 서랍입니다. */}
      {drawer?.podKey === podKey && drawer.action === "restart-pod" && (
        <RestartDrawer
          pod={pod}
          item={streamItem}
          pods={stream.state?.list.pods ?? []}
          onClose={closeDrawer}
        />
      )}
      {drawer?.podKey === podKey && drawer.action === "isolate-pod" && (
        <IsolateDrawer
          pod={pod}
          item={streamItem}
          pods={stream.state?.list.pods ?? []}
          onClose={closeDrawer}
        />
      )}
      {drawer?.podKey === podKey && drawer.action === "delete-pod" && (
        <DeleteDrawer pod={pod} item={streamItem} onClose={closeDrawer} />
      )}
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
