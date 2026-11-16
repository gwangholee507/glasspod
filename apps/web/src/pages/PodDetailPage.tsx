// Pod 상세 자리입니다. 상세 API(T14)와 snapshot API(T09)를 불러 원본 JSON과 오류를 그대로 보여 줍니다.
// 판단 머리줄, '무슨 일이 있었나', 지표 그래프, snapshot 표시는 T19에서 만듭니다.
import type { PodDetailBody, SnapshotBody } from "@glasspod/protocol";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import type { ApiResult } from "../api/client.js";
import { getPod, getSnapshot } from "../api/pods.js";
import { useApiResult } from "../api/useApiResult.js";

export function PodDetailPage() {
  // 라우트가 두 값을 모두 정하므로 비어 있을 수 없습니다.
  const { namespace = "", name = "" } = useParams();
  const key = JSON.stringify([namespace, name]);
  const detail = useApiResult(key, (signal) =>
    getPod({ namespace, name }, signal),
  );
  const snapshot = useApiResult(key, (signal) =>
    getSnapshot({ namespace, name }, signal),
  );

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-slate-500">
          <Link to="/" className="hover:text-deep-teal">
            Pod 목록
          </Link>
          <span className="mx-1.5">/</span>
          <span className="font-mono">{namespace}</span>
        </p>
        <h1 className="font-mono text-2xl font-semibold break-all text-deep-teal">
          {name}
        </h1>
      </div>

      <Panel
        title="상세"
        loading={detail.loading}
        reload={detail.reload}
        loadingText="서버에서 불러오는 중입니다."
      >
        {detail.result !== undefined && (
          <RawResult result={detail.result} summary={detailSummary} />
        )}
      </Panel>

      <Panel
        title="Snapshot"
        loading={snapshot.loading}
        reload={snapshot.reload}
        loadingText="SDK에 묻는 중입니다. 앱이 답하지 않으면 5초 뒤에 끝납니다."
      >
        {snapshot.result !== undefined && (
          <RawResult result={snapshot.result} summary={snapshotSummary} />
        )}
      </Panel>
    </section>
  );
}

function detailSummary(body: PodDetailBody): string {
  return `${body.item.status} · event ${body.events.length} · 지표 ${body.values.length}`;
}

function snapshotSummary(body: SnapshotBody): string {
  return `${body.elapsedMs}ms · instance ${body.instanceId}`;
}

function Panel({
  title,
  loading,
  reload,
  loadingText,
  children,
}: {
  title: string;
  loading: boolean;
  reload: () => void;
  loadingText: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-mist bg-white p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold text-slate-800">{title}</h2>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="rounded-md border border-glass-cyan px-3 py-1 text-sm text-deep-teal hover:bg-mist disabled:cursor-not-allowed disabled:opacity-40"
        >
          다시 불러오기
        </button>
      </div>
      <div aria-live="polite" aria-busy={loading}>
        {loading && <p className="text-sm text-slate-500">{loadingText}</p>}
        {children}
      </div>
    </div>
  );
}

function RawResult<T>({
  result,
  summary,
}: {
  result: ApiResult<T>;
  summary: (body: T) => string;
}) {
  if (!result.ok) {
    return (
      <div className="space-y-1 rounded-md border border-coral bg-coral/10 p-3">
        <p className="font-mono text-sm font-medium text-slate-900">
          {result.status === 0 ? "응답 없음" : `HTTP ${result.status}`} ·{" "}
          {result.error}
        </p>
        <p className="text-sm break-words text-slate-700">{result.detail}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="font-mono text-sm text-slate-500">
        HTTP {result.status} · {summary(result.data)}
      </p>
      <pre className="max-h-[32rem] overflow-auto rounded-md bg-paper p-3 font-mono text-xs leading-relaxed text-slate-800">
        {JSON.stringify(result.data, null, 2)}
      </pre>
    </div>
  );
}
