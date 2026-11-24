// 격리된 Pod 삭제 서랍입니다(docs/guides/T23.md 결정 2, 16). 시안 확정-4의 '누르면 확인 창이 한 번 더 뜹니다'입니다.
// 격리된 Pod는 이미 트래픽에서 빠져 있으므로 영향 칸이 없습니다. 서랍을 연 때의 Pod uid로 실행합니다.
import type { PodItem, PodRef } from "@glasspod/protocol";
import { useState } from "react";
import { runAction } from "../api/actions.js";
import { TrashIcon } from "../ui/icons.js";
import { ActionDrawer } from "./ActionDrawer.js";
import type { DrawerPhase } from "./ActionDrawer.js";

export function DeleteDrawer({
  pod,
  item,
  onClose,
}: {
  pod: PodRef;
  // 지금 목록의 이 Pod 항목입니다. 지워져 목록에서 빠지면 undefined입니다.
  item: PodItem | undefined;
  onClose: () => void;
}) {
  const [opened] = useState(item);
  const [phase, setPhase] = useState<DrawerPhase>({ kind: "ready" });
  const uid = opened?.kube?.uid;
  const current = item ?? opened;
  const kube = item?.kube;
  const original = opened?.kube?.isolation?.deployment;

  const blocked =
    phase.kind === "running" || phase.kind === "succeeded"
      ? undefined
      : uid === undefined || kube === undefined || kube.uid !== uid
        ? "대상이 바뀌었습니다. 서랍을 닫고 목록을 다시 봅니다."
        : kube.terminating
          ? "Pod가 이미 지워지는 중입니다."
          : kube.isolation === undefined
            ? "격리된 Pod만 지울 수 있습니다."
            : undefined;

  const run = () => {
    if (uid === undefined) {
      return;
    }
    setPhase({ kind: "running" });
    void runAction({
      action: "delete-pod",
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
      title="Pod 삭제"
      icon={<TrashIcon className="size-4" />}
      targetName={pod.name}
      status={current?.status}
      isolated
      facts={[
        pod.namespace,
        ...(original === undefined ? [] : [`원래 Deployment ${original}`]),
      ]}
      steps={[
        "Pod를 지웁니다. 앱은 종료 신호(SIGTERM)를 받고 유예 시간 안에 끝납니다.",
        "격리된 Pod라 다시 만들어지지 않습니다.",
        "지운 Pod의 기록은 이 화면에 30분 남습니다.",
      ]}
      warnings={["삭제는 되돌릴 수 없습니다."]}
      notice="원인을 더 보려면 지우기 전에 snapshot을 받아 둡니다."
      confirmLabel="삭제"
      blocked={blocked}
      phase={phase}
      onConfirm={run}
      onClose={onClose}
    />
  );
}
