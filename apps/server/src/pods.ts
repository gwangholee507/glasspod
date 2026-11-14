// SDK가 보낸 메시지로 Pod마다 앱의 지금 상태를 들고, 받은 것을 기록으로 바꿔 저장소에 넣습니다(docs/guides/T11.md).
// 지금 상태는 상태 판단(T13)이 바로 읽도록 메모리에 두고, 기록(지표·event·연결·지워진 Pod)은 저장소(store/)에 둡니다.
// 여기서 seq 빈틈(누락)과 counter 리셋을 알아냅니다. 같은 Pod에 새 연결이 붙으면 지금 상태는 새 연결만 따릅니다.
import type {
  EventMessage,
  HelloMessage,
  MetricKind,
  MetricsMessage,
  PodRef,
  SdkMessage,
} from "@glasspod/protocol";
import type { PodSummary } from "./cluster.js";
import { log } from "./log.js";
import type { LogFields } from "./log.js";
import { podKey, podLabel } from "./pod-key.js";
import { RETENTION_MS } from "./store/store.js";
import type { Store, StoredMetric } from "./store/store.js";

// Pod 하나에서 받는 지표 이름의 상한입니다. 넘는 새 이름의 값은 버립니다.
export const MAX_METRIC_NAMES_PER_POD = 200;

const BYTES_PER_MB = 1024 * 1024;

// SDK 연결 하나입니다. agent.ts의 AgentSession이 이 모양입니다. 같은 객체인지로 연결을 구분합니다.
export interface AppConnection {
  readonly hello: HelloMessage;
}

export interface LatestValue {
  kind: MetricKind;
  value: number;
  // SDK가 보낸 시각과 서버가 받은 시각입니다.
  ts: number;
  receivedAt: number;
}

// Pod 하나의 지금 상태입니다. 상태 판단(T13)이 읽고, 고치지 않습니다.
export interface AppState {
  readonly pod: PodRef;
  // 마지막으로 받아들인 hello의 instance, SDK, 앱입니다.
  readonly instanceId: string;
  readonly sdk: string;
  readonly app: HelloMessage["app"];
  // 그 연결이 열려 있는지와 시각(서버 시계)입니다.
  readonly connected: boolean;
  readonly connectedAt: number;
  readonly disconnectedAt: number | undefined;
  // 그 연결에서 마지막으로 메시지(종류 상관없음)와 metrics를 받은 시각입니다.
  readonly lastMessageAt: number;
  readonly lastMetricsAt: number | undefined;
  // 그 instance의 마지막 seq와, seq 빈틈으로 빠진 메시지 수입니다.
  readonly lastSeq: number;
  readonly missed: number;
  // 이름마다 마지막 값입니다. instance가 바뀌면 비웁니다.
  readonly values: ReadonlyMap<string, LatestValue>;
}

interface TrackedState {
  pod: PodRef;
  instanceId: string;
  sdk: string;
  app: HelloMessage["app"];
  connected: boolean;
  connectedAt: number;
  disconnectedAt: number | undefined;
  lastMessageAt: number;
  lastMetricsAt: number | undefined;
  lastSeq: number;
  missed: number;
  values: Map<string, LatestValue>;
  // 지금 상태를 바꾸는 연결(마지막으로 hello를 받아들인 연결)입니다.
  connection: AppConnection;
  // counter 리셋을 판단할 앞 점입니다. instance가 바뀌어도 남겨 둡니다.
  counters: Map<string, { instanceId: string; value: number }>;
  // 이 Pod에서 받은 지표 이름입니다(상한 판단).
  names: Set<string>;
  warnedNames: boolean;
}

