// 격리된 Pod 화면입니다(design.md 5.3 '격리된 Pod', Figma 확정-4, docs/guides/T23.md 결정 18).
// 가운데 Pod 목록 칸 없이 넓게 씁니다. 틀의 목록 스트림에서 트래픽에서 뺀 Pod만 골라 카드로 그리고,
// '삭제'를 누르면 확인 서랍을 한 번 더 엽니다.
import type { PodItem, PodRef } from "@glasspod/protocol";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { DeleteDrawer } from "../actions/DeleteDrawer.js";
import { podLink, useShell } from "../shell/shellContext.js";
import {
  AlertIcon,
  ChevronRightIcon,
  InfoIcon,
  TrashIcon,
} from "../ui/icons.js";
import { IsolatedBadge, StatusBadge } from "../ui/StatusBadge.js";
import {
  actionBlockReason,
  actorLabel,
  formatActionTime,
  isolatedPods,
} from "../view/actionText.js";
import {
  STATUS_LABEL,
  formatDuration,
  formatMegabytes,
  formatMs,
} from "../view/podText.js";

export function IsolatedPage() {
  const { stream, namespace, now } = useShell();
  const list = stream.state?.list;
  const pods = isolatedPods(list?.pods ?? []);
  const showNamespace =
    namespace === undefined &&
    new Set(pods.map((item) => item.pod.namespace)).size > 1;

  // 삭제 서랍을 연 Pod입니다.
  const [deleting, setDeleting] = useState<PodRef | undefined>();
  const closeDrawer = useCallback(() => setDeleting(undefined), []);
  const deletingItem =
    deleting === undefined
      ? undefined
      : list?.pods.find(
          (item) =>
            item.pod.namespace === deleting.namespace &&
            item.pod.name === deleting.name,
        );

  return (
    <div className="space-y-5 px-6 py-8 lg:px-8">
      <header className="space-y-1">
        <h1 className="flex items-baseline gap-2 text-[22px] font-bold text-slate-900">
          격리된 Pod
          {list !== undefined && (
            <span className="text-xs font-normal text-slate-500">
              {pods.length}
            </span>
          )}
        </h1>
        <p className="text-[13px] text-slate-500">
          트래픽에서 뺀 Pod입니다. Deployment가 더 이상 관리하지 않으므로 조사가
          끝나면 직접 삭제합니다.
        </p>
      </header>

      {list === undefined ? (
        <p className="text-sm text-slate-500">서버에서 목록을 받는 중입니다.</p>
      ) : pods.length === 0 ? (
        <p className="rounded-xl border border-line bg-white px-5 py-5 text-sm text-slate-600">
          격리된 Pod가 없습니다.
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {pods.map((item) => (
              <li key={`${item.pod.namespace}/${item.pod.name}`}>
                <IsolatedCard
                  item={item}
                  now={now}
                  namespace={namespace}
                  showNamespace={showNamespace}
                  deleteBlocked={actionBlockReason(
                    "delete-pod",
                    item.pod,
                    item,
                    list.actionNamespaces,
                  )}
                  onDelete={() => setDeleting(item.pod)}
                />
              </li>
            ))}
          </ul>
          <p className="flex gap-2 rounded-xl border border-warning-line bg-warning-wash px-4 py-3 text-[13px] text-warning-ink">
            <AlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              삭제는 되돌릴 수 없습니다. 누르면 확인 창이 한 번 더 뜹니다.
            </span>
          </p>
        </>
      )}

      <p className="flex gap-2 rounded-xl bg-neutral-wash px-4 py-3 text-[13px] text-slate-600">
        <InfoIcon className="mt-0.5 size-4 shrink-0" />
        <span>
          Pod 상세에서 '트래픽에서 빼기'를 실행하면 여기에 나타납니다.
        </span>
      </p>

      {deleting !== undefined && (
        <DeleteDrawer
          key={`${deleting.namespace}/${deleting.name}`}
          pod={deleting}
          item={deletingItem}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

function IsolatedCard({
  item,
  now,
  namespace,
  showNamespace,
  deleteBlocked,
  onDelete,
}: {
  item: PodItem;
  now: number;
  namespace: string | undefined;
  showNamespace: boolean;
  deleteBlocked: string | undefined;
  onDelete: () => void;
}) {
  const isolation = item.kube?.isolation;
  const { metrics } = item;
  return (
    <article className="space-y-3 rounded-xl border border-line bg-white px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <IsolatedBadge />
          <h2 className="font-mono text-sm break-all text-slate-900">
            {showNamespace && (
              <span className="text-slate-400">{item.pod.namespace}/</span>
            )}
            {item.pod.name}
          </h2>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            to={podLink(item.pod, namespace)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-deep-teal hover:bg-mist"
          >
            <ChevronRightIcon className="size-4" />
            상세 보기
          </Link>
          <button
            type="button"
            disabled={deleteBlocked !== undefined}
            title={deleteBlocked}
            onClick={onDelete}
            className="inline-flex items-center gap-1.5 rounded-lg border border-warning-line bg-white px-3 py-1.5 text-sm font-medium text-warning-ink hover:bg-warning-wash disabled:cursor-not-allowed disabled:opacity-45"
          >
            <TrashIcon className="size-4" />
            삭제
          </button>
        </div>
      </div>

      <dl className="flex flex-wrap gap-2 text-xs">
        <Chip label="원래 Deployment">{isolation?.deployment ?? "—"}</Chip>
        <Chip label="격리한 때">
          {isolation?.at === undefined
            ? "—"
            : `${formatActionTime(isolation.at, now)} (${formatDuration(Math.max(0, now - isolation.at))} 전)`}
        </Chip>
        <Chip label="격리할 때 판단">
          {isolation?.status === undefined
            ? "—"
            : STATUS_LABEL[isolation.status]}
        </Chip>
        <Chip label="실행">
          {isolation?.actor === undefined ? "—" : actorLabel(isolation.actor)}
        </Chip>
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-slate-600">지금</span>
        <StatusBadge status={item.status} />
        {item.kube?.terminating === true && (
          <span className="text-xs text-slate-500">지워지는 중입니다</span>
        )}
        {item.sdk !== undefined && (
          <dl className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:grid-cols-[repeat(3,7.5rem)]">
            <Metric label="루프 p99" value={formatMs(metrics.eventLoopP99Ms)} />
            <Metric label="힙" value={formatMegabytes(metrics.heapUsedBytes)} />
            <Metric label="요청 p99" value={formatMs(metrics.httpP99Ms)} />
          </dl>
        )}
      </div>
      <p className="text-xs text-slate-500">
        {item.sdk === undefined
          ? "이 Pod에는 SDK가 없어 앱 지표가 없습니다."
          : "새 요청이 없으면 요청 p99는 마지막으로 받은 값에 머뭅니다. 지표와 snapshot은 계속 받습니다."}
      </p>
    </article>
  );
}

function Chip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-tab px-2 py-1">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-semibold text-slate-800">{children}</dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-white px-2 py-1.5">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="font-mono text-xs text-slate-800">{value}</dd>
    </div>
  );
}
