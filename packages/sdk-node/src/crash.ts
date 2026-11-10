// 처리되지 않은 예외를 지켜봅니다(design.md 5.1, docs/guides/T06.md 결정 1, 10).
// uncaughtExceptionMonitor는 지켜보기만 하는 리스너라 앱의 종료 동작을 바꾸지 않습니다.
// 리스너가 끝나면 Node가 원래대로 오류를 출력하고 끝내므로, 기다리지 않고 그 자리에서 보냅니다.
// 처리되지 않은 Promise 거부도 Node 기본 모드(--unhandled-rejections=throw)에서는 여기로 옵니다.
import { guard } from "./guard.js";

export type CrashOrigin = NodeJS.UncaughtExceptionOrigin;

// fatal은 이 예외로 프로세스가 끝나는지입니다.
export type OnCrash = (
  error: unknown,
  origin: CrashOrigin,
  fatal: boolean,
) => void;

// 리스너를 달고, 떼는 함수를 돌려줍니다.
export function watchCrashes(onCrash: OnCrash): () => void {
  const listener = (error: unknown, origin: CrashOrigin): void => {
    // 여기서 난 예외는 원래 예외를 가리므로 모두 막습니다.
    guard(() => onCrash(error, origin, willExit()));
  };
  process.on("uncaughtExceptionMonitor", listener);
  return () => {
    process.off("uncaughtExceptionMonitor", listener);
  };
}

// 앱이 uncaughtException 리스너나 capture 콜백을 두었으면 프로세스는 살아남습니다.
function willExit(): boolean {
  return (
    process.listenerCount("uncaughtException") === 0 &&
    !process.hasUncaughtExceptionCaptureCallback()
  );
}