export class AppStates {
  private readonly states = new Map<string, TrackedState>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  // hello를 받아들인 연결입니다. 같은 Pod의 예전 연결이 있어도 이 연결이 지금 상태를 이어받습니다.
  connect(connection: AppConnection): void {
    const at = this.now();
    const { hello } = connection;
    const key = podKey(hello.pod);
    const previous = this.states.get(key);
    let newInstance: boolean | undefined;
    let state: TrackedState;

    if (previous === undefined) {
      state = {
        pod: { namespace: hello.pod.namespace, name: hello.pod.name },
        instanceId: hello.instanceId,
        sdk: "",
        app: undefined,
        connected: true,
        connectedAt: at,
        disconnectedAt: undefined,
        lastMessageAt: at,
        lastMetricsAt: undefined,
        lastSeq: hello.seq,
        missed: 0,
        values: new Map(),
        connection,
        counters: new Map(),
        names: new Set(),
        warnedNames: false,
      };
      this.states.set(key, state);
    } else if (previous.instanceId !== hello.instanceId) {
      newInstance = true;
      log.info("instance changed", {
        pod: podLabel(hello.pod),
        instance: hello.instanceId,
        previous: previous.instanceId,
      });
      state = previous;
      state.instanceId = hello.instanceId;
      state.lastSeq = hello.seq;
      state.missed = 0;
      state.values.clear();
      state.lastMetricsAt = undefined;
    } else {
      // 같은 instance가 다시 붙음. 끊기기 직전에 보낸 것을 잃었으면 hello의 seq에 빈틈이 보입니다.
      newInstance = false;
      state = previous;
      this.checkSeq(state, hello.seq);
      state.lastMetricsAt = undefined;
    }

    state.connection = connection;
    state.sdk = `${hello.sdk.lang}@${hello.sdk.version}`;
    state.app = hello.app;
    state.connected = true;
    state.connectedAt = at;
    state.disconnectedAt = undefined;
    state.lastMessageAt = at;

    this.write(
      "connections",
      hello.pod,
      this.store.addConnection({
        pod: state.pod,
        instanceId: hello.instanceId,
        change: "connected",
        at,
        ...(newInstance === undefined ? {} : { newInstance }),
        sdk: state.sdk,
        ...(hello.app === undefined ? {} : { app: hello.app }),
      }),
    );
  }

  // hello 뒤에 받은 올바른 메시지입니다. 예전 연결에서 온 것은 기록만 하고 지금 상태는 바꾸지 않습니다.
  receive(connection: AppConnection, message: SdkMessage): void {
    const at = this.now();
    const state = this.states.get(podKey(connection.hello.pod));
    const current = state !== undefined && state.connection === connection;
    if (current) {
      state.lastMessageAt = at;
      this.checkSeq(state, message.seq);
    }
    if (message.type === "metrics") {
      this.recordMetrics(
        connection,
        current ? state : undefined,
        state,
        message,
        at,
      );
    } else if (message.type === "event") {
      this.recordEvent(connection, message, at);
    }
    // response와 무시한 두 번째 hello는 seq만 봅니다. snapshot은 보관하지 않습니다(T09).
  }

  // 연결이 끝났습니다. 지금 상태를 이어받은 연결일 때만 끊김으로 봅니다.
  disconnect(connection: AppConnection, code: number): void {
    const at = this.now();
    const state = this.states.get(podKey(connection.hello.pod));
    if (state === undefined || state.connection !== connection) {
      return;
    }
    state.connected = false;
    state.disconnectedAt = at;
    this.write(
      "connections",
      state.pod,
      this.store.addConnection({
        pod: state.pod,
        instanceId: connection.hello.instanceId,
        change: "disconnected",
        at,
        code,
      }),
    );
  }

  // 쿠버네티스에서 Pod가 지워졌습니다. 마지막 요약을 30분 남깁니다(ClusterState는 바로 뺌).
  podDeleted(summary: PodSummary): void {
    const pod = { namespace: summary.namespace, name: summary.name };
    this.write(
      "deletedPods",
      pod,
      this.store.addDeletedPod({ pod: summary, deletedAt: this.now() }),
    );
  }

  get(pod: PodRef): AppState | undefined {
    return this.states.get(podKey(pod));
  }

  list(): AppState[] {
    return [...this.states.values()];
  }

  // 30분 지난 기록과, 연결이 끊긴 채 30분 지난 Pod의 지금 상태를 지웁니다.
  async prune(): Promise<void> {
    const before = this.now() - RETENTION_MS;
    for (const [key, state] of this.states) {
      if (
        !state.connected &&
        state.disconnectedAt !== undefined &&
        state.disconnectedAt < before
      ) {
        this.states.delete(key);
      }
    }
    try {
      const result = await this.store.prune(before);
      for (const pod of result.expiredPods) {
        log.info("pod history expired", { pod: podLabel(pod) });
      }
    } catch (error) {
      log.warn("store prune failed", { detail: describe(error) });
    }
  }

  // 보관 현황 한 줄입니다. 메모리 사용량을 함께 봅니다.
  async logStats(): Promise<void> {
    try {
      const stats = await this.store.stats();
      const memory = process.memoryUsage();
      let connected = 0;
      for (const state of this.states.values()) {
        if (state.connected) {
          connected += 1;
        }
      }
      log.info("store stats", {
        store: this.store.kind,
        pods: stats.pods,
        apps: this.states.size,
        connected,
        metrics: stats.metrics,
        events: stats.events,
        connections: stats.connections,
        deletedPods: stats.deletedPods,
        droppedMetrics: stats.droppedMetrics,
        droppedEvents: stats.droppedEvents,
        droppedConnections: stats.droppedConnections,
        heapUsedMb: megabytes(memory.heapUsed),
        rssMb: megabytes(memory.rss),
      });
    } catch (error) {
      log.warn("store stats failed", { detail: describe(error) });
    }
  }

