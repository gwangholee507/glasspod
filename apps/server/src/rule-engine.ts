// 자동 규칙을 판단 주기마다 보고 발동합니다(docs/guides/T28.md 결정 10~20).
// 판단(StatusMonitor.evaluate)과 지표 비교(OutlierMonitor.evaluate) 뒤에 evaluate()를 부릅니다.
// 알림만(notify)은 '실행했을 것'을 기록하고, 자동(auto)은 조치 길(ActionService.run)을 실행 주체 rule로 부릅니다.
// 상태(조건이 맞기 시작한 시각, 쉬는 시간, 최근 1시간 발동)는 메모리에만 있습니다.
import { randomUUID } from "node:crypto";
import type {
  ActionActor,
  ActionRequest,
  ActionTarget,
  PodOutlier,
  PodRef,
  RuleConditionMatch,
  RuleDefinition,
  RuleFiring,
  RuleItem,
  RuleMatch,
  RuleNote,
  RulesFileState,
  RuleSkipReason,
  RulesView,
} from "@glasspod/protocol";
import type { ActionOutcome } from "./actions.js";
import type { ClusterState, PodSummary } from "./cluster.js";
import { log } from "./log.js";
import type { LogFields } from "./log.js";
import type { AppStates } from "./pods.js";
import { podKey, podLabel } from "./pod-key.js";
import {
  evaluateCondition,
  healthyPeers,
  neededHealthy,
  scaleTarget,
} from "./rules.js";
import type { ConditionResult } from "./rules.js";
import { stallLimitMs } from "./status.js";
import type { PodStatusEntry } from "./status-monitor.js";
import type { Store } from "./store/store.js";

// 규칙이 트래픽에서 빼 둘 수 있는 Pod 수입니다. Deployment마다 격리된 Pod가 이만큼 있으면 더 빼지 않습니다(결정 3 ③).
export const MAX_RULE_ISOLATED = 1;
// maxPerHour를 세는 시간입니다.
export const RULE_HOUR_MS = 60 * 60_000;

// 규칙 파일(RulesSource)에서 쓰는 것입니다.
export interface RuleSource {
  readonly rules: readonly RuleDefinition[];
  readonly state: RulesFileState;
  readonly version: number;
}

export interface RuleEngineOptions {
  source: RuleSource;
  statuses: { list(): PodStatusEntry[] };
  apps: Pick<AppStates, "get">;
  cluster: ClusterState;
  outliers: { get(pod: PodRef): readonly PodOutlier[] };
  actions: {
    run(request: ActionRequest, actor: ActionActor): Promise<ActionOutcome>;
  };
  store: Pick<Store, "addRuleFiring">;
  // GLASSPOD_NAMESPACES와 GLASSPOD_ACTION_NAMESPACES입니다. 화면에 미리 알릴 것(결정 19)에 씁니다.
  namespaces: readonly string[];
  actionNamespaces: readonly string[];
  metricsIntervalMs: number;
  // 기록을 남긴 뒤 부릅니다. 다음 SSE changes에 넣습니다(결정 18).
  onFiring?: (firing: RuleFiring) => void;
  now?: () => number;
  newId?: () => string;
}

// 규칙 하나의 상태입니다. 이름으로 이어 갑니다(결정 20).
interface Runtime {
  definition: RuleDefinition;
  // target과 when입니다. 바뀌면 조건 시각을 처음부터 셉니다.
  fingerprint: string;
  // Pod 키마다, 조건마다 맞기 시작한 시각입니다. 맞지 않으면 undefined입니다.
  tracks: Map<string, (number | undefined)[]>;
  matching: RuleMatch[];
  lastFiredAt: number | undefined;
  // 최근 1시간의 알림만·실행 시각입니다(maxPerHour).
  fired: number[];
  running: boolean;
}

// 이번 주기에 규칙이 본 Pod 하나입니다.
interface Candidate {
  key: string;
  pod: PodRef;
  entry: PodStatusEntry;
  summary: PodSummary;
  results: ConditionResult[];
  sinces: (number | undefined)[];
  // 조건이 지금 모두 맞습니다(지속 시간은 보지 않음).
  all: boolean;
}

type Base = Omit<RuleFiring, "outcome">;

function groupKey(target: RuleDefinition["target"]): string {
  return JSON.stringify([target.namespace, target.deployment]);
}

function fingerprintOf(definition: RuleDefinition): string {
  return JSON.stringify([definition.target, definition.when]);
}

