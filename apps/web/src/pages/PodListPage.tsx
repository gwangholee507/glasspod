// Pod 목록 자리입니다. SSE(usePodStream)로 받은 목록을 꾸미지 않은 표로 보여 줍니다(docs/guides/T14.md 결정 20).
// 분할 화면, '지금 볼 것' 묶음, 상태 배지는 T18에서 만듭니다(design.md 5.3).
import { useState } from "react";
import type { PodItem, PodStatusChange } from "@glasspod/protocol";
import { Link } from "react-router";
import { usePodStream } from "../api/podStream.js";
import type { PodStreamStatus } from "../api/podStream.js";

const STATUS_TEXT: Record<PodStreamStatus, string> = {
  connecting: "연결 중입니다",
  open: "실시간으로 받는 중입니다",
  reconnecting: "끊겨서 다시 연결 중입니다",
};

const BYTES_PER_MB = 1024 * 1024;

export function PodListPage() {
  const [namespace, setNamespace] = useState<string | undefined>(undefined);
  const { state, status } = usePodStream(namespace);
  const list = state?.list;

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-deep-teal">Pod 목록</h1>
        <p className="text-slate-600">
          서버가 1초마다 판단한 결과를 실시간으로 받습니다. 화면 디자인은 다음
          작업에서 꾸밉니다.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2 text-slate-600">
          namespace
          <select
            value={namespace ?? ""}
            onChange={(event) =>
              setNamespace(
                event.target.value === "" ? undefined : event.target.value,
              )
            }
            className="rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-slate-800"
          >
            <option value="">전체</option>
            {(list?.namespaces ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span
          role="status"
          className={
            status === "open"
              ? "rounded-md bg-mist px-2 py-1 text-deep-teal"
              : "rounded-md bg-coral/15 px-2 py-1 text-slate-800"
          }
        >
          {STATUS_TEXT[status]}
        </span>
      </div>

      {list !== undefined && (
        <>
          <div className="overflow-x-auto rounded-lg border border-mist bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-mist text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Pod</th>
                  <th className="px-3 py-2 font-medium">Deployment</th>
                  <th className="px-3 py-2 font-medium">판단</th>
                  <th className="px-3 py-2 font-medium">이유</th>
                  <th className="px-3 py-2 font-medium">지속</th>
                  <th className="px-3 py-2 text-right font-medium">루프 p99</th>
                  <th className="px-3 py-2 text-right font-medium">힙</th>
                  <th className="px-3 py-2 text-right font-medium">요청 p99</th>
                  <th className="px-3 py-2 text-right font-medium">5xx/분</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {list.pods.map((item) => (
                  <PodRow
                    key={`${item.pod.namespace}/${item.pod.name}`}
                    item={item}
                    serverTime={list.serverTime}
                  />
                ))}
              </tbody>
            </table>
            {list.pods.length === 0 && (
              <p className="px-3 py-4 text-sm text-slate-500">
                판단한 Pod가 없습니다.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h2 className="font-semibold text-slate-800">
              이 화면을 연 뒤의 판단 변화
            </h2>
            <ul className="space-y-1 font-mono text-xs text-slate-700">
              {[...(state?.statusChanges ?? [])]
                .reverse()
                .slice(0, 20)
                .map((change) => (
                  <StatusChangeLine
                    key={`${change.pod.namespace}/${change.pod.name}/${change.at}`}
                    change={change}
                  />
                ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}

function PodRow({ item, serverTime }: { item: PodItem; serverTime: number }) {
  const { metrics } = item;
  return (
    <tr
      className={
        item.severity === "critical"
          ? "border-b border-mist bg-coral/15"
          : item.severity === "warning"
            ? "border-b border-mist bg-coral/5"
            : "border-b border-mist"
      }
    >
      <td className="px-3 py-1.5 break-all">
        <Link
          to={`/pods/${encodeURIComponent(item.pod.namespace)}/${encodeURIComponent(item.pod.name)}`}
          className="text-deep-teal hover:underline"
        >
          {item.pod.name}
        </Link>
      </td>
      <td className="px-3 py-1.5">{item.deployment ?? "—"}</td>
      <td className="px-3 py-1.5">{item.status}</td>
      <td className="px-3 py-1.5">{item.reason ?? ""}</td>
      <td className="px-3 py-1.5">
        {Math.max(0, Math.round((serverTime - item.since) / 1000))}초
      </td>
      <td className="px-3 py-1.5 text-right">
        {number(metrics.eventLoopP99Ms, 1, "ms")}
      </td>
      <td className="px-3 py-1.5 text-right">
        {number(
          metrics.heapUsedBytes === undefined
            ? undefined
            : metrics.heapUsedBytes / BYTES_PER_MB,
          0,
          "MB",
        )}
      </td>
      <td className="px-3 py-1.5 text-right">
        {number(metrics.httpP99Ms, 1, "ms")}
      </td>
      <td className="px-3 py-1.5 text-right">
        {metrics.http5xxPerMinute === undefined ||
        metrics.http5xxPerMinute === 0
          ? ""
          : metrics.http5xxPerMinute}
      </td>
    </tr>
  );
}

function StatusChangeLine({ change }: { change: PodStatusChange }) {
  return (
    <li>
      {new Date(change.at).toLocaleTimeString()} {change.pod.name}{" "}
      {change.previous ?? "(처음)"} → {change.status}
      {change.reason === undefined ? "" : ` (${change.reason})`}
    </li>
  );
}

function number(value: number | undefined, digits: number, unit: string) {
  return value === undefined ? "—" : `${value.toFixed(digits)}${unit}`;
}
