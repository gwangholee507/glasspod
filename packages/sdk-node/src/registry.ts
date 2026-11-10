// 개발자가 등록하는 app.* 지표입니다(design.md 5.1, 7.3).
// gauge는 보낼 때마다 콜백을 불러 지금 값을 읽고, counter는 SDK가 누적값을 들고 있습니다.
// 등록 실수와 콜백 문제는 경고만 남기고 앱으로 예외를 던지지 않습니다(SDK 원칙).
import type { MetricValue } from "@glasspod/protocol";
import { debug, describeError, warn } from "./log.js";

// 스키마의 지표 이름 규칙(소문자·숫자·_, 두 단계 이상)에 app. 접두어를 더한 것입니다.
const APP_METRIC_NAME = /^app(\.[a-z][a-z0-9_]*)+$/;
// 등록할 수 있는 app.* 지표 수입니다. 요청마다 이름을 만드는 실수가 메모리와 메시지 크기를 늘리지 않게 합니다.
export const MAX_APP_METRICS = 100;

export interface Counter {
  // 누적값을 amount만큼 올립니다(기본 1). 0 이상의 유한한 수만 받습니다.
  inc(amount?: number): void;
}

interface GaugeEntry {
  kind: "gauge";
  read: () => unknown;
  // 이 이름의 콜백 문제를 경고로 남겼는지입니다. 이름마다 한 번만 남깁니다.
  warned: boolean;
}

interface CounterEntry {
  kind: "counter";
  value: number;
  counter: Counter;
  warned: boolean;
}

type Entry = GaugeEntry | CounterEntry;

// 이름이 잘못됐거나 상한을 넘었을 때 돌려주는 counter입니다. 앱 코드는 그대로 inc()를 불러도 됩니다.
const noopCounter: Counter = Object.freeze({ inc() {} });

export class Registry {
  // Map은 넣은 순서대로 돌므로 등록한 순서대로 보냅니다.
  private readonly entries = new Map<string, Entry>();
  private limitWarned = false;

  gauge(name: string, read: () => number): void {
    try {
      if (typeof read !== "function") {
        warn(
          `gauge ignored: ${quote(name)} needs a callback that returns a number`,
        );
        return;
      }
      const existing = this.entries.get(name);
      if (existing?.kind === "gauge") {
        existing.read = read;
        existing.warned = false;
        debug(`gauge ${name} replaced`);
        return;
      }
      if (!this.canAdd(name, existing)) {
        return;
      }
      this.entries.set(name, { kind: "gauge", read, warned: false });
    } catch (error) {
      debug(`gauge failed: ${describeError(error)}`);
    }
  }

  counter(name: string): Counter {
    try {
      const existing = this.entries.get(name);
      if (existing?.kind === "counter") {
        return existing.counter;
      }
      if (!this.canAdd(name, existing)) {
        return noopCounter;
      }
      const entry: CounterEntry = {
        kind: "counter",
        value: 0,
        counter: noopCounter,
        warned: false,
      };
      entry.counter = Object.freeze({
        inc: (amount: number = 1) => {
          try {
            if (
              typeof amount !== "number" ||
              !Number.isFinite(amount) ||
              amount < 0
            ) {
              warnOnce(
                entry,
                `counter "${name}" ignored inc(${String(amount)}): the amount must be a finite number >= 0`,
              );
              return;
            }
            entry.value += amount;
          } catch (error) {
            debug(`counter inc failed: ${describeError(error)}`);
          }
        },
      });
      this.entries.set(name, entry);
      return entry.counter;
    } catch (error) {
      debug(`counter failed: ${describeError(error)}`);
      return noopCounter;
    }
  }

  // 보낼 값을 모읍니다. gauge 콜백에 문제가 있으면 그 값만 뺍니다.
  collect(): MetricValue[] {
    const values: MetricValue[] = [];
    for (const [name, entry] of this.entries) {
      if (entry.kind === "counter") {
        values.push({ name, kind: "counter", value: entry.value });
        continue;
      }
      let value: unknown;
      try {
        value = entry.read();
      } catch (error) {
        warnOnce(
          entry,
          `gauge "${name}" skipped: callback threw (${describeError(error)})`,
        );
        continue;
      }
      // NaN과 Infinity는 JSON에서 null이 되어 스키마를 어기므로 보내지 않습니다.
      if (typeof value !== "number" || !Number.isFinite(value)) {
        warnOnce(
          entry,
          `gauge "${name}" skipped: callback returned ${describeValue(value)}, not a finite number`,
        );
        continue;
      }
      values.push({ name, kind: "gauge", value });
    }
    return values;
  }

  // 새 이름을 넣을 수 있는지 봅니다. 안 되면 이유를 경고로 남깁니다.
  private canAdd(name: string, existing: Entry | undefined): boolean {
    if (typeof name !== "string" || !APP_METRIC_NAME.test(name)) {
      warn(
        `metric ignored: ${quote(name)} must start with "app." and use lowercase letters, digits and _ in each level`,
      );
      return false;
    }
    if (existing !== undefined) {
      warn(
        `metric ignored: "${name}" is already registered as a ${existing.kind}`,
      );
      return false;
    }
    if (this.entries.size >= MAX_APP_METRICS) {
      if (!this.limitWarned) {
        this.limitWarned = true;
        warn(
          `metric ignored: "${name}": at most ${MAX_APP_METRICS} app metrics can be registered`,
        );
      } else {
        debug(`metric ignored: ${name} (limit reached)`);
      }
      return false;
    }
    return true;
  }
}

// 같은 문제는 이름마다 처음 한 번만 경고하고, 그 뒤로는 디버그 로그로 남깁니다.
function warnOnce(entry: Entry, message: string): void {
  if (entry.warned) {
    debug(message);
    return;
  }
  entry.warned = true;
  warn(message);
}

// 로그에 쓸 이름입니다. 문자열이 아니면 종류만 적습니다.
function quote(name: unknown): string {
  return typeof name === "string" ? JSON.stringify(name) : typeof name;
}

// 콜백이 돌려준 값을 로그에 쓸 짧은 말로 바꿉니다.
function describeValue(value: unknown): string {
  if (typeof value === "number") {
    return String(value);
  }
  if (value instanceof Promise) {
    return "a Promise";
  }
  if (value === null) {
    return "null";
  }
  return `a ${typeof value}`;
}
