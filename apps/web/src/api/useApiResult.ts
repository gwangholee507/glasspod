// API를 불러 결과를 화면 상태로 들고 있는 훅입니다(docs/guides/T17.md 결정 15).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ApiResult } from "./client.js";

export interface ApiState<T> {
  // 아직 한 번도 받지 못했으면 undefined입니다. 다시 부르는 동안에는 이전 결과를 그대로 둡니다.
  result: ApiResult<T> | undefined;
  loading: boolean;
  reload: () => void;
}

interface Loaded<T> {
  key: string;
  result: ApiResult<T> | undefined;
  loading: boolean;
}

// key가 바뀌거나 reload()를 부르면 load를 다시 부릅니다.
// 화면을 떠나거나 key가 바뀌면 진행 중인 요청을 취소하고, 늦게 온 결과는 버립니다.
// load는 실패해도 예외를 던지지 않아야 합니다(getJson처럼 결과로 돌려줌).
export function useApiResult<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<ApiResult<T>>,
): ApiState<T> {
  // 렌더마다 새로 만드는 load를 effect의 의존성에 넣지 않으려고 최신 값을 ref에 둡니다.
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });

  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<T>>({
    key,
    result: undefined,
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    setLoaded((previous) => ({
      key,
      result: previous.key === key ? previous.result : undefined,
      loading: true,
    }));
    void loadRef.current(controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setLoaded({ key, result, loading: false });
      }
    });
    return () => controller.abort();
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);

  // key가 바뀐 직후의 렌더에서는 이전 key의 결과를 보이지 않습니다.
  if (loaded.key !== key) {
    return { result: undefined, loading: true, reload };
  }
  return { result: loaded.result, loading: loaded.loading, reload };
}