function actionKindOf(definition: RuleDefinition): RuleFiring["action"] {
  switch (definition.action.kind) {
    case "restart":
      return "restart-pod";
    case "isolate":
      return "isolate-pod";
    case "scale":
      return "scale-deployment";
  }
}

function matchValues(
  result: ConditionResult,
): Omit<RuleConditionMatch, "condition" | "since"> {
  return {
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.peerMedian === undefined
      ? {}
      : { peerMedian: result.peerMedian }),
  };
}

export class RuleEngine {
  private readonly options: RuleEngineOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  // 파일 순서입니다(Map은 넣은 순서를 지킴).
  private runtimes = new Map<string, Runtime>();
  private seenVersion: number | undefined;
  // 규칙 조치가 실행 중인 Deployment입니다(결정 15 ①).
  private readonly runningGroups = new Set<string>();

  constructor(options: RuleEngineOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  // 판단 주기마다 부릅니다. 규칙마다 조건을 보고, 조건을 채운 Pod가 있으면 발동합니다.
  evaluate(): void {
    this.sync();
    const now = this.now();
    const freshMs = stallLimitMs(this.options.metricsIntervalMs);
    const entries = this.options.statuses.list();
    // 이번 주기에 규칙이 발동한 Deployment입니다. 뒤 규칙은 다음 주기로 미룹니다(결정 15 ①).
    const firedGroups = new Set<string>();
    for (const runtime of this.runtimes.values()) {
      const definition = runtime.definition;
      if (definition.mode === "off") {
        runtime.tracks.clear();
        runtime.matching = [];
        continue;
      }
      const candidates = this.candidates(runtime, entries, now, freshMs);
      runtime.matching = candidates
        .filter((candidate) => candidate.all)
        .map((candidate) => matchOf(candidate, definition))
        .sort(
          (a, b) =>
            a.readyAt - b.readyAt ||
            (a.pod.name < b.pod.name ? -1 : a.pod.name > b.pod.name ? 1 : 0),
        );
      const ready = runtime.matching.find((match) => match.readyAt <= now);
      if (ready === undefined || runtime.running) {
        continue;
      }
      if (
        runtime.lastFiredAt !== undefined &&
        now < runtime.lastFiredAt + definition.cooldownMs
      ) {
        continue;
      }
      const group = groupKey(definition.target);
      if (firedGroups.has(group) || this.runningGroups.has(group)) {
        continue;
      }
      const chosen = candidates.find(
        (candidate) => candidate.key === podKey(ready.pod),
      ) as Candidate;
      firedGroups.add(group);
      this.fire(runtime, chosen, candidates, now);
    }
  }

  // 규칙 파일 상태와 규칙마다 지금 상태입니다(GET /api/rules, SSE changes.rules).
  view(): RulesView {
    this.sync();
    const now = this.now();
    return {
      file: this.options.source.state,
      rules: [...this.runtimes.values()].map((runtime) =>
        this.item(runtime, now),
      ),
    };
  }

  // 규칙 파일이 바뀌었으면 이름으로 상태를 이어 갑니다(결정 20).
  private sync(): void {
    const { source } = this.options;
    if (this.seenVersion === source.version) {
      return;
    }
    this.seenVersion = source.version;
    const next = new Map<string, Runtime>();
    for (const definition of source.rules) {
      const fingerprint = fingerprintOf(definition);
      const existing = this.runtimes.get(definition.name);
      if (existing === undefined) {
        next.set(definition.name, {
          definition,
          fingerprint,
          tracks: new Map(),
          matching: [],
          lastFiredAt: undefined,
          fired: [],
          running: false,
        });
        continue;
      }
      if (existing.fingerprint !== fingerprint) {
        existing.tracks.clear();
        existing.matching = [];
      }
      existing.definition = definition;
      existing.fingerprint = fingerprint;
      next.set(definition.name, existing);
    }
    this.runtimes = next;
  }

  // 규칙이 보는 Pod(결정 10)마다 조건을 보고 맞기 시작한 시각을 고칩니다.
  private candidates(
    runtime: Runtime,
    entries: readonly PodStatusEntry[],
    now: number,
    freshMs: number,
  ): Candidate[] {
    const { target, when } = runtime.definition;
    const { cluster, apps, outliers } = this.options;
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (
        entry.pod.namespace !== target.namespace ||
        entry.deployment !== target.deployment
      ) {
        continue;
      }
      const summary = cluster.pods.get(entry.pod.namespace, entry.pod.name);
      if (
        summary === undefined ||
        summary.terminating ||
        summary.isolation !== undefined
      ) {
        continue;
      }
      const key = podKey(entry.pod);
      seen.add(key);
      const input = {
        status: entry.status,
        app: apps.get(entry.pod),
        outliers: outliers.get(entry.pod),
        now,
        freshMs,
      };
      const results = when.map((condition) =>
        evaluateCondition(condition, input),
      );
      const previous = runtime.tracks.get(key) ?? [];
      const sinces = results.map((result, index) =>
        result.holds ? (previous[index] ?? now) : undefined,
      );
      runtime.tracks.set(key, sinces);
      candidates.push({
        key,
        pod: entry.pod,
        entry,
        summary,
        results,
        sinces,
        all: results.every((result) => result.holds),
      });
    }
    for (const key of runtime.tracks.keys()) {
      if (!seen.has(key)) {
        runtime.tracks.delete(key);
      }
    }
    return candidates;
  }

