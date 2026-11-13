// Pod 상세 자리입니다. 지금은 snapshot API를 불러 원본 JSON과 오류를 그대로 보여 줍니다.
// 지표 그래프, 최근 이벤트, snapshot 표시는 T19에서 만듭니다.
import type { SnapshotBody } from "@glasspod/protocol";
import { Link, useParams } from "react-router";
import type { ApiResult } from "../api/client.js";
import { getSnapshot } from "../api/pods.js";
import { useApiResult } from "../api/useApiResult.js";

export function PodDetailPage() {
  // 라우트가 두 값을 모두 정하므로 비어 있을 수 없습니다.
  const { namespace = "", name = "" } = useParams();
  const { result, loading, reload } = useApiResult(
    JSON.stringify([namespace, name]),
    (signal) => getSnapshot({ namespace, name }, signal),
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

      <div className="space-y-3 rounded-lg border border-mist bg-white p-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-semibold text-slate-800">Snapshot</h2>
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
          {loading && (
            <p className="text-sm text-slate-500">
              SDK에 묻는 중입니다. 앱이 답하지 않으면 5초 뒤에 끝납니다.
            </p>
          )}
          {result !== undefined && <SnapshotResult result={result} />}
        </div>
      </div>
    </section>
  );
}

function SnapshotResult({ result }: { result: ApiResult<SnapshotBody> }) {
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
        HTTP {result.status} · {result.data.elapsedMs}ms · instance{" "}
        {result.data.instanceId}
      </p>
      <pre className="overflow-x-auto rounded-md bg-paper p-3 font-mono text-xs leading-relaxed text-slate-800">
        {JSON.stringify(result.data, null, 2)}
      </pre>
    </div>
  );
}
