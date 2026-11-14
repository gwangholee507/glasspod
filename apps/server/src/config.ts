// 서버 설정입니다. 환경에 따라 달라지는 값은 환경변수로 받고, 없으면 design.md의 값을 씁니다.
export interface ServerConfig {
  // HTTP(/health)와 SDK WebSocket(/agent)을 함께 받는 포트입니다.
  port: number;
  // welcome으로 SDK에 알리는 metrics 주기(ms)와 1분 event 한도입니다(design.md 7.3).
  metricsIntervalMs: number;
  maxEventsPerMinute: number;
  // welcome 뒤 SDK에 heartbeat를 보내는 주기(ms)입니다. welcome으로도 알립니다(design.md 7.4).
  heartbeatIntervalMs: number;
  // 쿠버네티스에서 watch할 namespace입니다. 같은 이름은 한 번만 들어 있습니다(docs/guides/T12.md).
  namespaces: string[];
  // 클러스터 밖에서 쓸 kubeconfig context입니다. 없으면 클러스터 안에서만 watch합니다.
  kubeContext: string | undefined;
}

// 쿠버네티스 namespace 이름 규칙(DNS-1123 label)입니다.
const NAMESPACE_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_NAMESPACE_LENGTH = 63;

// Node 타이머가 받는 가장 긴 간격입니다. 넘으면 Node가 1ms로 바꿔 버립니다.
const MAX_TIMER_MS = 2_147_483_647;

type Env = Record<string, string | undefined>;

// 값이 없으면 기본값을 쓰고, 정수가 아니거나 범위를 벗어나면 시작하지 않도록 예외를 던집니다.
function readInteger(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer from ${min} to ${max} (got "${raw}")`,
    );
  }
  return value;
}

// 쉼표로 나눈 namespace 목록을 읽습니다. 빈 항목이나 규칙에 맞지 않는 이름이 있으면 시작하지 않습니다.
function readNamespaces(env: Env, name: string, fallback: string): string[] {
  const raw = env[name];
  const text = raw === undefined || raw.trim() === "" ? fallback : raw;
  const namespaces: string[] = [];
  for (const part of text.split(",")) {
    const namespace = part.trim();
    if (
      namespace.length > MAX_NAMESPACE_LENGTH ||
      !NAMESPACE_PATTERN.test(namespace)
    ) {
      throw new Error(
        `${name} must be a comma-separated list of namespace names (got "${raw}")`,
      );
    }
    if (!namespaces.includes(namespace)) {
      namespaces.push(namespace);
    }
  }
  return namespaces;
}

// 값이 없거나 공백뿐이면 undefined입니다.
function readOptionalText(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function loadConfig(env: Env): ServerConfig {
  return {
    port: readInteger(env, "GLASSPOD_PORT", 8080, 1, 65535),
    // 범위는 프로토콜 스키마(welcome)와 같습니다.
    metricsIntervalMs: readInteger(
      env,
      "GLASSPOD_METRICS_INTERVAL_MS",
      5000,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxEventsPerMinute: readInteger(
      env,
      "GLASSPOD_MAX_EVENTS_PER_MINUTE",
      120,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    // 서버가 직접 타이머로 보내므로 상한은 Node 타이머 상한입니다.
    // 하한은 heartbeat가 모든 앱의 이벤트 루프를 바쁘게 만들지 않게 1초로 둡니다(스키마는 1 이상).
    heartbeatIntervalMs: readInteger(
      env,
      "GLASSPOD_HEARTBEAT_INTERVAL_MS",
      15_000,
      1000,
      MAX_TIMER_MS,
    ),
    namespaces: readNamespaces(env, "GLASSPOD_NAMESPACES", "glasspod-demo"),
    kubeContext: readOptionalText(env, "GLASSPOD_KUBE_CONTEXT"),
  };
}
