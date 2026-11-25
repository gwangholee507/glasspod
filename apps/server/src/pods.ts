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
// counter마다 증가량을 들고 있는 시간입니다. 목록의 5xx/분이 씁니다(docs/guides/T14.md 결정 9, 10).
export const INCREASE_WINDOW_MS = 60_000;

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

// counter 하나의 증가량입니다. at은 서버가 받은 시각입니다.
export interface CounterIncrease {
  at: number;
  increase: number;
}

// error 수준 event 하나의 count입니다. at은 서버가 받은 시각입니다.
export interface ErrorEventCount {
  at: number;
  count: number;
}

// Pod 하나의 지금 상태입니다. 상태 판단(T13)이 읽고, 고치지 않습니다.
export interface AppState {
  readonly pod: PodRef;
  // 마지막으로 받아들인 hello의 instance, SDK, 앱입니다.
  readonly instanceId: string;
  readonly sdk: string;
  readonly app: HelloMessage["app"];
  // 이 instance가 처음 붙은 시각(서버 시계)과, 그 전에 이 Pod에서 본 instance입니다.
  // 직전 instance가 있으면 프로세스가 다시 시작된 것입니다(design.md 7.5 재시작, docs/guides/T13.md).
  readonly instanceSince: number;
  readonly previousInstanceId: string | undefined;
  // 쿠버네티스에서 이 Pod가 지워진 시각입니다. 상태 판단은 이 Pod가 쿠버네티스에 다시 없을 때 '종료됨'으로 봅니다.
  readonly deletedAt: number | undefined;
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
  // counter 이름마다 최근 증가량입니다(받은 순서). 넣을 때 INCREASE_WINDOW_MS보다 오래된 것을 지우므로,
  // 읽는 쪽도 시각으로 다시 거릅니다. instance가 바뀌어도 남깁니다(리셋은 새 값만큼 늘어난 것으로 셈).
  readonly increases: ReadonlyMap<string, readonly CounterIncrease[]>;
  // 지금 연결에서 받은 error 수준 event의 count입니다(받은 순서). 지표 비교의 예외/분이 씁니다(docs/guides/T34.md 결정 13).
  // increases처럼 넣을 때 INCREASE_WINDOW_MS보다 오래된 것을 지우고, instance가 바뀌어도 남깁니다.
  readonly errorEvents: readonly ErrorEventCount[];
}

interface TrackedState {
  pod: PodRef;
  instanceId: string;
  sdk: string;
  app: HelloMessage["app"];
  instanceSince: number;
  previousInstanceId: string | undefined;
  deletedAt: number | undefined;
  connected: boolean;
  connectedAt: number;
  disconnectedAt: number | undefined;
  lastMessageAt: number;
  lastMetricsAt: number | undefined;
  lastSeq: number;
  missed: number;
  values: Map<string, LatestValue>;
  increases: Map<string, CounterIncrease[]>;
  errorEvents: ErrorEventCount[];
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
        instanceSince: at,
        previousInstanceId: undefined,
        deletedAt: undefined,
        connected: true,
        connectedAt: at,
        disconnectedAt: undefined,
        lastMessageAt: at,
        lastMetricsAt: undefined,
        lastSeq: hello.seq,
        missed: 0,
        values: new Map(),
        increases: new Map(),
        errorEvents: [],
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
      state.previousInstanceId = previous.instanceId;
      state.instanceId = hello.instanceId;
      state.instanceSince = at;
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
      this.recordEvent(connection, current ? state : undefined, message, at);
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
  // 지금 상태가 있으면 지워진 시각을 적어 상태 판단(T13)이 '종료됨'으로 보게 합니다.
  podDeleted(summary: PodSummary): void {
    const at = this.now();
    const pod = { namespace: summary.namespace, name: summary.name };
    const state = this.states.get(podKey(pod));
    if (state !== undefined) {
      state.deletedAt = at;
    }
    this.write(
      "deletedPods",
      pod,
      this.store.addDeletedPod({ pod: summary, deletedAt: at }),
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
        statusChanges: stats.statusChanges,
        kubeEvents: stats.kubeEvents,
        actions: stats.actions,
        droppedMetrics: stats.droppedMetrics,
        droppedEvents: stats.droppedEvents,
        droppedConnections: stats.droppedConnections,
        droppedStatusChanges: stats.droppedStatusChanges,
        droppedKubeEvents: stats.droppedKubeEvents,
        droppedActions: stats.droppedActions,
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
          recordIncrease(current, metric.name, at, stored.increase);
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

  // current는 지금 상태를 바꿀 연결이면 그 Pod의 상태, 예전 연결이면 undefined입니다.
  private recordEvent(
    connection: AppConnection,
    current: TrackedState | undefined,
    message: EventMessage,
    at: number,
  ): void {
    const { hello } = connection;
    if (current !== undefined && message.level === "error") {
      recordErrorEvent(current, at, message.count);
    }
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

// counter의 최근 INCREASE_WINDOW_MS 증가량 합입니다(서버가 받은 시각 기준). 목록의 5xx/분과 지표 비교가 씁니다.
export function recentIncrease(
  app: AppState,
  name: string,
  now: number,
): number {
  const since = now - INCREASE_WINDOW_MS;
  let sum = 0;
  for (const entry of app.increases.get(name) ?? []) {
    if (entry.at >= since) {
      sum += entry.increase;
    }
  }
  return sum;
}

// error 수준 event의 최근 INCREASE_WINDOW_MS count 합입니다(서버가 받은 시각 기준, docs/guides/T34.md 결정 13).
export function recentErrorEvents(app: AppState, now: number): number {
  const since = now - INCREASE_WINDOW_MS;
  let sum = 0;
  for (const entry of app.errorEvents) {
    if (entry.at >= since) {
      sum += entry.count;
    }
  }
  return sum;
}

// 증가량을 넣고 INCREASE_WINDOW_MS보다 오래된 것을 지웁니다.
function recordIncrease(
  state: TrackedState,
  name: string,
  at: number,
  increase: number,
): void {
  let list = state.increases.get(name);
  if (list === undefined) {
    list = [];
    state.increases.set(name, list);
  }
  list.push({ at, increase });
  const before = at - INCREASE_WINDOW_MS;
  let index = 0;
  while (index < list.length && (list[index] as CounterIncrease).at < before) {
    index += 1;
  }
  if (index > 0) {
    list.splice(0, index);
  }
}

// error 수준 event의 count를 넣고 INCREASE_WINDOW_MS보다 오래된 것을 지웁니다.
function recordErrorEvent(
  state: TrackedState,
  at: number,
  count: number,
): void {
  const list = state.errorEvents;
  list.push({ at, count });
  const before = at - INCREASE_WINDOW_MS;
  let index = 0;
  while (index < list.length && (list[index] as ErrorEventCount).at < before) {
    index += 1;
  }
  if (index > 0) {
    list.splice(0, index);
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
