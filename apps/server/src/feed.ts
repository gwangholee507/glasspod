// 판단 주기마다 목록(Pod 항목, Deployment 항목, namespace)을 다시 만들고 앞 주기와 비교해 바뀐 것을 계산합니다
// (docs/guides/T14.md 결정 2, 16). 목록 GET과 SSE의 처음 pods는 이 마지막 주기의 값입니다.
import type {
  ActionItem,
  DeploymentItem,
  PodItem,
  PodListBody,
  PodListChanges,
  PodOutlier,
  PodRef,
  RuleFiring,
  RulesView,
} from "@glasspod/protocol";
import type { ClusterState } from "./cluster.js";
import type { AppStates } from "./pods.js";
import { podKey } from "./pod-key.js";
import { stallLimitMs } from "./status.js";
import type { StatusMonitor } from "./status-monitor.js";
import type { StatusChangeRecord } from "./store/store.js";
import { deploymentItem, podItem, statusChangeItem } from "./views.js";

export interface PodFeedOptions {
  statuses: StatusMonitor;
  apps: AppStates;
  cluster: ClusterState;
  // GLASSPOD_NAMESPACES입니다. namespace 목록의 앞에 이 순서대로 둡니다.
  namespaces: readonly string[];
  // GLASSPOD_ACTION_NAMESPACES입니다. 목록 본문에 그대로 넣습니다(docs/guides/T21.md 결정 12).
  actionNamespaces?: readonly string[];
  // SDK 지표 주기입니다. 목록 지표의 오래된 값 기준(3주기)을 정합니다(docs/guides/T34.md 결정 4).
  metricsIntervalMs: number;
  // 같은 Deployment의 다른 Pod보다 높은 값입니다(OutlierMonitor, T34). 없으면 outliers를 넣지 않습니다.
  outliers?: { get(pod: PodRef): readonly PodOutlier[] };
  // 자동 규칙 보기입니다(RuleEngine, docs/guides/T28.md 결정 18). 바뀐 주기에만 changes.rules로 보냅니다.
  rules?: { view(): RulesView };
  now?: () => number;
}

interface Tracked<T> {
  item: T;
  // 앞 주기와 비교할 JSON입니다.
  json: string;
}

