// snapshot 칸입니다(design.md 5.3, docs/guides/T19.md 결정 19). Pod를 열 때 한 번, '다시 받기'로 다시 SDK에 묻습니다.
// SDK가 붙지 않았거나 끊긴 Pod에는 묻지 않습니다. 스트림이 바뀌어도 다시 묻지 않습니다(앱에 부담).
import type { PodItem, PodRef, SnapshotBody } from "@glasspod/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ApiResult } from "../api/client.js";
import { getSnapshot } from "../api/pods.js";
import { CameraIcon, RotateIcon } from "../ui/icons.js";
import {
  formatClock,
  formatDuration,
  formatMegabytes,
  formatMs,
} from "../view/podText.js";
import {
  IN_FLIGHT_SHOWN,
  SLOW_REQUEST_MS,
  snapshotErrorText,
} from "../view/snapshotText.js";

interface Asked {
  result: ApiResult<SnapshotBody>;
  // 답을 받은 시각(서버 시계)입니다.
  at: number;
}

// 부모가 Pod마다 key를 바꿔 새로 그립니다.
export function SnapshotPanel({
  pod,
  item,
  now,
}: {
  pod: PodRef;
  item: PodItem | undefined;
  now: number;
}) {
  const connected = item?.sdk?.connected === true;
  // 0이면 아직 묻지 않았습니다. 늘어날 때마다 한 번 묻습니다.
  const [attempt, setAttempt] = useState(0);
  const [asked, setAsked] = useState<Asked | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const nowRef = useRef(now);
  useLayoutEffect(() => {
    nowRef.current = now;
  });

  // 연결된 것을 처음 알게 되면 한 번 묻습니다.
  useEffect(() => {
    if (connected && attempt === 0) {
      setAttempt(1);
    }
  }, [connected, attempt]);

  useEffect(() => {
    if (attempt === 0) {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void getSnapshot(pod, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setAsked({ result, at: nowRef.current });
        setLoading(false);
      }
    });
    return () => controller.abort();
    // pod는 부모가 key로 고정하므로 attempt만 봅니다.
  }, [attempt]);

  const ok = asked?.result.ok === true ? asked.result.data : undefined;
  return (
    <section
      aria-labelledby="snapshot-title"
      className="rounded-xl border border-line bg-white px-5 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="snapshot-title"
          className="flex items-center gap-2 text-[17px] font-bold text-slate-900"
        >
          <CameraIcon className="size-4 text-glass-cyan" />
          snapshot
          {asked !== undefined && ok !== undefined && (
            <span className="font-mono text-xs font-normal text-slate-500">
              {formatClock(asked.at)} · {ok.elapsedMs} ms
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => setAttempt((count) => count + 1)}
          disabled={loading || !connected}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-deep-teal hover:bg-mist disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateIcon className="size-4" />
          {loading ? "묻는 중" : "다시 받기"}
        </button>
      </div>
      <div className="mt-3" aria-live="polite" aria-busy={loading}>
        <SnapshotBodyView
          asked={asked}
          loading={loading}
          item={item}
          connected={connected}
        />
      </div>
    </section>
  );
}

function SnapshotBodyView({
  asked,
  loading,
  item,
  connected,
}: {
  asked: Asked | undefined;
  loading: boolean;
  item: PodItem | undefined;
  connected: boolean;
}) {
  if (asked === undefined) {
    return (
      <p className="text-sm text-slate-500">
        {loading
          ? "SDK에 묻는 중입니다. 앱이 답하지 않으면 5초 뒤에 끝납니다."
          : item === undefined
            ? "Pod 정보를 기다리는 중입니다."
            : item.sdk === undefined
              ? "SDK가 붙지 않은 Pod라 물을 수 없습니다."
              : connected
                ? "SDK에 물을 준비를 하는 중입니다."
                : "SDK가 연결되어 있지 않아 물을 수 없습니다."}
      </p>
    );
  }
  if (!asked.result.ok) {
    return (
      <div className="rounded-lg bg-warning-wash px-3 py-2">
        <p className="text-sm text-warning-ink">
          {snapshotErrorText(asked.result.error)}
        </p>
        <p className="mt-0.5 font-mono text-xs text-slate-500">
          {asked.result.status === 0
            ? "응답 없음"
            : `HTTP ${asked.result.status}`}{" "}
          · {asked.result.error}
        </p>
      </div>
    );
  }
  const { snapshot } = asked.result.data;
  const states = Object.entries(snapshot.state).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const shown = snapshot.inFlight.slice(0, IN_FLIGHT_SHOWN);
  const heapLimit = item?.metrics.heapLimitBytes;
  return (
    <div className="@container">
      <div className="grid gap-3 @xl:grid-cols-3">
        <Cell title={`처리 중 요청 ${snapshot.inFlight.length}`}>
          {shown.length === 0 ? (
            <p className="text-xs text-slate-500">없습니다</p>
          ) : (
            <ul className="space-y-0.5">
              {shown.map((request, index) => (
                <li
                  key={index}
                  className="flex justify-between gap-3 font-mono text-xs"
                >
                  <span className="truncate text-slate-700">
                    {request.route}
                  </span>
                  <span
                    className={`whitespace-nowrap ${
                      request.elapsedMs > SLOW_REQUEST_MS
                        ? "font-semibold text-warning-ink"
                        : "text-slate-600"
                    }`}
                  >
                    {formatMs(request.elapsedMs)}
                  </span>
                </li>
              ))}
              {snapshot.inFlight.length > shown.length && (
                <li className="text-xs text-slate-500">
                  외 {snapshot.inFlight.length - shown.length}개
                </li>
              )}
            </ul>
          )}
        </Cell>
        <Cell title="상태 값">
          {states.length === 0 ? (
            <p className="text-xs text-slate-500">등록된 상태 값이 없습니다</p>
          ) : (
            <ul className="space-y-0.5">
              {states.map(([name, value]) => (
                <li
                  key={name}
                  className="flex justify-between gap-3 font-mono text-xs"
                >
                  <span className="truncate text-slate-700">{name}</span>
                  <span className="truncate text-slate-900">
                    &quot;{value}&quot;
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Cell>
        <Cell title="프로세스">
          <ul className="space-y-0.5 font-mono text-xs text-slate-700">
            <li>실행 {formatDuration(snapshot.process.uptimeSec * 1000)}</li>
            <li>
              힙 {formatMegabytes(snapshot.process.heapUsedBytes)}
              {heapLimit === undefined
                ? ""
                : ` / ${formatMegabytes(heapLimit)}`}
            </li>
          </ul>
        </Cell>
      </div>
    </div>
  );
}

function Cell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-paper px-3 py-2.5">
      <p className="mb-1.5 text-xs text-slate-500">{title}</p>
      {children}
    </div>
  );
}
