// 웹 화면의 개발 서버와 빌드 설정입니다(docs/guides/T17.md).
// 개발 서버는 /api 요청을 Glasspod 서버로 넘깁니다. 브라우저는 같은 출처의 /api만 부릅니다.
import type { ServerResponse } from "node:http";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// 프록시가 요청을 넘길 Glasspod 서버입니다. 서버의 기본 포트(GLASSPOD_PORT 8080)와 맞춥니다.
const DEFAULT_PROXY_TARGET = "http://localhost:8080";

// 값이 없으면 기본값을 쓰고, http(s) 출처(경로·쿼리·사용자 정보 없음)가 아니면 개발 서버를 시작하지 않습니다.
function readProxyTarget(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PROXY_TARGET;
  }
  const problem = `GLASSPOD_WEB_PROXY_TARGET must be an http(s) origin like ${DEFAULT_PROXY_TARGET} (got "${raw}")`;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(problem);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(problem);
  }
  return url.origin;
}

// 서버에 닿지 못하면 Vite는 빈 본문의 502로 답합니다. 화면에 원인이 보이게 서버의 오류 본문과 같은 모양으로 먼저 답합니다.
// Vite의 오류 처리기는 이 뒤에 붙어 로그를 남기고, 이미 답한 응답에는 쓰지 않습니다.
function answerProxyError(
  target: string,
  error: Error,
  response: ServerResponse,
): void {
  if (response.headersSent || response.writableEnded) {
    return;
  }
  const code = (error as NodeJS.ErrnoException).code ?? error.message;
  response
    .writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    })
    .end(
      JSON.stringify({
        error: "proxy-error",
        detail: `cannot reach the Glasspod server at ${target} (${code})`,
      }),
    );
}

export default defineConfig(({ command }) => {
  // 빌드에서는 프록시를 쓰지 않으므로 환경변수를 읽지 않습니다.
  const target =
    command === "serve"
      ? readProxyTarget(process.env.GLASSPOD_WEB_PROXY_TARGET)
      : DEFAULT_PROXY_TARGET;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      // 라이브러리 패키지(@glasspod/protocol)를 빌드 없이 src/에서 씁니다(docs/guides/T01.md).
      conditions: ["@glasspod/source", ...defaultClientConditions],
    },
    server: {
      // 서버 HTTP API에 아직 인증이 없으므로(D4) 개발 서버는 기본값대로 localhost에만 엽니다.
      proxy: {
        "/api": {
          target,
          configure(proxy) {
            proxy.on("error", (error, _request, response) => {
              if ("req" in response) {
                answerProxyError(target, error, response);
              }
            });
          },
        },
      },
    },
  };
});
