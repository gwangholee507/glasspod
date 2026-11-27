import type { RuleFiring, RuleItem } from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import {
  conditionText,
  conditionValueText,
  firingSentence,
  firingTone,
  matchText,
  mergeFirings,
  ruleActionText,
  ruleDuration,
  ruleLimitsText,
  ruleStateText,
} from "./ruleText.js";

const NOW = 1_000_000;

function firing(fields: Partial<RuleFiring> = {}): RuleFiring {
  return {
    id: "f1",
    rule: "slow-pod-isolate",
    mode: "notify",
    at: NOW - 5_000,
    action: "isolate-pod",
    target: { kind: "pod", namespace: "shop", name: "orders-1", uid: "u" },
    pod: { namespace: "shop", name: "orders-1" },
    deployment: "orders",
    conditions: [
      {
        condition: {
          signal: "outlier",
          metric: "http.requests.duration_p99_ms",
          forMs: 30_000,
        },
        since: NOW - 40_000,
        value: 1003,
        peerMedian: 31,
      },
    ],
    outcome: "notified",
    ...fields,
  };
}

function rule(fields: Partial<RuleItem> = {}): RuleItem {
  return {
    name: "slow-pod-isolate",
    mode: "notify",
    target: { namespace: "shop", deployment: "orders" },
    when: [],
    action: { kind: "isolate" },
    cooldownMs: 600_000,
    state: { matching: [], firedLastHour: 0 },
    notes: [],
    ...fields,
  };
}

describe("ruleDuration", () => {
  it("keeps the unit the rule was written in", () => {
    expect(ruleDuration(0)).toBe("");
    expect(ruleDuration(90_000)).toBe("90초");
    expect(ruleDuration(120_000)).toBe("2분");
    expect(ruleDuration(3_600_000)).toBe("1시간");
  });
});

describe("conditionText and ruleActionText", () => {
  it("writes each signal", () => {
    expect(
      conditionText({
        signal: "status",
        statuses: ["stalled", "disconnected"],
        forMs: 30_000,
      }),
    ).toBe("판단 앱 멈춤 의심 또는 연결 끊김 · 30초 이어짐");
    expect(
      conditionText({
        signal: "outlier",
        metric: "http.requests.duration_p99_ms",
        forMs: 0,
      }),
    ).toBe("다른 Pod보다 높음: 요청 p99");
    expect(
      conditionText({
        signal: "metric",
        metric: "app.queue.length",
        compare: "above",
        threshold: 1000,
        forMs: 120_000,
      }),
    ).toBe("app.queue.length > 1,000 · 2분 이어짐");
    expect(
      conditionText({
        signal: "metric",
        metric: "event:error",
        compare: "below",
        threshold: 1,
        forMs: 0,
      }),
    ).toBe("예외 < 1/분");
  });

  it("writes the action and its limits", () => {
    expect(ruleActionText({ kind: "restart" })).toBe("조건이 맞은 Pod 재시작");
    expect(ruleActionText({ kind: "scale", by: 1, max: 5 })).toBe(
      "replica +1 (최대 5개)",
    );
    expect(ruleActionText({ kind: "scale", by: -2, min: 2 })).toBe(
      "replica -2 (최소 2개)",
    );
    expect(ruleLimitsText(rule({ maxPerHour: 2 }))).toBe(
      "10분 쉼 · 시간당 2번까지",
    );
  });
});

describe("ruleStateText and matchText", () => {
  it("says off, running, cooling or how many pods match", () => {
    expect(ruleStateText(rule({ mode: "off" }), NOW)).toBe(
      "꺼져 있어 보지 않습니다.",
    );
    expect(
      ruleStateText(
        rule({ state: { matching: [], firedLastHour: 1, running: true } }),
        NOW,
      ),
    ).toBe("자동 조치를 실행하는 중입니다.");
    expect(
      ruleStateText(
        rule({
          state: { matching: [], firedLastHour: 1, coolingUntil: NOW + 90_000 },
        }),
        NOW,
      ),
    ).toBe("쉬는 중입니다(1분 남음).");
    expect(ruleStateText(rule(), NOW)).toBe("조건이 맞는 Pod가 없습니다.");
  });

  it("counts up from since and down to readyAt", () => {
    expect(matchText({ since: NOW - 12_000, readyAt: NOW + 18_000 }, NOW)).toBe(
      "12초째 · 18초 뒤 발동",
    );
    expect(matchText({ since: NOW - 9_000, readyAt: NOW + 400 }, NOW)).toBe(
      "9초째 · 1초 뒤 발동",
    );
    expect(matchText({ since: NOW - 40_000, readyAt: NOW - 10_000 }, NOW)).toBe(
      "40초째 · 조건을 채움",
    );
  });
});

describe("firingSentence", () => {
  it("says what would have run, what ran and why it skipped", () => {
    expect(firingSentence(firing())).toBe(
      "알림만이라 실행하지 않았습니다. 자동이었으면 트래픽에서 뺐을 것입니다.",
    );
    expect(
      firingSentence(
        firing({
          mode: "auto",
          outcome: "executed",
          actionResult: "succeeded",
        }),
      ),
    ).toBe("트래픽에서 뺐습니다.");
    expect(
      firingSentence(
        firing({
          action: "scale-deployment",
          outcome: "notified",
          scale: { from: 3, to: 4 },
        }),
      ),
    ).toBe(
      "알림만이라 실행하지 않았습니다. 자동이었으면 replica 수를 3개에서 4개로 바꿨을 것입니다.",
    );
    expect(
      firingSentence(
        firing({
          outcome: "skipped",
          skipReason: "too-few-healthy",
          healthy: 1,
          needed: 2,
        }),
      ),
    ).toBe(
      "건너뛰었습니다. 이 Pod를 빼면 건강한 Pod가 1개라 필요한 2개보다 적습니다.",
    );
    expect(
      firingSentence(
        firing({
          mode: "auto",
          outcome: "executed",
          actionResult: "failed",
          actionError: "action-not-allowed",
        }),
      ),
    ).toBe(
      "실행했지만 실패했습니다. 이 namespace는 조치가 꺼져 있습니다(GLASSPOD_ACTION_NAMESPACES).",
    );
  });

  it("colors skipped and failed firings as warnings", () => {
    expect(firingTone(firing())).toBe("neutral");
    expect(firingTone(firing({ outcome: "skipped" }))).toBe("warning");
    expect(
      firingTone(firing({ outcome: "executed", actionResult: "succeeded" })),
    ).toBe("ok");
    expect(
      firingTone(firing({ outcome: "executed", actionResult: "failed" })),
    ).toBe("warning");
  });

  it("writes the matched values", () => {
    expect(conditionValueText(firing().conditions[0]!)).toBe(
      "요청 p99 1,003 ms (다른 Pod 31 ms)",
    );
  });
});

describe("mergeFirings", () => {
  it("keeps one of each id, latest first", () => {
    expect(
      mergeFirings([
        [firing({ id: "a", at: 1 }), firing({ id: "b", at: 3 })],
        [firing({ id: "a", at: 1 }), firing({ id: "c", at: 2 })],
      ]).map((item) => item.id),
    ).toEqual(["b", "c", "a"]);
  });
});
