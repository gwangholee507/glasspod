// 조치 확인 서랍의 틀입니다(design.md 5.3 '조치 버튼', Figma 확정-3, docs/guides/T21.md 결정 15, 16).
// 대상 카드, '실행하면', 영향, 경고, 안내, 실행 버튼은 모든 조치가 같고, 내용은 조치마다 넘깁니다.
// 대상은 Pod 또는 Deployment(스케일 조정)이고, 스케일 조정은 입력 칸(input)을 더 넘깁니다(docs/guides/T24.md 결정 17).
import type { ActionItem, ActionTarget, PodStatus } from "@glasspod/protocol";
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { AlertIcon, CloseIcon, InfoIcon } from "../ui/icons.js";
import { IsolatedBadge, StatusBadge } from "../ui/StatusBadge.js";
import {
  actionSentence,
  errorSentence,
  isUnknownOutcome,
} from "../view/actionText.js";

export type DrawerPhase =
  | { kind: "ready" }
  | { kind: "running" }
  | { kind: "succeeded"; item: ActionItem }
  | { kind: "failed"; status: number; error: string; detail: string };

export interface ActionDrawerProps {
  title: string;
  icon: ReactNode;
  // 대상 이름과 종류입니다. 종류는 실패 문장을 고릅니다(Deployment가 이미 지워져 있습니다 등).
  targetName: string;
  targetKind?: ActionTarget["kind"];
  // 판단 배지가 없는 대상(Deployment)의 아이콘입니다.
  targetIcon?: ReactNode;
  status: PodStatus | undefined;
  // 트래픽에서 뺀 Pod면 대상 카드에 '격리됨' 배지를 붙입니다(docs/guides/T23.md 결정 16).
  isolated?: boolean;
  // 대상 카드 아랫줄입니다(namespace · Deployment 등).
  facts: readonly string[];
  // '실행하면' 앞의 입력 칸입니다(스케일 조정의 replica 수).
  input?: ReactNode;
  // '실행하면' 단계입니다.
  steps: readonly string[];
  // 영향 칸입니다. 트래픽에 영향이 없는 조치(격리된 Pod 삭제)는 없습니다.
  impactTitle?: string;
  impact?: ReactNode;
  warnings: readonly string[];
  notice: string;
  confirmLabel: string;
  // 실행할 수 없는 이유입니다(대상이 바뀜 등). 있으면 실행 버튼을 끕니다.
  blocked: string | undefined;
  phase: DrawerPhase;
  onConfirm: () => void;
  onClose: () => void;
}

export function ActionDrawer({
  title,
  icon,
  targetName,
  targetKind = "pod",
  targetIcon,
  status,
  isolated = false,
  facts,
  input,
  steps,
  impactTitle,
  impact,
  warnings,
  notice,
  confirmLabel,
  blocked,
  phase,
  onConfirm,
  onClose,
}: ActionDrawerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const running = phase.kind === "running";

  // 열리면 닫기 버튼에 초점을 둡니다. Esc로 닫되 실행 중에는 닫지 않습니다.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, onClose]);

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="서랍 닫기"
        tabIndex={-1}
        onClick={running ? undefined : onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-slate-900/25"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-full flex-col bg-white shadow-2xl sm:w-[460px]"
      >
        <header className="flex items-center justify-between gap-3 px-6 pt-6">
          <h2
            id={titleId}
            className="flex items-center gap-2 text-lg font-bold text-slate-900"
          >
            <span className="text-deep-teal">{icon}</span>
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={running}
            aria-label="닫기"
            className="rounded-md p-1 text-slate-500 hover:bg-tab hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CloseIcon className="size-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="rounded-xl bg-tab px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              {targetIcon !== undefined && (
                <span className="text-glass-cyan">{targetIcon}</span>
              )}
              {status !== undefined && <StatusBadge status={status} />}
              {isolated && <IsolatedBadge />}
              <span className="font-mono text-sm break-all text-slate-900">
                {targetName}
              </span>
            </div>
            <p className="mt-1.5 text-[13px] text-slate-500">
              {facts.join(" · ")}
            </p>
          </div>

          {input}

          <div>
            <h3 className="text-sm font-semibold text-slate-800">실행하면</h3>
            <ol className="mt-2.5 space-y-2">
              {steps.map((step, index) => (
                <li key={index} className="flex gap-2.5 text-sm text-slate-700">
                  <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-mist text-xs font-semibold text-deep-teal">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>

          {impactTitle !== undefined && (
            <div>
              <h3 className="text-sm font-semibold text-slate-800">
                {impactTitle}
              </h3>
              <div className="mt-2.5">{impact}</div>
            </div>
          )}

          {warnings.map((warning) => (
            <p
              key={warning}
              className="flex gap-2 rounded-xl border border-warning-line bg-warning-wash px-4 py-3 text-[13px] text-warning-ink"
            >
              <AlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>{warning}</span>
            </p>
          ))}

          <p className="flex gap-2 rounded-xl bg-neutral-wash px-4 py-3 text-[13px] text-slate-600">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <span>{notice}</span>
          </p>
        </div>

        <footer className="space-y-2.5 border-t border-line px-6 py-5">
          <Outcome phase={phase} targetKind={targetKind} />
          {blocked !== undefined && phase.kind !== "succeeded" && (
            <p className="text-[13px] text-warning-ink">{blocked}</p>
          )}
          {phase.kind === "succeeded" ? (
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-deep-teal px-4 py-2.5 text-sm font-semibold text-white hover:bg-deep-teal/90"
            >
              닫기
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onConfirm}
                disabled={running || blocked !== undefined}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-deep-teal px-4 py-2.5 text-sm font-semibold text-white hover:bg-deep-teal/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {icon}
                {running
                  ? "실행하는 중입니다"
                  : phase.kind === "failed"
                    ? "다시 시도"
                    : confirmLabel}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={running}
                className="w-full rounded-lg border border-line bg-white px-4 py-2.5 text-sm font-medium text-deep-teal hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50"
              >
                취소
              </button>
            </>
          )}
          <p className="text-xs text-slate-500">
            실행하면 조치 기록에 남습니다.
          </p>
        </footer>
      </section>
    </div>
  );
}

function Outcome({
  phase,
  targetKind,
}: {
  phase: DrawerPhase;
  targetKind: ActionTarget["kind"];
}) {
  if (phase.kind === "succeeded") {
    return (
      <p
        role="status"
        className="rounded-lg bg-mist px-3 py-2 text-[13px] text-deep-teal"
      >
        <span className="font-semibold">성공</span> ·{" "}
        {actionSentence(phase.item)}
      </p>
    );
  }
  if (phase.kind === "failed") {
    return (
      <div
        role="alert"
        className="space-y-1 rounded-lg bg-warning-wash px-3 py-2 text-[13px] text-warning-ink"
      >
        <p>
          <span className="font-semibold">실패</span> ·{" "}
          {phase.status > 0 ? `HTTP ${phase.status} · ` : ""}
          {errorSentence(phase.error, targetKind)}
          {isUnknownOutcome(phase.error) &&
            " 실행됐는지 조치 기록에서 확인합니다."}
        </p>
        <p className="font-mono text-xs break-words opacity-80">
          {phase.detail}
        </p>
      </div>
    );
  }
  return null;
}
