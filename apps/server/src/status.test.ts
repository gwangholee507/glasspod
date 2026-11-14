import { describe, expect, it } from "vitest";
import type { PodSummary } from "./cluster.js";
import type { AppState } from "./pods.js";
import {
  RESTART_WINDOW_MS,
  judgePod,
  pickRestartCauses,
  stallLimitMs,
} from "./status.js";
import type { JudgeInput } from "./status.js";
import type { EventRecord } from "./store/store.js";

const NOW = 100_000_000;
const INTERVAL_MS = 5000;

// Running·Ready인 Pod입니다.
function pod(fields: Partial<PodSummary> = {}): PodSummary {
  return {
    namespace: "shop",
    name: "orders-1",
    uid: "uid-1",
    phase: "Running",
    ready: true,
    terminating: false,
    restarts: 0,
    waiting: undefined,
    lastTermination: undefined,
    ip: "10.1.0.5",
    replicaSet: "orders-5f7c9",
    createdAt: "2026-11-14T00:00:00Z",
    ...fields,
  };
}

// 연결이 열려 있고 1초 전에 metrics를 받은 SDK 상태입니다.
function app(fields: Partial<AppState> = {}): AppState {
  return {
    pod: { namespace: "shop", name: "orders-1" },
    instanceId: "b",
    sdk: "node@0.1.0",
    app: undefined,
    instanceSince: NOW - 3_600_000,
    previousInstanceId: undefined,
    deletedAt: undefined,
    connected: true,
    connectedAt: NOW - 3_600_000,
    disconnectedAt: undefined,
    lastMessageAt: NOW - 1000,
    lastMetricsAt: NOW - 1000,
    lastSeq: 10,
    missed: 0,
    values: new Map(),
    ...fields,
  };
}

