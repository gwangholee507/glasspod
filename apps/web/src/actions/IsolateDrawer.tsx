// 트래픽에서 빼기 서랍입니다(docs/guides/T23.md 결정 3, 15). 열 때 서버에 계획(뗄 라벨, 빠질 Service)을 묻고,
// 서랍을 연 때의 Pod uid로 실행합니다. 트래픽을 받을 Pod와 경고는 화면이 받은 목록으로 계속 다시 계산합니다.
import type { IsolationPlanBody, PodItem, PodRef } from "@glasspod/protocol";
import { useEffect, useState } from "react";
import { getIsolationPlan, runAction } from "../api/actions.js";
import type { ApiResult } from "../api/client.js";
import { IsolateIcon } from "../ui/icons.js";
import {
  errorSentence,
  isolateSteps,
  restartImpact,
} from "../view/actionText.js";
import { ActionDrawer } from "./ActionDrawer.js";
import type { DrawerPhase } from "./ActionDrawer.js";
import { ImpactList } from "./ActionParts.js";

export function IsolateDrawer({
  pod,
  item,
  pods,
  onClose,
}: {
  pod: PodRef;
  // 지금 목록의 이 Pod 항목입니다. 지워져 목록에서 빠지면 undefined입니다.
  item: PodItem | undefined;
  pods: readonly PodItem[];
  onClose: () => void;
}) {
  // 서랍을 연 때의 항목입니다. 이 uid로 실행합니다.
  const [opened] = useState(item);
  const [phase, setPhase] = useState<DrawerPhase>({ kind: "ready" });
  const [plan, setPlan] = useState<ApiResult<IsolationPlanBody>>();
  // 실행을 누른 때의 목록입니다. 실행 중과 성공한 뒤에는 이것으로 영향을 보입니다(새 Pod가 '다른 Pod'로 끼어들지 않게).
  const [runPods, setRunPods] = useState<readonly PodItem[]>(pods);
  const uid = opened?.kube?.uid;
  const current = item ?? opened;

  // 열 때 한 번 계획을 묻습니다. 닫으면 기다리던 요청을 끊습니다.
  useEffect(() => {
    const controller = new AbortController();
    void getIsolationPlan(pod, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setPlan(result);
      }
    });
    return () => controller.abort();
  }, [pod]);

  const kube = item?.kube;
  const planBody = plan?.ok === true ? plan.data : undefined;
  const changed = "대상이 바뀌었습니다. 서랍을 닫고 목록을 다시 봅니다.";
  // 실행 중이거나 성공한 뒤에는 이유를 보이지 않습니다. 실패한 뒤에는 다시 시도할 수 있는지 봅니다.
  const blocked =
    phase.kind === "running" || phase.kind === "succeeded"
      ? undefined
      : uid === undefined || kube === undefined || kube.uid !== uid
        ? changed
        : kube.terminating
          ? "Pod가 이미 지워지는 중입니다."
          : kube.isolation !== undefined
            ? "이미 트래픽에서 뺀 Pod입니다."
            : plan === undefined
              ? "서버에서 뗄 라벨을 확인하는 중입니다."
              : !plan.ok
                ? `${errorSentence(plan.error)} (${plan.detail})`
                : plan.data.uid !== uid
                  ? changed
                  : undefined;

  // 대상의 ReplicaSet·Deployment는 서랍을 연 때의 것으로 봅니다. 빼고 나면 ReplicaSet이 놓아주어 바뀌기 때문입니다.
  const impactPods =
    phase.kind === "running" || phase.kind === "succeeded" ? runPods : pods;
  const impact =
    opened === undefined
      ? undefined
      : restartImpact(opened, impactPods, "isolate-pod");

  const run = () => {
    if (uid === undefined) {
      return;
    }
    setRunPods(pods);
    setPhase({ kind: "running" });
    void runAction({
      action: "isolate-pod",
      target: { namespace: pod.namespace, name: pod.name },
      expectedUid: uid,
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

  return (
    <ActionDrawer
      title="트래픽에서 빼기"
      icon={<IsolateIcon className="size-4" />}
      targetName={pod.name}
      status={current?.status}
      facts={[
        pod.namespace,
        ...(opened?.deployment === undefined
          ? []
          : [`Deployment ${opened.deployment}`]),
      ]}
      steps={isolateSteps(planBody?.plan)}
      impactTitle="빼고 나면 트래픽을 받는 Pod"
      impact={<ImpactList impact={impact} />}
      warnings={impact?.warnings ?? []}
      notice="격리된 Pod는 Deployment가 관리하지 않습니다. 조사가 끝나면 왼쪽 메뉴의 격리된 Pod에서 지웁니다."
      confirmLabel="트래픽에서 빼기"
      blocked={blocked}
      phase={phase}
      onConfirm={run}
      onClose={onClose}
    />
  );
}
