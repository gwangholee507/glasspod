import type { PodItem, PodOutlier, PodStatusChange } from "@glasspod/protocol";
import { describe, expect, it } from "vitest";
import {
  changeSentence,
  formatClock,
  formatDuration,
  formatMegabytes,
  formatMs,
  formatOutlierValue,
  outlierLabel,
  outlierLine,
  outlierSentence,
  podSentence,
  statusTone,
  timeLabel,
} from "./podText.js";

const NOW = 10_000_000;

function item(fields: Partial<PodItem>): PodItem {
  return {
    pod: { namespace: "shop", name: "web-1" },
    status: "ok",
    severity: "none",
    since: NOW - 5_000,
    metrics: {},
    ...fields,
  };
}

function sdk(fields: Partial<NonNullable<PodItem["sdk"]>> = {}) {
  return {
    connected: true,
    instanceId: "i-1",
    sdk: "node@0.1.0",
    instanceSince: NOW - 600_000,
    connectedAt: NOW - 600_000,
    missed: 0,
    ...fields,
  };
}

function change(fields: Partial<PodStatusChange>): PodStatusChange {
  return {
    pod: { namespace: "shop", name: "web-1" },
    at: NOW,
    status: "ok",
    severity: "none",
    ...fields,
  };
}

describe("formatDuration", () => {
  it("초, 분, 시간·분, 일·시간으로 씀", () => {
    expect(formatDuration(-500)).toBe("0초");
    expect(formatDuration(999)).toBe("0초");
    expect(formatDuration(59_999)).toBe("59초");
    expect(formatDuration(60_000)).toBe("1분");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59분");
    expect(formatDuration(2 * 3_600_000)).toBe("2시간");
    expect(formatDuration(2 * 3_600_000 + 13 * 60_000)).toBe("2시간 13분");
    expect(formatDuration(24 * 3_600_000)).toBe("1일");
    expect(formatDuration(26 * 3_600_000 + 59 * 60_000)).toBe("1일 2시간");
  });
});

describe("formatClock", () => {
  it("브라우저 시간대의 두 자리 시:분:초", () => {
    expect(formatClock(new Date(2026, 10, 17, 9, 5, 7).getTime())).toBe(
      "09:05:07",
    );
    expect(formatClock(new Date(2026, 10, 17, 13, 53, 52).getTime())).toBe(
      "13:53:52",
    );
  });
});

describe("timeLabel", () => {
  it("위험·주의는 판단이 시작된 때부터 '전부터'", () => {
    expect(
      timeLabel(
        item({ status: "stalled", severity: "critical", since: NOW - 18_000 }),
        NOW,
      ),
    ).toBe("18초 전부터");
    expect(
      timeLabel(
        item({ status: "not-ready", severity: "warning", since: NOW - 3_000 }),
        NOW,
      ),
    ).toBe("3초 전부터");
  });

  it("재시작은 재시작한 때부터 '전'", () => {
    expect(
      timeLabel(
        item({
          status: "restarted",
          severity: "warning",
          since: NOW - 1_000,
          restart: { at: NOW - 14 * 60_000 },
        }),
        NOW,
      ),
    ).toBe("14분 전");
  });

  it("강조가 없으면 이어진 시간 'N째'", () => {
    expect(timeLabel(item({ since: NOW - 41 * 60_000 }), NOW)).toBe("41분째");
    expect(
      timeLabel(item({ status: "no-sdk", since: NOW - 7_980_000 }), NOW),
    ).toBe("2시간 13분째");
  });
});

describe("formatMs, formatMegabytes", () => {
  it("10ms 아래는 소수 한 자리, 그 밖은 쉼표 정수", () => {
    expect(formatMs(undefined)).toBe("—");
    expect(formatMs(0)).toBe("0.0 ms");
    expect(formatMs(3.24)).toBe("3.2 ms");
    expect(formatMs(16.4)).toBe("16 ms");
    expect(formatMs(2140.4)).toBe("2,140 ms");
  });

  it("MB는 1024² 바이트, 정수", () => {
    expect(formatMegabytes(undefined)).toBe("—");
    expect(formatMegabytes(88 * 1024 * 1024 + 300_000)).toBe("88 MB");
    expect(formatMegabytes(1536 * 1024 * 1024)).toBe("1,536 MB");
  });
});