  // seq는 SDK가 보낸 순서대로 하나씩 늘어납니다. 빈틈은 잃은 메시지(검증에 실패해 버린 것 포함)입니다.
  private checkSeq(state: TrackedState, seq: number): void {
    const expected = state.lastSeq + 1;
    if (seq > expected) {
      const missing = seq - expected;
      state.missed += missing;
      log.warn("messages missing", {
        ...stateFields(state),
        after: state.lastSeq,
        next: seq,
        missing,
      });
      state.lastSeq = seq;
    } else if (seq < expected) {
      log.warn("message out of order", {
        ...stateFields(state),
        seq,
        lastSeq: state.lastSeq,
      });
    } else {
      state.lastSeq = seq;
    }
  }

  // current는 지금 상태를 바꿀 연결이면 그 Pod의 상태, 예전 연결이면 undefined입니다.
  // known은 이 Pod의 상태입니다(이름 상한은 예전 연결에도 적용).
  private recordMetrics(
    connection: AppConnection,
    current: TrackedState | undefined,
    known: TrackedState | undefined,
    message: MetricsMessage,
    at: number,
  ): void {
    const { hello } = connection;
    const values: StoredMetric[] = [];
    const resets: string[] = [];
    const decreased: string[] = [];

    for (const metric of message.values) {
      if (known !== undefined && !known.names.has(metric.name)) {
        if (known.names.size >= MAX_METRIC_NAMES_PER_POD) {
          if (!known.warnedNames) {
            known.warnedNames = true;
            log.warn("metric names over limit", {
              pod: podLabel(hello.pod),
              instance: hello.instanceId,
              limit: MAX_METRIC_NAMES_PER_POD,
              name: metric.name,
            });
          }
          continue;
        }
        known.names.add(metric.name);
      }

      const stored: StoredMetric = {
        name: metric.name,
        kind: metric.kind,
        value: metric.value,
      };
      if (metric.kind === "counter" && current !== undefined) {
        const previous = current.counters.get(metric.name);
        current.counters.set(metric.name, {
          instanceId: hello.instanceId,
          value: metric.value,
        });
        if (previous !== undefined) {
          if (previous.instanceId !== hello.instanceId) {
            stored.increase = metric.value;
            stored.reset = true;
            resets.push(metric.name);
          } else if (metric.value < previous.value) {
            stored.increase = metric.value;
            stored.reset = true;
            decreased.push(metric.name);
          } else {
            stored.increase = metric.value - previous.value;
          }
        }
      }
      values.push(stored);

      if (current !== undefined) {
        current.values.set(metric.name, {
          kind: metric.kind,
          value: metric.value,
          ts: message.ts,
          receivedAt: at,
        });
      }
    }

    if (current !== undefined) {
      current.lastMetricsAt = at;
    }
    const fields: LogFields = {
      pod: podLabel(hello.pod),
      instance: hello.instanceId,
    };
    if (resets.length > 0) {
      log.info("counter reset", {
        ...fields,
        cause: "new-instance",
        names: resets.sort().join(","),
      });
    }
    if (decreased.length > 0) {
      log.warn("counter reset", {
        ...fields,
        cause: "decreased",
        names: decreased.sort().join(","),
      });
    }

    this.write(
      "metrics",
      hello.pod,
      this.store.addMetrics({
        pod: { namespace: hello.pod.namespace, name: hello.pod.name },
        instanceId: hello.instanceId,
        seq: message.seq,
        ts: message.ts,
        receivedAt: at,
        values,
      }),
    );
  }

  private recordEvent(
    connection: AppConnection,
    message: EventMessage,
    at: number,
  ): void {
    const { hello } = connection;
    this.write(
      "events",
      hello.pod,
      this.store.addEvent({
        pod: { namespace: hello.pod.namespace, name: hello.pod.name },
        instanceId: hello.instanceId,
        seq: message.seq,
        ts: message.ts,
        receivedAt: at,
        level: message.level,
        name: message.name,
        ...(message.message === undefined ? {} : { message: message.message }),
        count: message.count,
        ...(message.data === undefined ? {} : { data: message.data }),
      }),
    );
  }

  // 저장소에 쓰기를 기다리지 않습니다. 실패하면 경고 한 줄만 남깁니다(결정 18).
  private write(kind: string, pod: PodRef, pending: Promise<void>): void {
    pending.catch((error: unknown) => {
      log.warn("store write failed", {
        kind,
        pod: podLabel(pod),
        detail: describe(error),
      });
    });
  }
}

function stateFields(state: TrackedState): LogFields {
  return { pod: podLabel(state.pod), instance: state.instanceId };
}

function megabytes(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
