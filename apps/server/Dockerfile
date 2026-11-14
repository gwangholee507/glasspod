# Glasspod 서버 이미지입니다(docs/guides/T16.md). 데모 앱 이미지(examples/demo-app/Dockerfile)와 같은 방식입니다.
# '# syntax=' 줄은 두지 않습니다. 두면 빌드할 때마다 Docker Hub에서 고정되지 않은 프런트엔드 이미지를 받아 옵니다.
# 빌드 맥락은 저장소 루트입니다. 루트에서 npm run server:image로 만듭니다.
#   docker build -f apps/server/Dockerfile -t glasspod-server:dev .
# 웹 화면 빌드 결과(apps/web/dist)는 아직 넣지 않습니다. 서버가 웹 화면을 제공하는 것은 T20입니다.

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
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
# 서버와 그 references(protocol)를 각자의 dist/로 빌드하고, 테스트 파일의 결과는 지웁니다.
RUN npx --no-install tsc -b apps/server \
  && find packages/protocol/dist apps/server/dist -name '*.test.*' -delete

# 2단계: 서버가 실행할 때 쓰는 의존성만 설치합니다(express, ws, @kubernetes/client-node, ajv).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sdk-node/package.json packages/sdk-node/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY examples/demo-app/package.json examples/demo-app/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --workspace @glasspod/server

# 3단계: 실행 이미지. 빌드한 JS와 실행 의존성만 담고 개발 도구(TypeScript, tsx)는 넣지 않습니다.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# node_modules/@glasspod/*는 packages/ 아래를 가리키는 링크입니다. 가리키는 곳의 package.json과 dist/를 함께 넣습니다.
COPY --from=deps /app/node_modules node_modules
COPY packages/protocol/package.json packages/protocol/
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
WORKDIR /app/apps/server
# 공식 이미지에 있는 node 사용자(uid 1000)로 실행합니다. 쿠버네티스의 runAsNonRoot가 확인할 수 있게 숫자로 적습니다.
USER 1000:1000
EXPOSE 8080
# node가 PID 1로 SIGTERM을 직접 받습니다(npm을 거치지 않음). 서버는 SIGTERM에 SDK 연결과 watch를 닫고 끝납니다.
CMD ["node", "dist/index.js"]
