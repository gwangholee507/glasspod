// SDK 설정입니다. 환경에 따라 달라지는 값(서버 주소, Pod 정보)은 환경변수에서 읽습니다(design.md 8장).
// 문제가 있으면 SDK를 끄고 앱은 그대로 둡니다. 그래서 예외를 던지지 않고 문제 목록을 돌려줍니다.
import type { PodRef } from "@glasspod/protocol";

export interface SdkConfig {
  // 서버의 WebSocket 주소입니다. 예: ws://glasspod-server.glasspod.svc.cluster.local:8080/agent
  serverUrl: string;
  // 이 앱이 도는 Pod입니다. 쿠버네티스에서는 Downward API로 받습니다.
  pod: PodRef;
}

export type ConfigResult =
  { ok: true; config: SdkConfig } | { ok: false; problems: string[] };

type Env = Record<string, string | undefined>;

// 앞뒤 공백을 지우고, 빈 값은 없는 것으로 봅니다.
function readValue(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

// 주소가 올바르면 정규화한 주소를, 아니면 문제를 돌려줍니다.
function checkServerUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; problem: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: "GLASSPOD_SERVER is not a valid URL" };
  }
  // 내장 WebSocket은 http://도 받아 ws://로 바꾸지만, 설정 실수를 드러내려고 ws://와 wss://만 받습니다.
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return {
      ok: false,
      problem: `GLASSPOD_SERVER must start with ws:// or wss:// (got "${url.protocol}")`,
    };
  }
  // #가 있으면 WebSocket 생성자가 예외를 던집니다. 빈 #도 마찬가지라 hash 대신 href를 봅니다.
  if (url.href.includes("#")) {
    return { ok: false, problem: "GLASSPOD_SERVER must not contain #" };
  }
  return { ok: true, url: url.href };
}

export function readConfig(env: Env): ConfigResult {
  const problems: string[] = [];

  const server = readValue(env, "GLASSPOD_SERVER");
  let serverUrl: string | undefined;
  if (server === undefined) {
    problems.push("GLASSPOD_SERVER is not set");
  } else {
    const checked = checkServerUrl(server);
    if (checked.ok) {
      serverUrl = checked.url;
    } else {
      problems.push(checked.problem);
    }
  }

  const name = readValue(env, "POD_NAME");
  if (name === undefined) {
    problems.push("POD_NAME is not set");
  }
  const namespace = readValue(env, "POD_NAMESPACE");
  if (namespace === undefined) {
    problems.push("POD_NAMESPACE is not set");
  }

  if (
    serverUrl === undefined ||
    name === undefined ||
    namespace === undefined
  ) {
    return { ok: false, problems };
  }
  return { ok: true, config: { serverUrl, pod: { namespace, name } } };
}