  // 발동합니다(결정 13~16). 건너뛰는 검사를 차례로 보고, 알림만은 기록만, 자동은 조치를 실행합니다.
  private fire(
    runtime: Runtime,
    chosen: Candidate,
    candidates: readonly Candidate[],
    now: number,
  ): void {
    const definition = runtime.definition;
    const { cluster } = this.options;
    const { namespace, deployment } = definition.target;
    runtime.lastFiredAt = now;
    runtime.fired = runtime.fired.filter((at) => at > now - RULE_HOUR_MS);

    const summary = cluster.deployments.get(namespace, deployment);
    const action = actionKindOf(definition);
    const target: ActionTarget =
      definition.action.kind === "scale"
        ? {
            kind: "deployment",
            namespace,
            name: deployment,
            uid: summary?.uid ?? "",
          }
        : {
            kind: "pod",
            namespace,
            name: chosen.pod.name,
            uid: chosen.summary.uid,
          };
    const base: Base = {
      id: this.newId(),
      rule: definition.name,
      mode: definition.mode === "auto" ? "auto" : "notify",
      at: now,
      action,
      target,
      pod: chosen.pod,
      deployment,
      conditions: definition.when.map((condition, index) => ({
        condition,
        since: chosen.sinces[index] ?? now,
        ...matchValues(chosen.results[index] as ConditionResult),
      })),
    };
    const skip = (
      reason: RuleSkipReason,
      extra: Partial<RuleFiring> = {},
    ): void => {
      this.record({
        ...base,
        ...extra,
        outcome: "skipped",
        skipReason: reason,
      });
    };

    if (
      definition.maxPerHour !== undefined &&
      runtime.fired.length >= definition.maxPerHour
    ) {
      skip("max-per-hour");
      return;
    }
    if (summary === undefined) {
      skip("no-deployment");
      return;
    }
    let scale: RuleFiring["scale"];
    if (definition.action.kind === "scale") {
      const from = summary.desired;
      scale = { from, to: scaleTarget(from, definition.action) };
      if (cluster.hpaOf(namespace, deployment) !== undefined) {
        skip("hpa", { scale });
        return;
      }
      if (scale.to === from) {
        skip("at-limit", { scale });
        return;
      }
    } else {
      if (
        definition.action.kind === "isolate" &&
        this.isolatedCount(namespace, deployment) >= MAX_RULE_ISOLATED
      ) {
        skip("isolated-limit");
        return;
      }
      const healthy = healthyPeers(
        candidates.map((candidate) => ({
          key: candidate.key,
          ready: candidate.summary.ready,
          severity: candidate.entry.severity,
          matching: candidate.all,
        })),
        chosen.key,
      );
      const needed = neededHealthy(summary.desired);
      if (healthy < needed) {
        skip("too-few-healthy", { healthy, needed });
        return;
      }
    }

    runtime.fired.push(now);
    const extra = scale === undefined ? {} : { scale };
    if (definition.mode !== "auto") {
      this.record({ ...base, ...extra, outcome: "notified" });
      return;
    }

    const request: ActionRequest = {
      action,
      target: { namespace, name: target.name },
      expectedUid: target.uid,
      ...(scale === undefined ? {} : { replicas: scale.to }),
    };
    const group = groupKey(definition.target);
    runtime.running = true;
    this.runningGroups.add(group);
    this.options.actions
      .run(request, { kind: "rule", name: definition.name })
      .then(
        (outcome) => {
          this.record({
            ...base,
            ...extra,
            outcome: "executed",
            actionId: outcome.item.id,
            actionResult: outcome.item.result,
            ...(outcome.item.error === undefined
              ? {}
              : { actionError: outcome.item.error }),
          });
        },
        (error: unknown) => {
          // ActionService.run은 실패를 기록으로 돌려주므로 여기 오는 것은 서버 버그입니다.
          log.error("rule action failed", {
            rule: definition.name,
            detail: error instanceof Error ? error.message : String(error),
          });
          this.record({
            ...base,
            ...extra,
            outcome: "executed",
            actionResult: "failed",
            actionError: "kube-error",
          });
        },
      )
      .finally(() => {
        runtime.running = false;
        this.runningGroups.delete(group);
      });
  }

