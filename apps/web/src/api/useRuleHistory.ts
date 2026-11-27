// 자동 규칙과 그 기록을 받습니다(docs/guides/T28.md 결정 18, 24). 조치 기록(useActionHistory)과 같은 방식으로,
// 스트림이 목록 전체(pods)를 새로 받을 때마다 GET /api/rules를 다시 부르고 그 뒤 스트림으로 온 기록을 이어 붙입니다.
// 규칙 보기(파일 상태와 규칙마다 지금 상태)는 GET의 것과 스트림의 것 가운데 서버 시각이 늦은 것을 씁니다.
import type { RuleFiring, RulesBody, RulesView } from "@glasspod/protocol";
import { useEffect, useMemo, useState } from "react";
import { mergeFirings } from "../view/ruleText.js";
import type { ApiResult } from "./client.js";
import type { PodStreamState } from "./podStream.js";
import { getRules } from "./rules.js";

interface Fetched {
  namespace: string | undefined;
  result: ApiResult<RulesBody>;
}

export interface RuleHistory {
  // 규칙 보기입니다. 아직 받지 못했으면 undefined입니다.
  view: RulesView | undefined;
  // 늦은 것부터입니다.
  firings: RuleFiring[];
  loading: boolean;
  error: string | undefined;
}

export function useRuleHistory(
  namespace: string | undefined,
  opens: number,
  state: PodStreamState | undefined,
): RuleHistory {
  const [fetched, setFetched] = useState<Fetched | undefined>(undefined);

  useEffect(() => {
    if (opens === 0) {
      return;
    }
    const controller = new AbortController();
    void getRules(namespace, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setFetched({ namespace, result });
      }
    });
    return () => controller.abort();
  }, [namespace, opens]);

  const current = fetched?.namespace === namespace ? fetched : undefined;
  const body = current?.result.ok === true ? current.result.data : undefined;
  const streamed = state?.ruleFirings;
  const firings = useMemo(
    () => mergeFirings([body?.firings ?? [], streamed ?? []]),
    [body, streamed],
  );
  const fromStream = state?.rules;
  const view =
    fromStream !== undefined &&
    (body === undefined || fromStream.serverTime >= body.serverTime)
      ? fromStream.view
      : body;
  return {
    view:
      view === undefined ? undefined : { file: view.file, rules: view.rules },
    firings,
    loading: current === undefined,
    error: current?.result.ok === false ? current.result.error : undefined,
  };
}