function judge(input: Partial<JudgeInput>) {
  return judgePod({
    now: NOW,
    metricsIntervalMs: INTERVAL_MS,
    app: undefined,
    pod: undefined,
    ...input,
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("judgePod", () => {
  // design.md 7.5 표의 다섯 줄입니다.
  it("follows the table in design.md 7.5", () => {
    expect(judge({ app: app(), pod: pod() })).toEqual({
      status: "ok",
      severity: "none",
    });
    expect(
      judge({ app: app({ lastMetricsAt: NOW - 15_000 }), pod: pod() }),
    ).toEqual({
      status: "stalled",
      severity: "critical",
      reason: "no-metrics",
      silentMs: 15_000,
    });
    expect(judge({ app: app({ connected: false }), pod: pod() }).status).toBe(
      "disconnected",
    );
    expect(
      judge({
        app: app({ connected: false }),
        pod: pod({ terminating: true }),
      }),
    ).toEqual({
      status: "terminated",
      severity: "none",
      reason: "terminating",
    });
    expect(
      judge({
        app: app({ connected: false, deletedAt: NOW - 1000 }),
        pod: undefined,
      }),
    ).toEqual({ status: "terminated", severity: "none", reason: "deleted" });
    expect(
      judge({
        app: app({ previousInstanceId: "a", instanceSince: NOW - 2000 }),
        pod: pod({
          restarts: 1,
          lastTermination: {
            container: "app",
            reason: "Error",
            exitCode: 1,
            finishedAt: iso(NOW - 3000),
          },
        }),
      }),
    ).toEqual({
      status: "restarted",
      severity: "warning",
      reason: "Error",
      restart: {
        at: NOW - 3000,
        reason: "Error",
        exitCode: 1,
        previousInstanceId: "a",
      },
    });
  });

  it("counts three periods from the last metrics, or from the connection", () => {
    expect(stallLimitMs(5000)).toBe(15_000);
    expect(judge({ app: app({ lastMetricsAt: NOW - 14_999 }) }).status).toBe(
      "ok",
    );
    // 연결한 뒤 metrics가 아직 없으면 연결 시각부터 셉니다.
    expect(
      judge({
        app: app({ lastMetricsAt: undefined, connectedAt: NOW - 14_999 }),
      }).status,
    ).toBe("ok");
    expect(
      judge({
        app: app({ lastMetricsAt: undefined, connectedAt: NOW - 15_000 }),
      }),
    ).toMatchObject({ status: "stalled", silentMs: 15_000 });
  });

  it("uses the SDK's 1000ms lower bound for short intervals", () => {
    expect(stallLimitMs(200)).toBe(3000);
    const short = { metricsIntervalMs: 200 };
    expect(
      judge({ ...short, app: app({ lastMetricsAt: NOW - 2999 }) }).status,
    ).toBe("ok");
    expect(
      judge({ ...short, app: app({ lastMetricsAt: NOW - 3000 }) }).status,
    ).toBe("stalled");
  });

  it("judges from the SDK alone when the pod is not known to Kubernetes", () => {
    expect(judge({ app: app() }).status).toBe("ok");
    expect(judge({ app: app({ connected: false }) }).status).toBe(
      "disconnected",
    );
    expect(judge({ app: app({ lastMetricsAt: NOW - 20_000 }) }).status).toBe(
      "stalled",
    );
    expect(
      judge({ app: app({ previousInstanceId: "a", instanceSince: NOW - 10 }) }),
    ).toMatchObject({
      status: "restarted",
      restart: { at: NOW - 10, previousInstanceId: "a" },
    });
  });

  it("follows the pod again when a pod with the same name comes back", () => {
    expect(
      judge({ app: app({ deletedAt: NOW - 1000 }), pod: pod() }).status,
    ).toBe("ok");
  });

  it("judges Kubernetes states the table in design.md 7.5 leaves out", () => {
    expect(
      judge({
        app: app({ connected: false }),
        pod: pod({ ready: false, waiting: "CrashLoopBackOff" }),
      }),
    ).toEqual({
      status: "pod-failing",
      severity: "critical",
      reason: "CrashLoopBackOff",
    });
    expect(
      judge({ pod: pod({ phase: "Pending", waiting: "ImagePullBackOff" }) })
        .reason,
    ).toBe("ImagePullBackOff");
    expect(judge({ pod: pod({ phase: "Failed" }) })).toMatchObject({
      status: "pod-failing",
      reason: "Failed",
    });
    expect(judge({ pod: pod({ phase: "Succeeded" }) })).toMatchObject({
      status: "terminated",
      reason: "Succeeded",
    });
    expect(judge({ pod: pod({ phase: "Pending", ready: false }) })).toEqual({
      status: "starting",
      severity: "none",
      reason: "Pending",
    });
    // 크래시 뒤 새 컨테이너를 만드는 중이면 연결 끊김이 아니라 시작 중입니다.
    expect(
      judge({
        app: app({ connected: false }),
        pod: pod({ ready: false, waiting: "ContainerCreating" }),
      }),
    ).toMatchObject({ status: "starting", reason: "ContainerCreating" });
    expect(judge({ app: app(), pod: pod({ ready: false }) })).toEqual({
      status: "not-ready",
      severity: "warning",
    });
    expect(judge({ pod: pod() })).toEqual({
      status: "no-sdk",
      severity: "none",
    });
  });

  it("puts the higher row first when several rows match", () => {
    const crashed = {
      restarts: 2,
      lastTermination: {
        container: "app",
        reason: "OOMKilled",
        exitCode: 137,
        finishedAt: iso(NOW - 60_000),
      },
    };
    // 종료 중이면 SDK가 멈춰 있어도 종료됨입니다.
    expect(
      judge({
        app: app({ lastMetricsAt: NOW - 60_000 }),
        pod: pod({ terminating: true, waiting: "CrashLoopBackOff" }),
      }).status,
    ).toBe("terminated");
    expect(
      judge({
        app: app({ lastMetricsAt: NOW - 60_000 }),
        pod: pod({ waiting: "CrashLoopBackOff" }),
      }).status,
    ).toBe("pod-failing");
    // 멈춤과 끊김은 재시작보다 먼저이고, 재시작 정보는 그대로 붙습니다.
    expect(
      judge({
        app: app({ lastMetricsAt: NOW - 60_000 }),
        pod: pod(crashed),
      }),
    ).toMatchObject({
      status: "stalled",
      restart: { reason: "OOMKilled", exitCode: 137 },
    });
    expect(
      judge({ app: app({ connected: false }), pod: pod(crashed) }).status,
    ).toBe("disconnected");
    // 재시작은 준비 안 됨보다 먼저입니다.
    expect(
      judge({ app: app(), pod: pod({ ...crashed, ready: false }) }).status,
    ).toBe("restarted");
    // SDK가 없는 Pod도 쿠버네티스가 알린 재시작은 판단합니다.
    expect(judge({ pod: pod(crashed) }).status).toBe("restarted");
  });

  it("keeps a restart for 30 minutes", () => {
    const restartedAt = (finishedAt: number) =>
      pod({
        restarts: 1,
        lastTermination: {
          container: "app",
          reason: "Error",
          exitCode: 1,
          finishedAt: iso(finishedAt),
        },
      });
    expect(
      judge({ app: app(), pod: restartedAt(NOW - RESTART_WINDOW_MS) }).status,
    ).toBe("restarted");
    expect(
      judge({ app: app(), pod: restartedAt(NOW - RESTART_WINDOW_MS - 1000) }),
    ).toEqual({ status: "ok", severity: "none" });
    expect(
      judge({
        app: app({
          previousInstanceId: "a",
          instanceSince: NOW - RESTART_WINDOW_MS - 1,
        }),
        pod: pod(),
      }).status,
    ).toBe("ok");
    // 재시작 횟수가 0이면 끝난 컨테이너가 있어도 재시작이 아닙니다.
    expect(
      judge({
        app: app(),
        pod: pod({ ...restartedAt(NOW - 1000), restarts: 0 }),
      }).status,
    ).toBe("ok");
  });

  it("uses whichever restart signal arrives first", () => {
    // SDK가 새 instance로 먼저 붙고, 쿠버네티스는 아직 재시작 횟수를 올리지 않았습니다.
    expect(
      judge({
        app: app({ previousInstanceId: "a", instanceSince: NOW - 500 }),
        pod: pod(),
      }),
    ).toEqual({
      status: "restarted",
      severity: "warning",
      restart: { at: NOW - 500, previousInstanceId: "a" },
    });
    // 쿠버네티스가 먼저 알리고 새 SDK는 아직 붙지 않았습니다(연결이 끊긴 채 Running이면 끊김이 먼저).
    expect(
      judge({
        app: app({ connected: false }),
        pod: pod({
          restarts: 1,
          lastTermination: {
            container: "app",
            reason: "Error",
            exitCode: 1,
            finishedAt: iso(NOW - 500),
          },
        }),
      }),
    ).toMatchObject({
      status: "disconnected",
      restart: { at: NOW - 500, reason: "Error", exitCode: 1 },
    });
  });
});

describe("pickRestartCauses", () => {
  function event(
    instanceId: string,
    level: EventRecord["level"],
    ts: number,
    name = "exception",
  ): EventRecord {
    return {
      pod: { namespace: "shop", name: "orders-1" },
      instanceId,
      seq: ts,
      ts,
      receivedAt: ts,
      level,
      name,
      count: 1,
    };
  }

  it("picks events of the previous instance, errors first and latest first", () => {
    const events = [
      event("a", "error", 1),
      event("a", "info", 2, "state"),
      event("a", "warn", 3, "app.cache.cleared"),
      event("a", "error", 4),
      event("b", "error", 5),
    ];
    expect(
      pickRestartCauses(events, "a").map((cause) => [cause.level, cause.ts]),
    ).toEqual([
      ["error", 4],
      ["error", 1],
      ["warn", 3],
      ["info", 2],
    ]);
    expect(pickRestartCauses(events, "c")).toEqual([]);
  });

  it("keeps at most five and puts the later one first when ts is the same", () => {
    const events = Array.from({ length: 7 }, (_, index) => ({
      ...event("a", "error", 10),
      seq: index,
    }));
    const causes = pickRestartCauses(events, "a");
    expect(causes.map((cause) => cause.seq)).toEqual([6, 5, 4, 3, 2]);
    // 고르는 동안 받은 배열을 바꾸지 않습니다.
    expect(events.map((item) => item.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
