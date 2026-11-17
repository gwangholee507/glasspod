// 화면의 '몇 초째'를 서버 시계로 세는 훅입니다(design.md 5.3, docs/guides/T18.md 결정 12).
// 본문의 serverTime을 받을 때 서버와 브라우저의 시계 차이를 재고, 1초마다 '지금(서버 시계)'을 다시 셉니다.
// SSE는 바뀐 것이 있을 때만 오므로, 판단이 그대로여도 시간이 흐르게 하려면 화면이 스스로 세야 합니다.
import { useEffect, useState } from "react";

const TICK_MS = 1_000;

interface Clock {
  // 서버 시계 - 브라우저 시계입니다.
  offsetMs: number;
  // 마지막으로 다시 그린 브라우저 시각입니다.
  tick: number;
  // serverTime을 마지막으로 받은 브라우저 시각입니다. 아직 없으면 undefined입니다.
  receivedAt: number | undefined;
}

export interface ServerClock {
  // 지금(서버 시계, epoch ms)입니다. 1초마다 바뀝니다.
  now: number;
  // 마지막으로 serverTime을 받은 지 얼마나 됐는지입니다. 아직 받지 않았으면 undefined입니다.
  sinceUpdateMs: number | undefined;
}

export function useServerClock(serverTime: number | undefined): ServerClock {
  const [clock, setClock] = useState<Clock>(() => ({
    offsetMs: 0,
    tick: Date.now(),
    receivedAt: undefined,
  }));

  // 새 serverTime을 받으면 그 순간의 '지금'이 serverTime과 같게 맞춥니다.
  useEffect(() => {
    if (serverTime === undefined) {
      return;
    }
    const local = Date.now();
    setClock({ offsetMs: serverTime - local, tick: local, receivedAt: local });
  }, [serverTime]);

  useEffect(() => {
    const timer = setInterval(() => {
      setClock((previous) => ({ ...previous, tick: Date.now() }));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return {
    now: clock.tick + clock.offsetMs,
    sinceUpdateMs:
      clock.receivedAt === undefined
        ? undefined
        : Math.max(0, clock.tick - clock.receivedAt),
  };
}