  // 그 Deployment에서 트래픽에서 뺀 채 남아 있는 Pod 수입니다(결정 15 ③). 누가 뺐는지는 보지 않습니다.
  private isolatedCount(namespace: string, deployment: string): number {
    return this.options.cluster.pods
      .list()
      .filter(
        (pod) =>
          pod.namespace === namespace &&
          pod.isolation?.deployment === deployment,
      ).length;
  }

  private item(runtime: Runtime, now: number): RuleItem {
    const definition = runtime.definition;
    const coolingUntil =
      runtime.lastFiredAt === undefined
        ? undefined
        : runtime.lastFiredAt + definition.cooldownMs;
    return {
      ...definition,
      state: {
        matching: runtime.matching,
        ...(runtime.lastFiredAt === undefined
          ? {}
          : { lastFiredAt: runtime.lastFiredAt }),
        ...(coolingUntil !== undefined && now < coolingUntil
          ? { coolingUntil }
          : {}),
        firedLastHour: runtime.fired.filter((at) => at > now - RULE_HOUR_MS)
          .length,
        ...(runtime.running ? { running: true as const } : {}),
      },
      notes: this.notes(definition),
    };
  }

  // 규칙이 발동하지 못하거나 미리 알릴 것입니다(결정 19).
  private notes(definition: RuleDefinition): RuleNote[] {
    const { namespaces, actionNamespaces, cluster } = this.options;
    const { namespace, deployment } = definition.target;
    const notes: RuleNote[] = [];
    const watched = namespaces.includes(namespace);
    if (!watched) {
      notes.push("namespace-not-watched");
    }
    if (definition.mode === "auto" && !actionNamespaces.includes(namespace)) {
      notes.push("actions-disabled");
    }
    if (
      watched &&
      cluster.deployments.get(namespace, deployment) === undefined
    ) {
      notes.push("deployment-not-found");
    }
    if (
      definition.action.kind === "scale" &&
      cluster.hpaOf(namespace, deployment) !== undefined
    ) {
      notes.push("hpa");
    }
    return notes;
  }

  // 저장소에 남기고 화면에 알린 뒤 로그 한 줄을 씁니다.
  private record(firing: RuleFiring): void {
    this.options.store.addRuleFiring(firing).catch((error: unknown) => {
      log.warn("rule firing not stored", {
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      this.options.onFiring?.(firing);
    } catch (error) {
      log.warn("rule firing not streamed", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const fields: LogFields = {
      rule: firing.rule,
      mode: firing.mode,
      outcome: firing.outcome,
      action: firing.action,
      target: `${firing.target.namespace}/${firing.target.name}`,
      pod: podLabel(firing.pod),
      skip: firing.skipReason,
      healthy:
        firing.healthy === undefined
          ? undefined
          : `${firing.healthy}/${firing.needed ?? ""}`,
      replicas:
        firing.scale === undefined
          ? undefined
          : `${firing.scale.from}->${firing.scale.to}`,
      result: firing.actionResult,
      error: firing.actionError,
    };
    if (firing.actionResult === "failed") {
      log.warn("rule fired", fields);
    } else {
      log.info("rule fired", fields);
    }
  }
}

// 조건이 모두 맞는 Pod의 시각입니다(결정 12). since는 가장 늦게 맞기 시작한 조건, readyAt은 지속 시간을 채우는 시각입니다.
function matchOf(candidate: Candidate, definition: RuleDefinition): RuleMatch {
  let since = 0;
  let readyAt = 0;
  for (const [index, condition] of definition.when.entries()) {
    const start = candidate.sinces[index] as number;
    since = Math.max(since, start);
    readyAt = Math.max(readyAt, start + condition.forMs);
  }
  return { pod: candidate.pod, since, readyAt };
}
