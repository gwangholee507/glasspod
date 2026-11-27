import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RULES_FILE_BYTES,
  RulesSource,
  parseDuration,
  parseRulesText,
} from "./rules-file.js";

// deploy/server/rules.yaml의 데모 규칙과 같은 모양입니다(docs/guides/T28.md 결정 25).
const DEMO = `
rules:
  - name: slow-pod-isolate
    mode: notify
    description: 요청 p99가 다른 Pod보다 높으면 트래픽에서 뺍니다.
    target: { namespace: glasspod-demo, deployment: demo-app }
    when:
      - outlier: http.requests.duration_p99_ms
        for: 30s
    action: { isolate: {} }
    cooldown: 10m
    maxPerHour: 2
  - name: stalled-restart
    mode: notify
    target: { namespace: glasspod-demo, deployment: demo-app }
    when:
      - status: [stalled]
        for: 30s
    action: { restart: {} }
    cooldown: 10m
  - name: queue-scale
    mode: off
    target: { namespace: glasspod-demo, deployment: demo-app }
    when:
      - metric: app.queue.length
        above: 50
        for: 1m
      - metric: event:error
        below: 1
        for: 0s
    action: { scale: { by: 1, max: 5 } }
    cooldown: 10m
`;

function rule(fields: string): string {
  return `rules:
  - name: one
    target: { namespace: shop, deployment: orders }
    when:
      - status: [stalled]
        for: 30s
    action: { restart: {} }
${fields}`;
}

describe("parseDuration", () => {
  it("reads seconds, minutes and hours", () => {
    expect(parseDuration("0s")).toBe(0);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1.5m")).toBeUndefined();
    expect(parseDuration("10")).toBeUndefined();
  });
});

