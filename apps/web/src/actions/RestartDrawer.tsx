// Pod 재시작 서랍입니다(docs/guides/T21.md 결정 9, 17). 서랍을 연 때의 Pod uid로 실행하고(결정 7),
// 트래픽을 받을 Pod와 경고는 화면이 받은 목록으로 계속 다시 계산합니다.
import type { PodItem, PodRef } from "@glasspod/protocol";
import { useState } from "react";
import { runAction } from "../api/actions.js";
import { RotateIcon } from "../ui/icons.js";
import { restartImpact } from "../view/actionText.js";
import { ActionDrawer } from "./ActionDrawer.js";
import type { DrawerPhase } from "./ActionDrawer.js";
import { ImpactList } from "./ActionParts.js";

export function RestartDrawer({
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
  // 실행을 누른 때의 목록입니다. 실행 중과 성공한 뒤에는 이것으로 영향을 보입니다(새 Pod가 '다른 Pod'로 끼어들지 않게).
  const [runPods, setRunPods] = useState<readonly PodItem[]>(pods);
  const uid = opened?.kube?.uid;
  const current = item ?? opened;

  const kube = item?.kube;
  const blocked =
    uid === undefined || kube === undefined || kube.uid !== uid
      ? "대상이 바뀌었습니다. 서랍을 닫고 목록을 다시 봅니다."
      : kube.terminating && phase.kind === "ready"
        ? "Pod가 이미 지워지는 중입니다."
        : undefined;

  // 대상의 ReplicaSet·Deployment는 서랍을 연 때의 것으로 봅니다. 지운 뒤에는 쿠버네티스 요약이 빠져
  // '컨트롤러가 없다'로 바뀌기 때문입니다. 다른 Pod는 지금 목록으로 계속 다시 계산합니다.
  const impactPods =
    phase.kind === "running" || phase.kind === "succeeded" ? runPods : pods;
  const impact =
    opened === undefined ? undefined : restartImpact(opened, impactPods);

  const run = () => {
    if (uid === undefined) {
      return;
    }
    setRunPods(pods);
    setPhase({ kind: "running" });
    void runAction({
      action: "restart-pod",
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

  const steps = [
    "Pod를 지웁니다. 앱은 종료 신호(SIGTERM)를 받고 유예 시간 안에 끝납니다.",
    ...(impact?.replicaSet === undefined
      ? []
      : [`ReplicaSet ${impact.replicaSet}이 대신할 새 Pod를 만듭니다.`]),
    "지운 Pod의 기록은 이 화면에 30분 남습니다.",
  ];

  return (
    <ActionDrawer
      title="Pod 재시작"
      icon={<RotateIcon className="size-4" />}
      pod={pod}
      status={current?.status}
      facts={[
        pod.namespace,
        ...(current?.deployment === undefined
          ? []
          : [`Deployment ${current.deployment}`]),
      ]}
      steps={steps}
      impactTitle="재시작하는 동안 트래픽을 받는 Pod"
      impact={<ImpactList impact={impact} />}
      warnings={impact?.warnings ?? []}
      notice="Pod를 지우면 메모리 상태와 처리 중이던 요청이 사라집니다. 원인을 조사하려면 먼저 snapshot을 받아 둡니다."
      confirmLabel="재시작"
      blocked={phase.kind === "running" ? undefined : blocked}
      phase={phase}
      onConfirm={run}
      onClose={onClose}
    />
  );
}
