# Glasspod 데모 앱 이미지입니다(docs/guides/T15.md).
# '# syntax=' 줄은 두지 않습니다. 두면 빌드할 때마다 Docker Hub에서 고정되지 않은 프런트엔드 이미지를 받아 옵니다.
# Docker 29의 내장 프런트엔드가 RUN --mount=type=cache를 지원합니다.
# 빌드 맥락은 저장소 루트입니다. 루트에서 npm run demo:image로 만듭니다.
#   docker build -f examples/demo-app/Dockerfile -t glasspod-demo-app:dev .
# 같은 이미지로 부하 스크립트도 띄웁니다(node dist/load.js, deploy/demo/load.yaml).

# node:22.22.0-bookworm-slim(2026-02-24 빌드). 태그가 다시 만들어져도 바뀌지 않게 digest로 고정합니다.
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

# 1단계: 의존성을 모두 설치하고 TypeScript를 JS로 빌드합니다.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# npm ci는 lockfile과 모든 워크스페이스의 package.json이 맞는지 보므로 다섯 개를 모두 넣습니다.
COPY package.json package-lock.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sdk-node/package.json packages/sdk-node/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY examples/demo-app/package.json examples/demo-app/
# 설치 스크립트는 빌드에 필요 없어 돌리지 않습니다.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/protocol/tsconfig.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY packages/sdk-node/tsconfig.json packages/sdk-node/
COPY packages/sdk-node/src packages/sdk-node/src
COPY examples/demo-app/tsconfig.json examples/demo-app/
COPY examples/demo-app/src examples/demo-app/src
# 데모 앱과 그 references(sdk-node, protocol)를 각자의 dist/로 빌드하고, 테스트 파일의 결과는 지웁니다.
RUN npx --no-install tsc -b examples/demo-app \
  && find packages/protocol/dist packages/sdk-node/dist examples/demo-app/dist -name '*.test.*' -delete

# 2단계: 데모 앱이 실행할 때 쓰는 의존성만 설치합니다(express, ajv).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sdk-node/package.json packages/sdk-node/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY examples/demo-app/package.json examples/demo-app/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --workspace @glasspod/demo-app

# 3단계: 실행 이미지. 빌드한 JS와 실행 의존성만 담고 개발 도구(TypeScript, tsx)는 넣지 않습니다.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# node_modules/@glasspod/*는 packages/ 아래를 가리키는 링크입니다. 가리키는 곳의 package.json과 dist/를 함께 넣습니다.
COPY --from=deps /app/node_modules node_modules
COPY packages/protocol/package.json packages/protocol/
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY packages/sdk-node/package.json packages/sdk-node/
COPY --from=build /app/packages/sdk-node/dist packages/sdk-node/dist
COPY examples/demo-app/package.json examples/demo-app/
COPY --from=build /app/examples/demo-app/dist examples/demo-app/dist
WORKDIR /app/examples/demo-app
# 공식 이미지에 있는 node 사용자(uid 1000)로 실행합니다. 쿠버네티스의 runAsNonRoot가 확인할 수 있게 숫자로 적습니다.
USER 1000:1000
EXPOSE 3000
# node가 PID 1로 SIGTERM을 직접 받습니다(npm을 거치지 않음). 데모 앱은 SIGTERM을 처리하고 스스로 끝납니다(T10 결정 20).
CMD ["node", "dist/index.js"]
