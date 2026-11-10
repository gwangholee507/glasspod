// 개발자가 정한 상태 값입니다(design.md 7.3 event의 state, docs/guides/T06.md 결정 15).
// 값이 바뀔 때만 state 이벤트를 만들고, 지금 값은 T09 snapshot의 state로 돌려줍니다.
import type { EventContent } from "./events.js";
import type { WarnOnce } from "./log.js";
import { APP_NAME_RULE, isAppName, quote } from "./registry.js";

// 정할 수 있는 상태 수와 값의 길이입니다.
export const MAX_STATES = 100;
export const MAX_STATE_VALUE_CHARS = 200;

export class StateStore {
  // Map은 넣은 순서대로 돌므로 처음 정한 순서대로 돌려줍니다.
  private readonly values = new Map<string, string>();
  private readonly warnings: WarnOnce;

  constructor(warnings: WarnOnce) {
    this.warnings = warnings;
  }

  // 값을 정합니다. 바뀌었으면 보낼 state 이벤트 내용을, 같거나 문제가 있으면 undefined를 돌려줍니다.
  set(name: unknown, value: unknown): EventContent | undefined {
    if (!isAppName(name)) {
      this.warnings.warn(
        `state:${String(name)}:name`,
        `state ignored: ${quote(name)} ${APP_NAME_RULE}`,
      );
      return undefined;
    }
    if (typeof value !== "string" || value.length > MAX_STATE_VALUE_CHARS) {
      this.warnings.warn(
        `state:${name}:value`,
        `state ignored: "${name}": value must be a string of at most ${MAX_STATE_VALUE_CHARS} characters`,
      );
      return undefined;
    }
    const from = this.values.get(name);
    if (from === value) {
      return undefined;
    }
    if (from === undefined && this.values.size >= MAX_STATES) {
      this.warnings.warn(
        "state:limit",
        `state ignored: "${name}": at most ${MAX_STATES} states can be registered`,
      );
      return undefined;
    }
    this.values.set(name, value);
    if (from === undefined) {
      return {
        level: "info",
        name: "state",
        message: `${name}: ${value}`,
        data: { name, to: value },
      };
    }
    return {
      level: "info",
      name: "state",
      message: `${name}: ${from} -> ${value}`,
      data: { name, from, to: value },
    };
  }

  // 지금 상태 값입니다. 예: { "app.mode": "draining" }
  current(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}
