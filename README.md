<p align="center">
  <img src="docs/assets/logo.svg" alt="Glasspod 로고" width="96" height="96">
</p>

<h1 align="center">Glasspod</h1>

<p align="center">
  <b>See inside your pods</b><br>
  Pod 속까지 투명하게
</p>

<p align="center">
  <i>설계 단계입니다. 아직 실행할 수 있는 코드는 없습니다.</i>
</p>

---

Glasspod는 **컨테이너 안의 앱이 실제로 어떻게 돌고 있는지 개발자가 보고, 그 판단으로 쿠버네티스 API를 호출해 조치하는 개발 도구**입니다.

쿠버네티스는 컨테이너를 알고, Glasspod는 앱을 압니다.

## 왜 필요한가

쿠버네티스는 헬스체크 결과만 보고 컨테이너를 재시작하거나 교체합니다. 실제로 운영해 보면 이것만으로는 부족할 때가 많습니다.

- 원인이 그대로면 컨테이너를 갈아 끼워도 같은 문제가 반복됩니다(CrashLoopBackOff).
- 교체하는 순간 원인을 찾을 단서(메모리 상태, 진행 중이던 요청, 직전 예외)도 함께 사라집니다.
- 살아는 있는데 느려지거나 큐가 쌓이는 상태는 헬스체크로 잡히지 않습니다.

Glasspod는 앱 안에 넣은 SDK로 앱 수준의 상태를 보고, 원인을 찾고, 필요하면 바로 조치할 수 있게 돕습니다.

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

- **SDK**: 앱 안에서 이벤트 루프 지연, 힙 사용량, HTTP 응답 시간, 예외, 개발자가 등록한 값(큐 길이 등)을 모아 서버로 보냅니다. 서버가 없거나 연결이 끊겨도 앱은 그대로 동작합니다.
- **서버**: 클러스터 안에서 SDK가 보낸 앱 상태와 쿠버네티스의 Pod 상태를 Pod 단위로 합쳐 상태를 판단합니다. 쿠버네티스 권한은 서버만 가집니다.
- **웹 화면**: Pod 목록과 상세를 보고, 확인창을 거쳐 조치 버튼을 누릅니다.

## 첫 버전에서 만드는 것

- Node.js SDK: metrics와 event 전송, snapshot 요청에 응답
- 서버: SDK 연결 수신, 쿠버네티스 watch, 상태 판단
- 웹 화면: Pod 목록과 상세
- 수동 조치: Pod 재시작, 트래픽에서 빼기(격리), 스케일 조정
- 데모 앱: 일부러 느려지거나 멈추거나 죽는 앱

그다음에는 자동 규칙(알림만 → 자동), 전체 재시작과 롤백, Spring Boot SDK를 계획하고 있습니다.

지표 장기 저장과 추세 분석(Prometheus의 영역), 로그 수집, 앱 상태를 원격으로 바꾸는 제어는 하지 않습니다.

## 미리 보기

아직 구현 전이라 패키지 이름과 API는 가칭입니다.

```js
import { glasspod } from '@glasspod/sdk';

glasspod.start();                                       // 환경변수에서 서버 주소와 Pod 정보를 읽음
app.use(glasspod.express());                            // HTTP 요청 자동 수집
glasspod.gauge('app.queue.length', () => queue.length); // 앱 고유 값 등록
glasspod.state('app.mode', 'ready');                    // 상태 등록, 바뀌면 서버로 알림
```

