// 스케일 조정 서랍입니다(docs/guides/T24.md 결정 13, '서랍 문장'). 서랍을 연 때의 Deployment uid로 실행하고,
// replica 수를 고르면 '실행하면'·영향·경고를 다시 계산합니다. 실행을 누른 뒤에는 그때의 Deployment와 목록으로 고정합니다.
import type { DeploymentItem, PodItem, PodRef } from "@glasspod/protocol";
import { useId, useState } from "react";
import { runAction } from "../api/actions.js";
import { HexagonIcon, ScaleIcon } from "../ui/icons.js";
import {
  MAX_SCALE_REPLICAS,
  isReplicaCount,
  scalePlan,
} from "../view/actionText.js";
import { ActionDrawer } from "./ActionDrawer.js";
import type { DrawerPhase } from "./ActionDrawer.js";
import { ImpactRows } from "./ActionParts.js";
import type { ImpactExtra } from "./ActionParts.js";

// 숫자 칸의 글자를 replica 수로 읽습니다. 숫자만이 아니면 NaN입니다.
function parseReplicas(text: string): number {
  return /^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : NaN;
}

export function ScaleDrawer({
  target,
  deployment,
  pods,
  onClose,
}: {
  target: PodRef;
  // 지금 목록의 이 Deployment입니다. 지워져 목록에서 빠지면 undefined입니다.
  deployment: DeploymentItem | undefined;
  pods: readonly PodItem[];
  onClose: () => void;
}) {
  const inputId = useId();
  // 서랍을 연 때의 Deployment입니다. 이 uid로 실행합니다.
  const [opened] = useState(deployment);
  const [text, setText] = useState(String(deployment?.desired ?? 0));
  const [phase, setPhase] = useState<DrawerPhase>({ kind: "ready" });
  // 실행을 누른 때의 Deployment와 목록입니다. 실행 중과 성공한 뒤에는 이것으로 보입니다(지금 수가 바뀌어도 '3 → 5' 그대로).
  const [frozen, setFrozen] = useState<
    { deployment: DeploymentItem; pods: readonly PodItem[] } | undefined
  >(undefined);
  const locked = phase.kind === "running" || phase.kind === "succeeded";
  const to = parseReplicas(text);
  const valid = isReplicaCount(to);

  const shown =
    (locked ? frozen?.deployment : undefined) ?? deployment ?? opened;
  const shownPods = (locked ? frozen?.pods : undefined) ?? pods;
  const plan =
    shown === undefined || !valid ? undefined : scalePlan(shown, shownPods, to);

  const blocked =
    opened === undefined ||
    deployment === undefined ||
    deployment.uid !== opened.uid
      ? "대상이 바뀌었습니다. 서랍을 닫고 목록을 다시 봅니다."
      : !valid
        ? `replica 수는 0~${MAX_SCALE_REPLICAS} 사이의 정수로 고릅니다.`
        : to === deployment.desired
          ? "지금과 같은 수입니다."
          : undefined;

  const run = () => {
    if (opened === undefined || deployment === undefined || !valid) {
      return;
    }
    setFrozen({ deployment, pods });
    setPhase({ kind: "running" });
    void runAction({
      action: "scale-deployment",
      target: { namespace: target.namespace, name: target.name },
      expectedUid: opened.uid,
      replicas: to,
    }).then((result) => {
      setPhase(
        result.ok
          ? { kind: "succeeded", item: result.data.action }
          : {
              kind: "failed",
              status: result.status,
              error: result.error,
              detail: result.detail,
            },
      );
    });
  };

  const step = (delta: number) => {
    const base = valid ? to : (shown?.desired ?? 0);
    setText(String(Math.min(Math.max(base + delta, 0), MAX_SCALE_REPLICAS)));
  };

  const extra: ImpactExtra | undefined =
    plan === undefined
      ? undefined
      : plan.added > 0
        ? {
            status: "starting",
            label: `새 Pod ${plan.added}개`,
            note: "ReplicaSet이 만듭니다",
          }
        : plan.removed > 0
          ? {
              status: "terminated",
              label: `Pod ${plan.removed}개`,
              note: "쿠버네티스가 골라 지웁니다",
            }
          : undefined;

  const input = (
    <div>
      <label htmlFor={inputId} className="text-sm font-semibold text-slate-800">
        replica 수
      </label>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <StepButton
          label="하나 줄이기"
          disabled={locked || (valid && to <= 0)}
          onClick={() => step(-1)}
        >
          −
        </StepButton>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_SCALE_REPLICAS}
          step={1}
          value={text}
          disabled={locked}
          onChange={(event) => setText(event.target.value)}
          className="w-20 rounded-lg border border-line bg-white px-3 py-1.5 text-center font-mono text-base text-slate-900 focus:border-glass-cyan focus:outline-none disabled:bg-tab"
        />
        <StepButton
          label="하나 늘리기"
          disabled={locked || (valid && to >= MAX_SCALE_REPLICAS)}
          onClick={() => step(1)}
        >
          +
        </StepButton>
        <span className="text-[13px] text-slate-500">
          지금 {shown?.desired ?? "—"}개
          {valid && shown !== undefined && to !== shown.desired
            ? ` → ${to}개`
            : ""}
        </span>
      </div>
    </div>
  );

  return (
    <ActionDrawer
      title="스케일 조정"
      icon={<ScaleIcon className="size-4" />}
      targetName={target.name}
      targetKind="deployment"
      targetIcon={<HexagonIcon className="size-4" />}
      status={undefined}
      facts={[
        target.namespace,
        ...(shown === undefined
          ? []
          : [`지금 replica ${shown.desired} · 준비 ${shown.ready}`]),
      ]}
      input={input}
      steps={
        plan?.steps ?? [
          `replica 수를 0~${MAX_SCALE_REPLICAS} 사이의 정수로 고릅니다.`,
        ]
      }
      impactTitle="지금 이 Deployment의 Pod"
      impact={
        <ImpactRows
          rows={plan?.pods ?? []}
          extra={extra}
          empty="이 Deployment에 Pod가 없습니다."
        />
      }
      warnings={plan?.warnings ?? []}
      notice={
        plan?.notice ?? `replica 수는 0~${MAX_SCALE_REPLICAS}개로 고릅니다.`
      }
      confirmLabel={valid ? `${to}개로 조정` : "스케일 조정"}
      blocked={phase.kind === "running" ? undefined : blocked}
      phase={phase}
      onConfirm={run}
      onClose={onClose}
    />
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-lg border border-line bg-white text-lg text-deep-teal hover:bg-mist disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
