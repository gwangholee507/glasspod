// SDK 내부 오류가 앱으로 나가지 않게 막습니다(SDK 원칙).
// WebSocket 리스너와 타이머 콜백에서 난 예외는 처리되지 않은 예외가 되어 앱을 죽이므로, 모두 이 함수로 감쌉니다.
import { debug, describeError } from "./log.js";

export function guard(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    debug(`internal error: ${describeError(error)}`);
  }
}