앱의 Deployment에는 서버 주소(`GLASSPOD_SERVER`)와 Pod 이름, namespace를 환경변수로 넣습니다. 자세한 설정은 [설계 문서 8장](docs/design.md#8-앱-배포-설정)에 있습니다.

## 현재 상태

설계를 마치고 구현을 시작했습니다. 지금 있는 것은 다음과 같습니다.

- 모노레포 골격(npm workspaces, TypeScript, Vitest)
- SDK–서버 프로토콜 v1(JSON Schema, 스키마에서 만든 타입, 메시지 검증)
- 서버 뼈대: `/health`, SDK용 WebSocket `/agent`. `hello`를 받아 `welcome`이나 `reject`로 답하고, 연결된 SDK에 주기마다 `heartbeat`를 보냄
- Node.js SDK 연결: 환경변수에서 서버 주소와 Pod 정보를 읽어 `hello`를 보내고, 끊기면 1초부터 30초까지 늘려 가며 다시 붙음
- Node.js SDK metrics: 이벤트 루프 지연·사용률, 메모리, CPU를 스스로 모으고, 앱이 등록한 gauge·counter와 함께 주기마다 보냄
- Node.js SDK event: 예외, 상태 전환, 앱이 정의한 이벤트를 바로 보냄. 같은 이벤트는 10초마다 묶어 보내고, 처리되지 않은 예외는 프로세스가 끝나기 직전에 보냄
- Node.js SDK HTTP: Express 미들웨어로 요청 수, 서버 오류, 끊긴 요청, 응답 시간(p50·p99·max), 처리 중인 요청 수를 모아 metrics에 넣음. 라우트에서 난 예외는 `GET /orders/:id` 같은 라우트 모양과 함께 보냄
- Node.js SDK 끊김 처리: 서버에 붙기 전이나 끊긴 동안의 event를 500개까지 들고 있다가 다시 붙으면 일어난 시각 그대로 보냄. 측정은 끊긴 동안에도 이어 가고, `heartbeat`가 끊기면 응답 없는 연결로 보고 다시 붙음
- snapshot: `GET /api/pods/:namespace/:name/snapshot`으로 Pod 하나의 지금 상태(상태 값, 처리 중인 요청과 경과 시간, 프로세스 정보)를 그 Pod의 SDK에 물어봄. 5초 안에 답이 없으면 응답 없음(504)으로 알려 앱이 막혔는지 보여 줌
- 데모 앱: SDK를 넣은 주문 앱 흉내(`examples/demo-app`)와 부하 스크립트. 관리 포트의 HTTP API로 느려짐, 이벤트 루프 막힘, 예외 폭주, 크래시, 메모리 증가를 일부러 일으킴. `npm run dev:server`, `npm run demo`, `npm run demo:load`로 노트북에서 띄워 볼 수 있음
- 데모 앱 배포: 데모 앱 이미지(`npm run demo:image`)와 로컬 클러스터용 매니페스트(`deploy/demo/`). `kubectl apply -f deploy/demo/`로 `glasspod-demo` namespace에 데모 앱 Pod 3개, Service, 부하 Pod를 띄움. SDK는 Pod 이름과 namespace를 Downward API로 받고, 고장 스위치는 `kubectl port-forward`로 씀. 서버를 클러스터에 띄우기 전까지는 노트북에서 띄운 서버에 붙여 확인함
- 쿠버네티스 watch: 서버가 정한 namespace의 Pod, Deployment, ReplicaSet, 클러스터 이벤트를 받아 Pod마다 지금 상태(실행 단계, 준비, 재시작 횟수, OOMKilled 같은 마지막 종료 이유)를 들고 있음. 노트북에서는 `GLASSPOD_KUBE_CONTEXT=docker-desktop npm run dev:server`처럼 볼 클러스터의 context를 정해 줌
- 웹 화면 뼈대: React + Vite, React Router, Tailwind CSS. 공통 틀(로고와 메뉴), 목록 자리, Pod 상세 자리(`/pods/:namespace/:name`)에서 snapshot을 불러 원본 JSON과 오류를 보여 줌. `npm run dev:web`으로 띄우면 개발 서버가 `/api` 요청을 Glasspod 서버로 넘김

Pod 목록과 상세 화면은 아직 자리만 있고, 서버는 SDK가 보낸 데이터를 아직 보관하지 않습니다. 쿠버네티스에서 받은 상태는 서버 로그로만 볼 수 있습니다.

첫 마일스톤은 [대표 시나리오](docs/design.md#6-대표-시나리오-pod-하나가-느려질-때)를 로컬 클러스터에서 처음부터 끝까지 돌려 보는 것입니다. 느려진 Pod 하나를 화면에서 찾고, 트래픽에서 뺀 채로 원인을 확인한 뒤 삭제합니다.

| 문서 | 내용 |
| --- | --- |
| [docs/design.md](docs/design.md) | 설계: 구성, 동작, 프로토콜, 결정 사항 |
| [docs/guides/](docs/guides/) | 작업별 지침서: 범위와 완료 기준 |
| [docs/logs/](docs/logs/) | 일자별 작업 기록 |

기술 스택: Node.js 22, TypeScript, Vitest, npm workspaces, JSON Schema(Ajv), Express + `ws`, `@kubernetes/client-node`, React + Vite, React Router, Tailwind CSS, Docker, Kubernetes(로컬은 Docker Desktop)

## 라이선스

[MIT](LICENSE)
