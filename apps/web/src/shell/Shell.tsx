// 분할 화면 틀입니다: 왼쪽 메뉴 · 가운데 Pod 목록 · 오른쪽 자리(Outlet)(design.md 5.3, docs/guides/T18.md 결정 4~6, 23).
// SSE 스트림과 서버 시계를 여기서 하나만 두고 세 칸이 함께 씁니다. 주소가 바뀌어도 왼쪽과 가운데는 그대로입니다.
// 조치 기록(/actions)과 격리된 Pod(/isolated)는 가운데 목록 칸을 감추고 넓게 씁니다(docs/guides/T21.md 결정 19, T23 결정 18).
import type { PodRef } from "@glasspod/protocol";
import { Outlet, useMatch, useSearchParams } from "react-router";
import { usePodStream } from "../api/podStream.js";
import { useServerClock } from "../api/useServerClock.js";
import { isIsolated, isNamespaceName } from "../view/podView.js";
import { PodListPane } from "./PodListPane.js";
import { ACTIONS_PATH, ISOLATED_PATH } from "./shellContext.js";
import type { ShellContext } from "./shellContext.js";
import { Sidebar } from "./Sidebar.js";

export function Shell() {
  const [searchParams, setSearchParams] = useSearchParams();
  // DNS-1123 이름이 아니면 없는 것으로 봅니다. 서버가 400으로 답할 값을 보내지 않습니다(결정 6).
  const raw = searchParams.get("namespace");
  const namespace = raw !== null && isNamespaceName(raw) ? raw : undefined;

  const stream = usePodStream(namespace);
  const list = stream.state?.list;
  const clock = useServerClock(list?.serverTime);

  const match = useMatch("/pods/:namespace/:name");
  const onActions = useMatch(ACTIONS_PATH) !== null;
  const onIsolated = useMatch(ISOLATED_PATH) !== null;
  const selected: PodRef | undefined =
    match?.params.namespace !== undefined && match.params.name !== undefined
      ? { namespace: match.params.namespace, name: match.params.name }
      : undefined;

  const context: ShellContext = { stream, namespace, now: clock.now };

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:flex-row lg:overflow-hidden">
      <Sidebar
        namespace={namespace}
        namespaces={list?.namespaces ?? []}
        onNamespaceChange={(next) =>
          setSearchParams(next === undefined ? {} : { namespace: next })
        }
        podCount={list?.pods.length}
        isolatedCount={list?.pods.filter(isIsolated).length}
        streamStatus={stream.status}
        sinceUpdateMs={clock.sinceUpdateMs}
        current={onActions ? "actions" : onIsolated ? "isolated" : "pods"}
      />
      {!onActions && !onIsolated && (
        <PodListPane
          list={list}
          streamStatus={stream.status}
          sinceUpdateMs={clock.sinceUpdateMs}
          now={clock.now}
          namespace={namespace}
          selected={selected}
        />
      )}
      <main className="min-w-0 flex-1 bg-paper lg:overflow-y-auto">
        <Outlet context={context} />
      </main>
    </div>
  );
}
