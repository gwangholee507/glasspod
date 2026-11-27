// 자동 규칙 파일을 읽습니다(docs/guides/T28.md 결정 1, 5~9). 규칙은 ConfigMap glasspod-rules의 rules.yaml이고,
// 서버 Pod에 볼륨으로 붙은 파일(GLASSPOD_RULES_FILE)을 5초마다 다시 읽어 글이 바뀌었을 때만 검증합니다.
// 틀린 파일(읽지 못함 포함)이면 이전 규칙을 그대로 쓰고 파일 상태에 오류를 남깁니다(D5).
import { readFile as readFileText } from "node:fs/promises";
import { load } from "js-yaml";
import { validateRulesFile } from "@glasspod/protocol";
import type {
  PodStatus,
  RuleAction,
  RuleActionSpec,
  RuleCondition,
  RuleConditionSpec,
  RuleDefinition,
  RulesFileState,
  RuleSpec,
  StatusConditionSpec,
} from "@glasspod/protocol";
import { log } from "./log.js";

// 파일을 다시 읽는 주기입니다(결정 1).
export const RULES_POLL_MS = 5_000;
// 규칙 파일의 크기 상한입니다(결정 8). ConfigMap 한 개는 1MiB까지지만 규칙 50개는 이보다 훨씬 작습니다.
export const MAX_RULES_FILE_BYTES = 64 * 1024;
// 시간 칸의 범위입니다(결정 7).
export const MAX_FOR_MS = 60 * 60_000;
export const MIN_COOLDOWN_MS = 30_000;
export const MAX_COOLDOWN_MS = 24 * 60 * 60_000;
// 화면과 로그에 남기는 오류 설명의 길이입니다.
const MAX_DETAIL_LENGTH = 300;

// 스키마의 판단 목록과 protocol의 PodStatus가 같은지 타입으로 확인합니다(둘 중 하나만 고치면 typecheck가 실패).
type SpecStatus = StatusConditionSpec["status"][number];
const statusesMatch: [SpecStatus, PodStatus] extends [PodStatus, SpecStatus]
  ? true
  : never = true;
void statusesMatch;

const UNIT_MS = { s: 1_000, m: 60_000, h: 60 * 60_000 } as const;

// '30s', '2m', '1h'를 ms로 바꿉니다. 모양이 틀리면 undefined입니다(스키마가 먼저 거름).
export function parseDuration(text: string): number | undefined {
  const match = /^([0-9]{1,5})(s|m|h)$/.exec(text);
  if (match === null) {
    return undefined;
  }
  const [, amount, unit] = match as unknown as [
    string,
    string,
    "s" | "m" | "h",
  ];
  return Number(amount) * UNIT_MS[unit];
}

export type RulesParse =
  { ok: true; rules: RuleDefinition[] } | { ok: false; detail: string };

function truncate(text: string): string {
  return text.length > MAX_DETAIL_LENGTH
    ? `${text.slice(0, MAX_DETAIL_LENGTH)}…`
    : text;
}

function conditionOf(spec: RuleConditionSpec, forMs: number): RuleCondition {
  if ("status" in spec) {
    return { signal: "status", statuses: [...spec.status], forMs };
  }
  if ("outlier" in spec) {
    return { signal: "outlier", metric: spec.outlier, forMs };
  }
  if ("above" in spec) {
    return {
      signal: "metric",
      metric: spec.metric,
      compare: "above",
      threshold: spec.above,
      forMs,
    };
  }
  return {
    signal: "metric",
    metric: spec.metric,
    compare: "below",
    threshold: spec.below,
    forMs,
  };
}

