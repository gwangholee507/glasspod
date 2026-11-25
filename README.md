<p align="center">
  <img src="docs/assets/logo.svg" alt="Glasspod 로고" width="96" height="96">
</p>

<h1 align="center">Glasspod</h1>

<p align="center">
  <b>See inside your pods</b><br>
  Pod 속까지 투명하게
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-%EA%B0%9C%EB%B0%9C%20%EC%A4%91-orange" alt="status: 개발 중">
  <img src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Kubernetes-326CE5?logo=kubernetes&logoColor=white" alt="Kubernetes">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
</p>

---

Glasspod는 **컨테이너 안의 앱이 실제로 어떻게 돌고 있는지 개발자가 보고, 그 판단으로 쿠버네티스 API를 호출해 조치하는 개발 도구**입니다.

쿠버네티스는 컨테이너를 알고, Glasspod는 앱을 압니다.

> 개발 중입니다. 로컬 클러스터(Docker Desktop)에서 관찰부터 조치까지 동작하고, 첫 마일스톤인 [대표 시나리오](docs/design.md#6-대표-시나리오-pod-하나가-느려질-때) 점검을 앞두고 있습니다.

## 왜 필요한가

쿠버네티스는 헬스체크 결과만 보고 컨테이너를 재시작하거나 교체합니다. 실제로 운영해 보면 이것만으로는 부족할 때가 많습니다.

- 원인이 그대로면 컨테이너를 갈아 끼워도 같은 문제가 반복됩니다(CrashLoopBackOff).
- 교체하는 순간 원인을 찾을 단서(메모리 상태, 진행 중이던 요청, 직전 예외)도 함께 사라집니다.
- 살아는 있는데 느려지거나 큐가 쌓이는 상태는 헬스체크로 잡히지 않습니다.

Glasspod는 앱 안에 넣은 SDK로 앱 수준의 상태를 보고, 원인을 찾고, 필요하면 바로 조치할 수 있게 돕습니다.

## 주요 기능

- **앱 내부 지표 수집**: SDK가 이벤트 루프 지연, 힙, HTTP 응답 시간, 예외, 앱이 등록한 값(큐 길이 등)을 서버로 보냅니다. 서버가 없거나 연결이 끊겨도 앱은 그대로 동작합니다.
- **Pod 상태 판단**: 서버가 1초마다 SDK 신호와 쿠버네티스 상태를 합쳐 정상, 앱 멈춤 의심, 연결 끊김, 재시작, Pod 이상 등으로 판단합니다. 재시작이면 OOMKilled 같은 종료 이유와 직전 예외를 원인 후보로 보여 줍니다.
- **다른 Pod와 지표 비교**: 같은 Deployment의 다른 Pod보다 이벤트 루프 지연, 힙, 요청 응답 시간, 5xx, 예외, 앱이 등록한 값이 눈에 띄게 높은 Pod를 찾아 강조합니다. 헬스체크는 통과하는데 한 Pod만 느린 경우를 바로 봅니다.
- **실시간 화면**: Pod 목록은 위험한 Pod를 '지금 볼 것'으로 묶어 맨 위에 둡니다. 상세 화면은 '무슨 일이 있었나' 타임라인, 지표 그래프, snapshot(처리 중인 요청, 상태 값)을 보여 줍니다.
- **수동 조치**: Pod 재시작, 트래픽에서 빼기(격리), 스케일 조정. 실행 전에 일어날 일과 경고를 보여 주고, 모든 조치를 성공 · 실패와 함께 기록합니다.
- **최소 권한**: 쿠버네티스 권한은 서버만 가지며, 감시 대상 namespace로 한정한 Role을 씁니다. 브라우저는 쿠버네티스를 직접 부르지 않습니다.
- **고장 데모 앱**: 일부러 느려지거나, 막히거나, 예외를 쏟거나, 죽거나, 메모리가 늘어나는 주문 앱으로 기능을 직접 확인할 수 있습니다.

## 동작 방식

```text
[Pod 안: 내 앱 + SDK]
   |  (1) 앱 내부 상태를 보냄 (push, WebSocket)
   v
[Glasspod 서버] <-- (2) Kubernetes API를 watch해 Pod, Deployment 상태를 받음
   |            --> (4) 조치가 정해지면 Kubernetes API 호출
   v
[웹 화면]  (3) 개발자가 보고, 버튼을 누르면 서버로 요청
```

- **SDK** (`packages/sdk-node`): 앱 안에서 상태를 모아 서버로 보내고, 서버의 snapshot 요청에 답합니다.
- **서버** (`apps/server`): 클러스터 안 Deployment로 돌며 SDK 연결과 쿠버네티스 watch를 Pod 단위로 합칩니다. Pod별 최근 30분 기록을 들고 있고, 웹 화면에 조회 API와 SSE로 실시간 변화를 보냅니다.
- **웹 화면** (`apps/web`): 목록 · 상세를 보고, 확인 서랍을 거쳐 조치를 요청합니다.

## 빠르게 시작하기

### 준비물

- Node.js 22.22.0 (`.nvmrc`)
- 클러스터에서 돌려 볼 때: Docker Desktop의 Kubernetes(context `docker-desktop`)와 `kubectl`

```bash
npm install
```

### 노트북에서만 띄워 보기 (클러스터 없이)

터미널 네 개에서 서버, 데모 앱, 부하, 웹 화면을 띄웁니다. 쿠버네티스 상태와 조치는 클러스터가 있어야 보입니다.

```bash
npm run dev:server
GLASSPOD_SERVER=ws://localhost:8080/agent POD_NAME=demo-1 POD_NAMESPACE=glasspod-demo npm run demo
npm run demo:load
npm run dev:web
```

`http://localhost:5173`을 엽니다.

### 로컬 클러스터에서 띄워 보기

```bash
kubectl config current-context        # docker-desktop인지 확인
npm run demo:image && npm run server:image
kubectl apply -f deploy/demo/         # 데모 앱 Pod 3개 + Service + 부하 Pod
kubectl apply -f deploy/server/       # 서버 + ServiceAccount + Role
kubectl -n glasspod port-forward service/glasspod-server 8080:8080
npm run dev:web                       # 다른 터미널에서
```

`http://localhost:5173/?namespace=glasspod-demo`를 엽니다.

### 고장 일으켜 보기

데모 앱의 고장 스위치는 Pod 안의 관리 포트(3001)에만 열려 있어 port-forward로 씁니다.

```bash
kubectl -n glasspod-demo port-forward pod/<Pod 이름> 3001:3001
curl -s -X POST 'localhost:3001/faults/slow?delayMs=1500'   # 느려짐
curl -s -X DELETE localhost:3001/faults                     # 모두 끔
```

| 스위치 | 고장 | 값 (기본) |
| --- | --- | --- |
| `POST /faults/slow` | 느려짐 | `delayMs` (1500) |
| `POST /faults/block` | 이벤트 루프 막힘 | `seconds` (20) |
| `POST /faults/errors` | 예외 폭주 | `perSecond` (50), `distinct` (1) |
| `POST /faults/leak` | 메모리 증가 (한도를 넘으면 OOMKilled) | `mbPerSec` (10) |
| `POST /faults/crash` | 프로세스 종료 | |

이어지는 고장은 같은 경로의 `DELETE`로 끕니다. 자세한 값 범위는 [T10 지침서](docs/guides/T10.md)에 있습니다.

## SDK 쓰기

SDK는 아직 npm에 올리지 않았습니다. 지금은 이 저장소 안에서 `@glasspod/sdk`로 씁니다([데모 앱](examples/demo-app) 참고).

```js
import { glasspod } from '@glasspod/sdk';

glasspod.start({ app: { name: 'orders', version: '1.4.2' } }); // 환경변수에서 서버 주소와 Pod 정보를 읽음
app.use(glasspod.express());                            // HTTP 요청 자동 수집 (라우트 앞)
app.use(glasspod.expressErrors());                      // Express가 잡은 예외를 라우트와 함께 보냄 (라우트 뒤)
glasspod.gauge('app.queue.length', () => queue.length); // 앱 고유 값 등록
glasspod.counter('app.orders.created').inc();           // 누적값 등록
glasspod.state('app.mode', 'ready');                    // 상태 등록, 바뀌면 서버로 알림
glasspod.exception(err, { route: 'GET /orders' });      // 앱이 잡은 예외 보고
glasspod.stop();                                        // 종료 처리에서 연결을 닫음
```

앱의 Deployment에는 환경변수 세 개를 넣습니다. 하나라도 없으면 SDK는 경고 한 줄을 남기고 꺼지며, 앱은 그대로 동작합니다.

```yaml
env:
  - name: GLASSPOD_SERVER
    value: ws://glasspod-server.glasspod.svc.cluster.local:8080/agent
  - name: POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
  - name: POD_NAMESPACE
    valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
```

## 설정

서버는 환경변수로 설정합니다. 값이 잘못되면 시작하지 않습니다.

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GLASSPOD_PORT` | `8080` | HTTP API와 SDK WebSocket(`/agent`) 포트 |
| `GLASSPOD_NAMESPACES` | `glasspod-demo` | watch할 namespace (쉼표로 여러 개) |
| `GLASSPOD_ACTION_NAMESPACES` | 없음 (조치 꺼짐) | 조치를 허용할 namespace. `GLASSPOD_NAMESPACES` 안에 있어야 함 |
| `GLASSPOD_KUBE_CONTEXT` | 없음 | 클러스터 밖에서 쓸 kubeconfig context. 없으면 클러스터 안 ServiceAccount, 둘 다 없으면 watch를 끔 |
| `GLASSPOD_METRICS_INTERVAL_MS` | `5000` | SDK의 metrics 전송 주기 |
| `GLASSPOD_MAX_EVENTS_PER_MINUTE` | `120` | SDK가 1분에 보낼 수 있는 event 수 |
| `GLASSPOD_HEARTBEAT_INTERVAL_MS` | `15000` | 서버 heartbeat 주기 |
| `GLASSPOD_STORE` | `memory` | 기록 저장소 (지금은 `memory`만) |

웹 개발 서버는 `/api` 요청을 `GLASSPOD_WEB_PROXY_TARGET`(기본 `http://localhost:8080`)으로 넘깁니다.

## 프로젝트 구조

```text
packages/
  protocol/    SDK–서버 프로토콜 v1 (JSON Schema, 생성한 타입, 검증)
  sdk-node/    Node.js SDK
apps/
  server/      Glasspod 서버 (Express + ws, @kubernetes/client-node)
  web/         웹 화면 (React + Vite)
examples/
  demo-app/    고장 스위치가 있는 데모 주문 앱과 부하 스크립트
deploy/
  demo/        데모 앱 매니페스트
  server/      서버 매니페스트와 RBAC
docs/          설계 문서, 작업별 지침서, 작업 기록
```

## 개발

```bash
npm run typecheck     # 타입 검사
npm test              # 테스트 (Vitest)
npm run format:check  # 코드 스타일 검사 (Prettier)
npm run generate      # 프로토콜 스키마에서 타입 다시 만들기
```

## 로드맵

- [x] Node.js SDK: metrics · event · HTTP 수집, 끊김 처리, snapshot 응답
- [x] 서버: SDK 연결, 쿠버네티스 watch, 기록 보관, 상태 판단, 같은 Deployment의 Pod끼리 지표 비교, 조회 API와 SSE
- [x] 웹 화면: Pod 목록 · 상세, 조치 기록, 격리된 Pod
- [x] 수동 조치: Pod 재시작, 트래픽에서 빼기(격리), 스케일 조정
- [x] 데모 앱과 로컬 클러스터 배포
- [ ] 서버가 웹 화면을 함께 제공
- [ ] 첫 마일스톤: 대표 시나리오를 로컬 클러스터에서 처음부터 끝까지 점검
- [ ] 자동 규칙(알림만 → 자동), 전체 재시작과 롤백, Spring Boot SDK, PostgreSQL 저장소

지표 장기 저장과 추세 분석(Prometheus의 영역), 로그 수집, 앱 상태를 원격으로 바꾸는 제어는 하지 않습니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/design.md](docs/design.md) | 설계: 구성, 동작, 프로토콜, 결정 사항 |
| [docs/guides/](docs/guides/) | 작업별 지침서: 범위와 완료 기준 |
| [docs/logs/](docs/logs/) | 일자별 작업 기록 |

## 기술 스택

Node.js 22 · TypeScript · Vitest · npm workspaces · JSON Schema(Ajv) · Express + `ws` · `@kubernetes/client-node` · React + Vite · React Router · Tailwind CSS · uPlot · Docker · Kubernetes

## 라이선스

[MIT](LICENSE)
