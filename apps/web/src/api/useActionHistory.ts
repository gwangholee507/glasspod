// 조치 기록을 받습니다(docs/guides/T21.md 결정 12, 19). 스트림이 목록 전체(pods)를 새로 받을 때마다(처음, 다시 붙음)
// GET /api/actions를 다시 부르고, 그 뒤 스트림으로 온 조치를 이어 붙입니다. 판단 변화 타임라인(T18 결정 18)과 같은 방식입니다.
import type { ActionItem, ActionsBody } from "@glasspod/protocol";
import { useEffect, useMemo, useState } from "react";
import { mergeActions } from "../view/actionText.js";
import { getActions } from "./actions.js";
import type { ApiResult } from "./client.js";

interface Fetched {
  namespace: string | undefined;
  result: ApiResult<ActionsBody>;
}

export interface ActionHistory {
  // 늦은 것부터입니다.
  actions: ActionItem[];
  // 지난 기록을 아직 받지 못했으면 true입니다.
  loading: boolean;
  // 지난 기록을 받지 못했을 때의 오류 코드입니다.
  error: string | undefined;
}

export function useActionHistory(
  namespace: string | undefined,
  opens: number,
  streamed: readonly ActionItem[],
): ActionHistory {
  const [fetched, setFetched] = useState<Fetched | undefined>(undefined);

  useEffect(() => {
    if (opens === 0) {
      return;
    }
    const controller = new AbortController();
    void getActions(namespace, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setFetched({ namespace, result });
      }
    });
    return () => controller.abort();
  }, [namespace, opens]);

  const current = fetched?.namespace === namespace ? fetched : undefined;
  const actions = useMemo(
    () =>
      mergeActions([
        current?.result.ok === true ? current.result.data.actions : [],
        streamed,
      ]),
    [current, streamed],
  );
  return {
    actions,
    loading: current === undefined,
    error: current?.result.ok === false ? current.result.error : undefined,
  };
}