describe("statusTone", () => {
  it("design.md 12장의 강조와 같음", () => {
    expect(statusTone("stalled")).toBe("critical");
    expect(statusTone("pod-failing")).toBe("critical");
    expect(statusTone("disconnected")).toBe("critical");
    expect(statusTone("restarted")).toBe("warning");
    expect(statusTone("not-ready")).toBe("warning");
    expect(statusTone("ok")).toBe("ok");
    expect(statusTone("starting")).toBe("neutral");
    expect(statusTone("no-sdk")).toBe("neutral");
    expect(statusTone("terminated")).toBe("neutral");
  });
});

describe("outliers", () => {
  function outlier(fields: Partial<PodOutlier>): PodOutlier {
    return {
      metric: "http.requests.duration_p99_ms",
      value: 1003.4,
      peerMedian: 30.9,
      peers: 2,
      since: NOW - 45_000,
      ...fields,
    };
  }

  it("formats each kind of value like the list cells", () => {
    expect(formatOutlierValue("runtime.event_loop.lag_p99_ms", 2140)).toBe(
      "2,140 ms",
    );
    expect(formatOutlierValue("http.requests.duration_p99_ms", 4.25)).toBe(
      "4.3 ms",
    );
    expect(
      formatOutlierValue("runtime.heap.used_bytes", 73 * 1024 * 1024),
    ).toBe("73 MB");
    expect(formatOutlierValue("http.requests.errors_total", 95)).toBe("95/분");
    expect(formatOutlierValue("event:error", 2999.6)).toBe("3,000/분");
    expect(formatOutlierValue("app.queue.length", 1234.56)).toBe("1,234.6");
    expect(outlierLabel("event:error")).toBe("예외");
    expect(outlierLabel("app.queue.length")).toBe("app.queue.length");
  });

  it("writes the list line and the detail sentence", () => {
    const outliers = [
      outlier({}),
      outlier({
        metric: "app.queue.length",
        value: 12,
        peerMedian: 0,
        peers: 1,
        since: NOW - 20_000,
      }),
    ];
    expect(outlierLine(outliers)).toBe(
      "다른 Pod보다 높음 · 요청 p99 1,003 ms (다른 Pod 31 ms) · app.queue.length 12 (다른 Pod 0)",
    );
    expect(outlierSentence(outliers, NOW)).toBe(
      "같은 Deployment의 다른 Pod 2개보다 높습니다: 요청 p99 1,003 ms (다른 Pod 중앙값 31 ms), app.queue.length 12 (다른 Pod 중앙값 0) · 45초째",
    );
    expect(outlierLine(undefined)).toBe(undefined);
    expect(outlierLine([])).toBe(undefined);
    expect(outlierSentence([], NOW)).toBe(undefined);
  });
});

