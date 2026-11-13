// 데모 앱과 부하 스크립트의 설정입니다(docs/guides/T10.md 결정 5).
// 환경에 따라 달라지는 값은 환경변수로 받고, 없으면 기본값을 씁니다. 잘못된 값이면 예외를 던져 시작하지 않습니다.

export type Env = Record<string, string | undefined>;

export interface AppConfig {
  // 주문 API 포트입니다. 모든 주소에서 받습니다.
  port: number;
  // 고장 스위치(관리 API)를 여는 주소와 포트입니다. 기본은 127.0.0.1에만 엽니다(결정 6).
  adminHost: string;
  adminPort: number;
}

export interface LoadConfig {
  // 요청을 보낼 데모 앱 주소입니다. 경로는 쓰지 않습니다.
  target: URL;
  // 초당 보낼 요청 수입니다.
  rps: number;
}

// 값이 정수가 아니거나 범위를 벗어났습니다. 관리 API는 이 예외를 400으로 답합니다.
export class InvalidValueError extends Error {}

// 환경변수나 쿼리 문자열의 값을 정수로 읽습니다. 없거나 비어 있으면 fallback입니다.
// 같은 이름이 두 번 온 쿼리(?a=1&a=2)처럼 문자열이 아닌 값은 잘못된 값입니다.
export function readInteger(
  raw: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return fallback;
  }
  const value = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidValueError(
      `${name} must be an integer from ${min} to ${max} (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

export function loadAppConfig(env: Env): AppConfig {
  const port = readInteger(env.PORT, "PORT", 3000, 1, 65535);
  const adminPort = readInteger(env.ADMIN_PORT, "ADMIN_PORT", 3001, 1, 65535);
  if (port === adminPort) {
    throw new InvalidValueError(
      `PORT and ADMIN_PORT must be different (both ${port})`,
    );
  }
  const adminHost = env.ADMIN_HOST?.trim() || "127.0.0.1";
  return { port, adminHost, adminPort };
}

export function loadLoadConfig(env: Env): LoadConfig {
  const raw = env.LOAD_TARGET?.trim() || "http://localhost:3000";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new InvalidValueError(`LOAD_TARGET must be a URL (got "${raw}")`);
  }
  // 클러스터 안 Service 주소는 http입니다. https는 쓰지 않습니다.
  if (target.protocol !== "http:") {
    throw new InvalidValueError(
      `LOAD_TARGET must be an http:// URL (got "${raw}")`,
    );
  }
  const rps = readInteger(env.LOAD_RPS, "LOAD_RPS", 10, 1, 1000);
  return { target, rps };
}
