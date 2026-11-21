// 조치 기록 화면과 상세의 조치 기록 칸이 함께 쓰는 작은 조각입니다(docs/guides/T21.md 결정 19, 20).
import type { ActionItem, ActionKind } from "@glasspod/protocol";
import { RotateIcon } from "../ui/icons.js";
import { ACTION_LABEL, RESULT_LABEL } from "../view/actionText.js";

// 조치 아이콘과 이름입니다.
export function ActionName({ action }: { action: ActionKind }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-slate-800">
      <RotateIcon className="size-4 text-deep-teal" />
      {ACTION_LABEL[action]}
    </span>
  );
}

// 결과 배지입니다. 성공은 정상 색, 실패는 위험 색(design.md 12장)입니다.
export function ResultBadge({ item }: { item: ActionItem }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${
        item.result === "succeeded"
          ? "bg-mist text-deep-teal"
          : "bg-coral text-critical-ink"
      }`}
    >
      {RESULT_LABEL[item.result]}
    </span>
  );
}