// namespace, 이름 순서입니다.
function compareRefs(a: PodRef, b: PodRef): number {
  if (a.namespace !== b.namespace) {
    return a.namespace < b.namespace ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class PodFeed {
  private readonly statuses: StatusMonitor;
  private readonly apps: AppStates;
  private readonly cluster: ClusterState;
  private readonly watched: readonly string[];
  private readonly actionNamespaces: readonly string[];
  private readonly freshMs: number;
  private readonly outliers: PodFeedOptions["outliers"];
  private readonly rules: PodFeedOptions["rules"];
  private readonly now: () => number;
  // 앞 주기 뒤에 끝난 조치입니다. 다음 refresh의 changes에 넣고 비웁니다.
  private pendingActions: ActionItem[] = [];
  // 앞 주기 뒤에 남긴 규칙 기록입니다. 다음 refresh의 changes에 넣고 비웁니다.
  private pendingRuleFirings: RuleFiring[] = [];
  // 앞 주기의 규칙 보기 JSON입니다.
  private rulesJson: string | undefined;
  private pods = new Map<string, Tracked<PodItem>>();
  private deployments = new Map<string, Tracked<DeploymentItem>>();
  private namespaces: string[];
  private serverTime: number;

  constructor(options: PodFeedOptions) {
    this.statuses = options.statuses;
    this.apps = options.apps;
    this.cluster = options.cluster;
    this.watched = options.namespaces;
    this.actionNamespaces = options.actionNamespaces ?? [];
    this.freshMs = stallLimitMs(options.metricsIntervalMs);
    this.outliers = options.outliers;
    this.rules = options.rules;
    this.now = options.now ?? Date.now;
    this.namespaces = [...this.watched];
    this.serverTime = this.now();
  }

  // 끝난 조치를 다음 판단 주기의 changes로 보내도록 넣어 둡니다.
  queueAction(item: ActionItem): void {
    this.pendingActions.push(item);
  }

  // 남긴 규칙 기록을 다음 판단 주기의 changes로 보내도록 넣어 둡니다.
  queueRuleFiring(firing: RuleFiring): void {
    this.pendingRuleFirings.push(firing);
  }

  // 판단(StatusMonitor.evaluate) 바로 뒤에 부릅니다. statusChanges는 evaluate가 돌려준 판단 변화입니다.
  refresh(statusChanges: readonly StatusChangeRecord[] = []): PodListChanges {
    const now = this.now();
    this.serverTime = now;

    const nextPods = new Map<string, Tracked<PodItem>>();
    const entries = this.statuses
      .list()
      .sort((a, b) => compareRefs(a.pod, b.pod));
    for (const entry of entries) {
      const item = podItem(
        entry,
        this.cluster.pods.get(entry.pod.namespace, entry.pod.name),
        this.apps.get(entry.pod),
        now,
        this.freshMs,
        this.outliers?.get(entry.pod),
      );
      nextPods.set(podKey(item.pod), { item, json: JSON.stringify(item) });
    }

    const nextDeployments = new Map<string, Tracked<DeploymentItem>>();
    const summaries = this.cluster.deployments.list().sort(compareRefs);
    for (const summary of summaries) {
      const item = deploymentItem(
        summary,
        this.cluster.hpaOf(summary.namespace, summary.name),
      );
      nextDeployments.set(podKey(item), { item, json: JSON.stringify(item) });
    }

    const changes: PodListChanges = {
      serverTime: now,
      pods: changedItems(this.pods, nextPods),
      removedPods: removedRefs(this.pods, nextPods, (item) => item.pod),
      deployments: changedItems(this.deployments, nextDeployments),
      removedDeployments: removedRefs(
        this.deployments,
        nextDeployments,
        (item) => ({ namespace: item.namespace, name: item.name }),
      ),
      statusChanges: statusChanges.map(statusChangeItem),
      actions: this.pendingActions,
      ruleFirings: this.pendingRuleFirings,
    };
    this.pendingActions = [];
    this.pendingRuleFirings = [];

    if (this.rules !== undefined) {
      const view = this.rules.view();
      const json = JSON.stringify(view);
      if (json !== this.rulesJson) {
        changes.rules = view;
        this.rulesJson = json;
      }
    }

    const namespaces = this.namespaceList(entries.map((entry) => entry.pod));
    if (namespaces.join("\n") !== this.namespaces.join("\n")) {
      changes.namespaces = namespaces;
    }

    this.pods = nextPods;
    this.deployments = nextDeployments;
    this.namespaces = namespaces;
    return changes;
  }

  // 마지막 주기의 목록입니다. namespace를 주면 그 namespace만(namespace 목록은 거르지 않음).
  list(namespace?: string): PodListBody {
    const pods: PodItem[] = [];
    for (const { item } of this.pods.values()) {
      if (namespace === undefined || item.pod.namespace === namespace) {
        pods.push(item);
      }
    }
    const deployments: DeploymentItem[] = [];
    for (const { item } of this.deployments.values()) {
      if (namespace === undefined || item.namespace === namespace) {
        deployments.push(item);
      }
    }
    return {
      serverTime: this.serverTime,
      namespaces: [...this.namespaces],
      actionNamespaces: [...this.actionNamespaces],
      deployments,
      pods,
    };
  }

  // 마지막 주기의 Pod 항목입니다. 판단이 없는 Pod면 undefined입니다.
  item(pod: PodRef): PodItem | undefined {
    return this.pods.get(podKey(pod))?.item;
  }

  // GLASSPOD_NAMESPACES 순서, 그 뒤 판단에만 있는 namespace를 이름순으로 둡니다(결정 8).
  private namespaceList(pods: readonly PodRef[]): string[] {
    const extra = new Set<string>();
    for (const pod of pods) {
      if (!this.watched.includes(pod.namespace)) {
        extra.add(pod.namespace);
      }
    }
    return [...this.watched, ...[...extra].sort()];
  }
}

function changedItems<T>(
  previous: ReadonlyMap<string, Tracked<T>>,
  next: ReadonlyMap<string, Tracked<T>>,
): T[] {
  const items: T[] = [];
  for (const [key, tracked] of next) {
    if (previous.get(key)?.json !== tracked.json) {
      items.push(tracked.item);
    }
  }
  return items;
}

function removedRefs<T>(
  previous: ReadonlyMap<string, Tracked<T>>,
  next: ReadonlyMap<string, Tracked<T>>,
  refOf: (item: T) => PodRef,
): PodRef[] {
  const refs: PodRef[] = [];
  for (const [key, tracked] of previous) {
    if (!next.has(key)) {
      refs.push(refOf(tracked.item));
    }
  }
  return refs;
}

// 한 namespace만 보는 연결에 보낼 변화입니다. 보낼 것이 없으면 undefined입니다.
// namespace 목록(namespaces)은 거르지 않습니다.
export function filterChanges(
  changes: PodListChanges,
  namespace: string | undefined,
): PodListChanges | undefined {
  const filtered: PodListChanges =
    namespace === undefined
      ? changes
      : {
          serverTime: changes.serverTime,
          pods: changes.pods.filter((item) => item.pod.namespace === namespace),
          removedPods: changes.removedPods.filter(
            (pod) => pod.namespace === namespace,
          ),
          deployments: changes.deployments.filter(
            (item) => item.namespace === namespace,
          ),
          removedDeployments: changes.removedDeployments.filter(
            (ref) => ref.namespace === namespace,
          ),
          statusChanges: changes.statusChanges.filter(
            (change) => change.pod.namespace === namespace,
          ),
          actions: changes.actions.filter(
            (item) => item.target.namespace === namespace,
          ),
          ruleFirings: changes.ruleFirings.filter(
            (firing) => firing.target.namespace === namespace,
          ),
          ...(changes.rules === undefined
            ? {}
            : { rules: rulesIn(changes.rules, namespace) }),
          ...(changes.namespaces === undefined
            ? {}
            : { namespaces: changes.namespaces }),
        };
  const empty =
    filtered.pods.length === 0 &&
    filtered.removedPods.length === 0 &&
    filtered.deployments.length === 0 &&
    filtered.removedDeployments.length === 0 &&
    filtered.statusChanges.length === 0 &&
    filtered.actions.length === 0 &&
    filtered.ruleFirings.length === 0 &&
    filtered.rules === undefined &&
    filtered.namespaces === undefined;
  return empty ? undefined : filtered;
}

// 한 namespace의 규칙만 남긴 보기입니다. 파일 상태는 그대로 둡니다. namespace가 없으면 전부입니다.
export function rulesIn(
  view: RulesView,
  namespace: string | undefined,
): RulesView {
  return namespace === undefined
    ? view
    : {
        file: view.file,
        rules: view.rules.filter((rule) => rule.target.namespace === namespace),
      };
}