function actionOf(spec: RuleActionSpec): RuleAction {
  if ("restart" in spec) {
    return { kind: "restart" };
  }
  if ("isolate" in spec) {
    return { kind: "isolate" };
  }
  const { by, min, max } = spec.scale;
  return {
    kind: "scale",
    by,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

// 스키마를 지난 규칙 하나를 바꿉니다. 스키마로 할 수 없는 검사(시간 범위, min ≤ max)가 틀리면 설명을 돌려줍니다.
function definitionOf(spec: RuleSpec, index: number): RuleDefinition | string {
  const where = `rules/${index}`;
  const cooldownMs = parseDuration(spec.cooldown);
  if (
    cooldownMs === undefined ||
    cooldownMs < MIN_COOLDOWN_MS ||
    cooldownMs > MAX_COOLDOWN_MS
  ) {
    return `${where}/cooldown must be from 30s to 24h (got "${spec.cooldown}")`;
  }
  const when: RuleCondition[] = [];
  for (const [conditionIndex, condition] of spec.when.entries()) {
    const forMs = parseDuration(condition.for);
    if (forMs === undefined || forMs > MAX_FOR_MS) {
      return `${where}/when/${conditionIndex}/for must be from 0s to 1h (got "${condition.for}")`;
    }
    when.push(conditionOf(condition, forMs));
  }
  const action = actionOf(spec.action);
  if (
    action.kind === "scale" &&
    action.min !== undefined &&
    action.max !== undefined &&
    action.min > action.max
  ) {
    return `${where}/action/scale/min must not be greater than max`;
  }
  return {
    name: spec.name,
    mode: spec.mode ?? "off",
    ...(spec.description === undefined
      ? {}
      : { description: spec.description }),
    target: {
      namespace: spec.target.namespace,
      deployment: spec.target.deployment,
    },
    when,
    action,
    cooldownMs,
    ...(spec.maxPerHour === undefined ? {} : { maxPerHour: spec.maxPerHour }),
  };
}

// 규칙 파일의 글을 읽어 검증합니다(결정 5~8). YAML은 1.2 Core schema이고 별칭(*ref)은 받지 않습니다.
export function parseRulesText(text: string): RulesParse {
  if (Buffer.byteLength(text, "utf8") > MAX_RULES_FILE_BYTES) {
    return {
      ok: false,
      detail: `the rules file is larger than ${MAX_RULES_FILE_BYTES} bytes`,
    };
  }
  if (text.trim() === "") {
    return {
      ok: false,
      detail: "the rules file is empty (write `rules: []` for no rules)",
    };
  }
  let value: unknown;
  try {
    value = load(text, { maxAliases: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // js-yaml은 둘째 줄부터 문제의 줄을 그려 보이므로 첫 줄만 남깁니다.
    return {
      ok: false,
      detail: truncate(`yaml: ${message.split("\n")[0] ?? message}`),
    };
  }
  const validated = validateRulesFile(value);
  if (!validated.ok) {
    return { ok: false, detail: truncate(validated.error) };
  }
  const rules: RuleDefinition[] = [];
  const names = new Set<string>();
  for (const [index, spec] of validated.message.rules.entries()) {
    if (names.has(spec.name)) {
      return {
        ok: false,
        detail: `rules/${index}/name "${spec.name}" is used by another rule`,
      };
    }
    names.add(spec.name);
    const definition = definitionOf(spec, index);
    if (typeof definition === "string") {
      return { ok: false, detail: definition };
    }
    rules.push(definition);
  }
  return { ok: true, rules };
}

export interface RulesSourceOptions {
  // GLASSPOD_RULES_FILE입니다. 없으면 규칙이 꺼져 있습니다.
  path: string | undefined;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
}

// 규칙 파일을 들고 있습니다. check()가 파일을 읽어 바뀌었으면 규칙을 바꿉니다(start()는 주기마다 check()).
export class RulesSource {
  private readonly path: string | undefined;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly now: () => number;
  private current: readonly RuleDefinition[] = [];
  private loadedAt: number | undefined;
  private error: { at: number; detail: string } | undefined;
  // 마지막으로 읽은 글입니다(받아들였든 아니든). 같은 글이면 다시 검증하지 않습니다.
  private lastText: string | undefined;
  private checking = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  // 규칙을 받아들일 때마다 늡니다. 규칙 엔진이 바뀐 것을 알아챕니다.
  private revision = 0;

  constructor(options: RulesSourceOptions) {
    this.path = options.path;
    this.readFile =
      options.readFile ?? ((path) => readFileText(path, { encoding: "utf8" }));
    this.now = options.now ?? Date.now;
  }

  get rules(): readonly RuleDefinition[] {
    return this.current;
  }

  get version(): number {
    return this.revision;
  }

  get state(): RulesFileState {
    return {
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.loadedAt === undefined ? {} : { loadedAt: this.loadedAt }),
      ...(this.error === undefined ? {} : { error: { ...this.error } }),
    };
  }

  // 파일을 한 번 읽습니다. 앞 읽기가 끝나지 않았으면 건너뜁니다.
  async check(): Promise<void> {
    if (this.path === undefined || this.checking) {
      return;
    }
    this.checking = true;
    try {
      let text: string;
      try {
        text = await this.readFile(this.path);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        this.fail(
          undefined,
          code === "ENOENT"
            ? `the rules file does not exist: ${this.path}`
            : `the rules file could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (text === this.lastText) {
        return;
      }
      const parsed = parseRulesText(text);
      if (!parsed.ok) {
        this.fail(text, parsed.detail);
        return;
      }
      this.lastText = text;
      this.current = parsed.rules;
      this.loadedAt = this.now();
      this.error = undefined;
      this.revision += 1;
      log.info("rules loaded", {
        path: this.path,
        rules: parsed.rules.length,
        notify: parsed.rules.filter((rule) => rule.mode === "notify").length,
        auto: parsed.rules.filter((rule) => rule.mode === "auto").length,
      });
    } finally {
      this.checking = false;
    }
  }

  // 처음 한 번 바로 읽고, 그 뒤 intervalMs마다 읽습니다. 타이머는 서버 종료를 막지 않습니다.
  start(intervalMs = RULES_POLL_MS): void {
    if (this.path === undefined) {
      log.info("rules disabled", { detail: "GLASSPOD_RULES_FILE is not set" });
      return;
    }
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // 틀린 파일입니다. 이전 규칙을 그대로 두고, 같은 설명이면 로그를 다시 남기지 않습니다.
  private fail(text: string | undefined, detail: string): void {
    this.lastText = text;
    if (this.error?.detail === detail) {
      return;
    }
    this.error = { at: this.now(), detail };
    log.warn("rules invalid", {
      path: this.path,
      detail,
      kept: this.current.length,
    });
  }
}