describe("parseRulesText", () => {
  it("reads the demo rules into ms and named fields", () => {
    const parsed = parseRulesText(DEMO);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rules.map((item) => item.name)).toEqual([
      "slow-pod-isolate",
      "stalled-restart",
      "queue-scale",
    ]);
    expect(parsed.rules[0]).toEqual({
      name: "slow-pod-isolate",
      mode: "notify",
      description: "요청 p99가 다른 Pod보다 높으면 트래픽에서 뺍니다.",
      target: { namespace: "glasspod-demo", deployment: "demo-app" },
      when: [
        {
          signal: "outlier",
          metric: "http.requests.duration_p99_ms",
          forMs: 30_000,
        },
      ],
      action: { kind: "isolate" },
      cooldownMs: 600_000,
      maxPerHour: 2,
    });
    // YAML 1.2에서 off는 문자열입니다(YAML 1.1처럼 false가 되지 않음).
    expect(parsed.rules[2]?.mode).toBe("off");
    expect(parsed.rules[2]?.when).toEqual([
      {
        signal: "metric",
        metric: "app.queue.length",
        compare: "above",
        threshold: 50,
        forMs: 60_000,
      },
      {
        signal: "metric",
        metric: "event:error",
        compare: "below",
        threshold: 1,
        forMs: 0,
      },
    ]);
    expect(parsed.rules[2]?.action).toEqual({ kind: "scale", by: 1, max: 5 });
  });

  it("uses off when the mode is left out", () => {
    const parsed = parseRulesText(rule("    cooldown: 1m\n"));
    expect(parsed.ok && parsed.rules[0]?.mode).toBe("off");
  });

  it("accepts an empty rule list", () => {
    expect(parseRulesText("rules: []\n")).toEqual({ ok: true, rules: [] });
  });

  it.each([
    ["an empty file", "", "empty"],
    ["broken YAML", "rules: [\n", "yaml:"],
    ["two documents", "rules: []\n---\nrules: []\n", "yaml:"],
    ["a duplicate key", "rules: []\nrules: []\n", "yaml:"],
    ["an alias", "a: &x 1\nrules: *x\n", "yaml:"],
    [
      "a misspelled field",
      rule("    cooldown: 1m\n    maxPerHuor: 2\n"),
      'rules/0 has an unknown field "maxPerHuor"',
    ],
    [
      "a short cooldown",
      rule("    cooldown: 10s\n"),
      "cooldown must be from 30s",
    ],
    [
      "a long cooldown",
      rule("    cooldown: 25h\n"),
      "cooldown must be from 30s",
    ],
  ])("rejects %s", (_name, text, detail) => {
    const parsed = parseRulesText(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.detail).toContain(detail);
  });

  it("rejects a condition longer than an hour", () => {
    const parsed = parseRulesText(
      rule("    cooldown: 1m\n").replace("for: 30s", "for: 61m"),
    );
    expect(parsed).toEqual({
      ok: false,
      detail: 'rules/0/when/0/for must be from 0s to 1h (got "61m")',
    });
  });

  it("rejects two rules with the same name", () => {
    const text = `${rule("    cooldown: 1m\n")}${rule("    cooldown: 1m\n").replace("rules:\n", "")}`;
    expect(parseRulesText(text)).toEqual({
      ok: false,
      detail: 'rules/1/name "one" is used by another rule',
    });
  });

  it("rejects min above max", () => {
    const parsed = parseRulesText(
      rule("    cooldown: 1m\n").replace(
        "{ restart: {} }",
        "{ scale: { by: 1, min: 5, max: 3 } }",
      ),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects a file over the size limit", () => {
    const parsed = parseRulesText(
      `rules: []\n#${"x".repeat(MAX_RULES_FILE_BYTES)}\n`,
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("RulesSource", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup(initial: string | Error) {
    const file = { content: initial as string | Error, reads: 0 };
    const clock = { now: 1_000 };
    const source = new RulesSource({
      path: "/etc/glasspod/rules/rules.yaml",
      readFile: async () => {
        file.reads += 1;
        if (file.content instanceof Error) {
          throw file.content;
        }
        return file.content;
      },
      now: () => clock.now,
    });
    return { file, clock, source };
  }

  it("is off without a path", async () => {
    const source = new RulesSource({ path: undefined });
    await source.check();
    expect(source.rules).toEqual([]);
    expect(source.state).toEqual({});
  });

  it("loads the rules and keeps them while the text stays the same", async () => {
    const { file, clock, source } = setup(DEMO);
    await source.check();
    expect(source.rules).toHaveLength(3);
    expect(source.version).toBe(1);
    expect(source.state).toEqual({
      path: "/etc/glasspod/rules/rules.yaml",
      loadedAt: 1_000,
    });
    clock.now = 6_000;
    await source.check();
    expect(file.reads).toBe(2);
    expect(source.version).toBe(1);
    expect(source.state.loadedAt).toBe(1_000);
  });

  it("keeps the previous rules when the new text is wrong", async () => {
    const { file, clock, source } = setup(DEMO);
    await source.check();
    file.content = "rules: [\n";
    clock.now = 6_000;
    await source.check();
    expect(source.rules).toHaveLength(3);
    expect(source.version).toBe(1);
    expect(source.state.loadedAt).toBe(1_000);
    expect(source.state.error?.at).toBe(6_000);
    expect(source.state.error?.detail).toContain("yaml:");
    // 같은 틀린 글은 다시 경고하지 않습니다.
    clock.now = 11_000;
    await source.check();
    expect(source.state.error?.at).toBe(6_000);
    expect(console.warn).toHaveBeenCalledTimes(1);
    // 고친 글을 받아들이면 오류가 없어집니다.
    file.content = "rules: []\n";
    clock.now = 16_000;
    await source.check();
    expect(source.rules).toEqual([]);
    expect(source.version).toBe(2);
    expect(source.state).toEqual({
      path: "/etc/glasspod/rules/rules.yaml",
      loadedAt: 16_000,
    });
  });

  it("starts with no rules when the first file is missing", async () => {
    const missing = Object.assign(new Error("no such file"), {
      code: "ENOENT",
    });
    const { file, source } = setup(missing);
    await source.check();
    expect(source.rules).toEqual([]);
    expect(source.state.loadedAt).toBeUndefined();
    expect(source.state.error?.detail).toBe(
      "the rules file does not exist: /etc/glasspod/rules/rules.yaml",
    );
    // 파일이 생기면 읽습니다.
    file.content = DEMO;
    await source.check();
    expect(source.rules).toHaveLength(3);
    expect(source.state.error).toBeUndefined();
  });
});