describe("podSentence", () => {
  it("멈춤 의심은 마지막 metrics(없으면 연결 시각)부터 센 시간", () => {
    expect(
      podSentence(
        item({
          status: "stalled",
          severity: "critical",
          reason: "no-metrics",
          sdk: sdk({ lastMetricsAt: NOW - 18_000 }),
        }),
        NOW,
      ),
    ).toBe("metrics 18초째 없음 · 이벤트 루프 막힘 의심");
    expect(
      podSentence(
        item({
          status: "stalled",
          severity: "critical",
          sdk: sdk({ connectedAt: NOW - 16_000 }),
        }),
        NOW,
      ),
    ).toBe("metrics 16초째 없음 · 이벤트 루프 막힘 의심");
  });

  it("재시작은 쿠버네티스 종료 이유와 종료 코드, 없으면 새 instance", () => {
    expect(
      podSentence(
        item({
          status: "restarted",
          severity: "warning",
          reason: "OOMKilled",
          restart: { at: NOW - 60_000, reason: "OOMKilled", exitCode: 137 },
        }),
        NOW,
      ),
    ).toBe("OOMKilled (137)로 재시작");
    expect(
      podSentence(
        item({
          status: "restarted",
          severity: "warning",
          restart: { at: NOW - 60_000, previousInstanceId: "i-0" },
        }),
        NOW,
      ),
    ).toBe("새 instance로 다시 붙음");
  });

  it("다른 판단에 가려진 재시작을 뒤에 붙임", () => {
    expect(
      podSentence(
        item({
          status: "disconnected",
          severity: "critical",
          sdk: sdk({ connected: false, disconnectedAt: NOW - 4_000 }),
          restart: { at: NOW - 120_000, reason: "Error", exitCode: 1 },
        }),
        NOW,
      ),
    ).toBe("SDK 연결이 4초 전에 끊김 · 2분 전 재시작");
  });

  it("나머지 판단", () => {
    expect(podSentence(item({}), NOW)).toBe("이상 신호 없음");
    // 다른 Pod보다 높은 값이 있으면 '이상 신호 없음'이라 쓰지 않습니다(T34).
    expect(
      podSentence(
        item({
          outliers: [
            {
              metric: "app.queue.length",
              value: 12,
              peerMedian: 0,
              peers: 2,
              since: NOW,
            },
          ],
        }),
        NOW,
      ),
    ).toBe("연결과 쿠버네티스 상태는 정상");
    expect(podSentence(item({ status: "no-sdk" }), NOW)).toBe(
      "쿠버네티스 정보만 봄",
    );
    expect(
      podSentence(item({ status: "not-ready", severity: "warning" }), NOW),
    ).toBe("SDK는 정상 · 쿠버네티스 Ready 아님");
    expect(
      podSentence(
        item({ status: "starting", reason: "ContainerCreating" }),
        NOW,
      ),
    ).toBe("시작 중 (ContainerCreating)");
    expect(
      podSentence(
        item({
          status: "pod-failing",
          severity: "critical",
          reason: "CrashLoopBackOff",
        }),
        NOW,
      ),
    ).toBe("컨테이너를 띄우지 못함 (CrashLoopBackOff)");
    expect(
      podSentence(
        item({ status: "pod-failing", severity: "critical", reason: "Failed" }),
        NOW,
      ),
    ).toBe("Pod 실패 (Failed)");
    expect(
      podSentence(item({ status: "terminated", reason: "deleted" }), NOW),
    ).toBe("쿠버네티스에서 지워짐");
    expect(
      podSentence(item({ status: "terminated", reason: "terminating" }), NOW),
    ).toBe("Pod를 끝내는 중");
  });
});

describe("changeSentence", () => {
  it("판단 변화를 '~습니다' 문장으로", () => {
    expect(
      changeSentence(
        change({ status: "stalled", severity: "critical", previous: "ok" }),
      ),
    ).toBe("metrics가 3주기 동안 오지 않았습니다.");
    expect(
      changeSentence(
        change({
          status: "restarted",
          severity: "warning",
          reason: "OOMKilled",
          previous: "disconnected",
        }),
      ),
    ).toBe("Pod가 재시작했습니다. 쿠버네티스 종료 이유 OOMKilled.");
    expect(
      changeSentence(change({ status: "restarted", severity: "warning" })),
    ).toBe("새 instance로 다시 붙었습니다.");
    expect(changeSentence(change({ previous: "stalled" }))).toBe(
      "다시 정상입니다.",
    );
    expect(changeSentence(change({}))).toBe("이상 신호가 없습니다.");
    // 새 Pod가 처음 정상이 됨(docs/guides/T26.md)
    expect(changeSentence(change({ previous: "starting" }))).toBe(
      "이상 신호가 없습니다.",
    );
    expect(changeSentence(change({ previous: "no-sdk" }))).toBe(
      "이상 신호가 없습니다.",
    );
    expect(
      changeSentence(change({ status: "disconnected", severity: "critical" })),
    ).toBe("SDK 연결이 끊겼습니다.");
    expect(
      changeSentence(change({ status: "terminated", reason: "deleted" })),
    ).toBe("쿠버네티스에서 지워졌습니다.");
  });
});
