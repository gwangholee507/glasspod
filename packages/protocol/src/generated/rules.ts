// 이 파일은 `npm run generate`가 만든 것입니다. 직접 고치지 마세요.
// 고칠 때는 스키마(schema/rules.schema.json)를 고친 뒤 다시 만듭니다.

/**
 * 조건 하나입니다. 신호 이름(status, outlier, metric) 하나를 키로 씁니다.
 */
export type RuleConditionSpec =
  | StatusConditionSpec
  | OutlierConditionSpec
  | MetricAboveConditionSpec
  | MetricBelowConditionSpec;
/**
 * SDK 지표 이름(예: app.queue.length, http.requests.duration_p99_ms)이나 event:error(error 수준 SDK event의 분당 수)입니다.
 */
export type SignalMetric = string;
/**
 * 조치 하나입니다. restart: 조건이 맞은 Pod 재시작, isolate: 그 Pod를 트래픽에서 빼기, scale: 그 Deployment의 replica 수 바꾸기
 */
export type RuleActionSpec =
  RestartActionSpec | IsolateActionSpec | ScaleActionSpec;
/**
 * 지금 원하는 replica 수에 by를 더하고 min~max로 자릅니다. 늘리면(by > 0) max, 줄이면 min이 필요합니다.
 */
export type ScaleOptions = {
  by: number;
  min?: number;
  max?: number;
};

/**
 * 자동 규칙 파일입니다(design.md 5.5, docs/guides/T28.md). ConfigMap glasspod-rules의 rules.yaml을 YAML로 읽은 값이고, 서버는 validateRulesFile로 검증합니다. 사람이 손으로 쓰는 파일이라 모르는 필드는 틀린 파일로 봅니다(오타를 그냥 지나치지 않음).
 */
export interface RulesFile {
  /**
   * 규칙입니다. 서버는 이 순서로 봅니다. 이름은 파일 안에서 겹치지 않아야 합니다(서버가 따로 확인).
   *
   * @maxItems 50
   */
  rules: RuleSpec[];
}
/**
 * 규칙 하나입니다: 조건(when)이 모두 지속 시간(for)만큼 맞으면 조치(action)를 합니다. 모드가 notify면 실행하지 않고 '실행했을 것'만 남깁니다.
 */
export interface RuleSpec {
  /**
   * 규칙 이름입니다(DNS-1123 label). 조치 기록의 실행 주체와 격리 주석(rule:<이름>)에 남습니다.
   */
  name: string;
  /**
   * off: 보지 않음(기본), notify: 알림만(실행했을 것을 기록), auto: 자동 실행
   */
  mode?: "off" | "notify" | "auto";
  /**
   * 화면에 보일 설명입니다.
   */
  description?: string;
  target: RuleTarget;
  /**
   * 조건입니다. 모두 맞을 때만(AND) 발동합니다. OR가 필요하면 규칙을 둘로 나눕니다.
   *
   * @minItems 1
   * @maxItems 5
   */
  when:
    | [RuleConditionSpec]
    | [RuleConditionSpec, RuleConditionSpec]
    | [RuleConditionSpec, RuleConditionSpec, RuleConditionSpec]
    | [
        RuleConditionSpec,
        RuleConditionSpec,
        RuleConditionSpec,
        RuleConditionSpec,
      ]
    | [
        RuleConditionSpec,
        RuleConditionSpec,
        RuleConditionSpec,
        RuleConditionSpec,
        RuleConditionSpec,
      ];
  action: RuleActionSpec;
  /**
   * 발동한 뒤 쉬는 시간입니다(30s~24h). 알림만·실행·건너뜀 모두 쉽니다.
   */
  cooldown: string;
  /**
   * 최근 1시간에 발동할 수 있는 횟수(알림만과 실행)입니다. 넘으면 건너뜁니다.
   */
  maxPerHour?: number;
}
/**
 * 규칙이 보는 Pod입니다. 이 namespace에서 이 Deployment가 만든 Pod입니다.
 */
export interface RuleTarget {
  namespace: string;
  deployment: string;
}
/**
 * 서버의 판단(design.md 7.5)이 이 가운데 하나입니다.
 */
export interface StatusConditionSpec {
  /**
   * @minItems 1
   */
  status: [
    (
      | "terminated"
      | "pod-failing"
      | "stalled"
      | "disconnected"
      | "restarted"
      | "not-ready"
      | "starting"
      | "no-sdk"
      | "ok"
    ),
    ...(
      | "terminated"
      | "pod-failing"
      | "stalled"
      | "disconnected"
      | "restarted"
      | "not-ready"
      | "starting"
      | "no-sdk"
      | "ok"
    )[],
  ];
  /**
   * 이 조건이 이어져야 하는 시간입니다(0s~1h).
   */
  for: string;
}
/**
 * 이 값이 같은 Deployment의 다른 Pod보다 눈에 띄게 높습니다(design.md 7.6, 강조가 켜진 상태).
 */
export interface OutlierConditionSpec {
  outlier: SignalMetric;
  /**
   * 강조가 켜진 뒤 이어져야 하는 시간입니다(0s~1h).
   */
  for: string;
}
/**
 * 지표 값이 기준보다 큽니다. gauge는 마지막 값, counter와 event:error는 최근 60초(분당)입니다.
 */
export interface MetricAboveConditionSpec {
  metric: SignalMetric;
  above: number;
  /**
   * 이 조건이 이어져야 하는 시간입니다(0s~1h).
   */
  for: string;
}
/**
 * 지표 값이 기준보다 작습니다. gauge는 마지막 값, counter와 event:error는 최근 60초(분당)입니다.
 */
export interface MetricBelowConditionSpec {
  metric: SignalMetric;
  below: number;
  /**
   * 이 조건이 이어져야 하는 시간입니다(0s~1h).
   */
  for: string;
}
export interface RestartActionSpec {
  restart: EmptyOptions;
}
export interface EmptyOptions {}
export interface IsolateActionSpec {
  isolate: EmptyOptions;
}
export interface ScaleActionSpec {
  scale: ScaleOptions;
}
