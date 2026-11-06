# Glasspod 설계 문서

작성 2026-11-05 · 상태: 초안

"확정"으로 표시한 항목만 결정된 사항입니다. 나머지는 설계 초안이라 구현하면서 바뀔 수 있고, 바뀌면 이 문서를 먼저 고칩니다.

## 1. 배경

쿠버네티스 같은 오케스트레이터는 일부러 컨테이너 내부를 모르게 설계되어 있습니다. 헬스체크(liveness/readiness probe) 결과만 보고, 실패하면 컨테이너를 재시작하거나 교체합니다. 실제로 운영해 보면 이 방식에는 한계가 있습니다.

- 원인이 그대로면 컨테이너를 갈아 끼워도 같은 문제가 반복됩니다(CrashLoopBackOff).
- 교체하는 순간 원인을 찾을 단서(메모리 상태, 진행 중이던 요청, 직전 예외)도 같이 사라집니다.
- 살아는 있는데 이상하게 동작하는 상태(느려짐, 큐 적체, 데드락 직전)는 헬스체크로 잡히지 않습니다.

자동 교체는 증상만 처리합니다. 개발자에게 필요한 것은 오케스트레이터가 돌아가는 동안 컨테이너 안에서 무슨 일이 일어나는지 보는 것입니다.

## 2. 목표와 범위

Glasspod는 **컨테이너 안의 앱이 실제로 어떻게 돌고 있는지 개발자가 보고, 그 판단으로 쿠버네티스 API를 호출해 조치하는 개발 도구**입니다. 쿠버네티스는 컨테이너를 알고, Glasspod는 앱을 압니다.

하는 일:

- 앱 안에 넣은 SDK로 앱 수준의 내부 상태(지표, 사건, 상태 값)를 실시간으로 수집
- 앱 상태와 쿠버네티스 상태(Pod, Deployment)를 Pod 단위로 합쳐 웹 화면에 표시
- 개발자가 버튼을 눌러 쿠버네티스 조치 실행 (재시작, 격리, 스케일 조정 등)
- 개발자가 정해 둔 규칙에 따라 조치를 자동 실행 (선택)

하지 않는 일:

- 지표 장기 저장과 추세 분석 (Prometheus의 영역)
- 로그 수집·검색
- 앱 상태를 원격으로 바꾸는 제어. 앱에 대한 조치는 쿠버네티스 API로만 합니다.

### 1차 범위 (MVP)

핵심 기능:

1. Node.js SDK: metrics와 event 전송, snapshot 요청에 응답
2. 서버: SDK의 WebSocket 연결 수신, 쿠버네티스 watch, 상태 판단(7.5)
3. 웹 화면: Pod 목록과 상세
4. 수동 조치 3개: Pod 재시작, 트래픽에서 빼기(격리), 스케일 조정
5. 검증용 데모 앱: 일부러 느려지거나 멈추거나 죽는 앱

확장 기능: 자동 규칙, 전체 재시작, 롤백, ServiceAccount 토큰 검증, Spring Boot SDK. 확장 기능은 핵심 기능보다 먼저 만들지 않습니다.

## 3. 결정 사항

| 항목 | 결정 | 상태 |
| --- | --- | --- |
| 이름 | Glasspod. 브랜드는 12장 | 확정 (2026-11-05) |
| 관찰 범위 | 앱 수준까지. 앱에 SDK를 넣어 수집 | 확정 (2026-11-05) |
| 동작 방식 | 도구가 앱을 지켜보고, 그 판단으로 쿠버네티스 API를 호출 | 확정 (2026-11-05) |
| 조치 실행 | 기본은 개발자가 화면에서 버튼을 누름. 규칙을 정해 두면 자동 실행 | 확정 (2026-11-05) |
| 데이터 전달 | push. SDK가 연 연결 하나로 양방향 통신 | 확정 (2026-11-05) |
| SDK 언어 | Node.js로 먼저 만듦 | 확정 (2026-11-05) |
| 테스트 클러스터 | 지금 있는 로컬 환경 | 확정 (2026-11-05). 구성 방식은 10장 |
| 연결 방식 | WebSocket, 메시지는 JSON | 초안 |
| 메시지 형식 | 7장의 프로토콜 v1 | 초안 |
| 두 번째 SDK | Spring Boot | 후보 |
| 서버 | Node.js + TypeScript, Express + `ws` | 확정 (2026-11-05) |
| 웹 화면 | React + Vite | 확정 (2026-11-05) |
| 저장소 구성 | npm workspaces 모노레포, ESM만 사용. 패키지 이름은 `@glasspod/protocol`, `@glasspod/sdk`, `@glasspod/server`, `@glasspod/web`, `@glasspod/demo-app`. 자세한 내용은 `docs/guides/T01.md` | 확정 (2026-11-05) |
| 1차 범위 | 2장의 핵심 기능. 자동 규칙은 확장 기능 | 확정 (2026-11-05) |
| 서버 데이터 보관 | 10장 | 미정 |

## 4. 전체 구성

```text
[Pod 안: 내 앱 + SDK]
   |  (1) 앱 내부 상태를 보냄 (push, WebSocket)
   v
[Glasspod 서버] <-- (2) Kubernetes API를 watch해 Pod, Deployment 상태를 받음
   |            --> (4) 조치가 정해지면 Kubernetes API 호출
   v
[웹 화면]  (3) 개발자가 보고, 버튼을 누르면 서버로 요청
```

| 구성 요소 | 위치 | 역할 |
| --- | --- | --- |
| SDK | 감시 대상 앱 안 (라이브러리) | 앱 내부 상태 수집, 서버로 전송, 서버 요청에 응답 |
| Glasspod 서버 | 클러스터 안 Deployment | SDK 연결 수신, 쿠버네티스 watch, 상태 결합·판단, 규칙 평가, 조치 실행과 기록 |
| 웹 화면 | 개발자 브라우저 | 목록·상세 표시, 조치 버튼, 규칙 관리 |
| Kubernetes API | 클러스터 (기존) | 클러스터 상태 제공, 조치 수행 |

## 5. 구성 요소별 동작

### 5.1 SDK

수집하는 것:

- **자동 수집** (`runtime.*`, `http.*`): 이벤트 루프 지연, 힙 사용량, HTTP 요청 수·응답 시간·에러
- **개발자 등록** (`app.*`): 큐 길이, 커넥션 수 같은 앱 고유 값과 앱 내부 상태(예: `ready`, `draining`)
- **사건**: 예외, 상태 전환, 개발자가 정의한 이벤트
- **자기 위치**: Pod 이름과 namespace (Downward API로 받은 환경변수)

SDK가 앱을 망치면 안 됩니다. 다음을 지킵니다.

- 서버가 없거나 연결이 끊겨도 앱은 정상 동작합니다. SDK 내부 오류를 앱으로 던지지 않습니다.
- 수집과 전송은 가볍게 합니다. Node.js에서는 SDK도 앱과 같은 이벤트 루프를 쓰므로 힙 스냅샷 같은 무거운 작업은 하지 않습니다.
- 메모리 사용에 상한을 둡니다. 보내지 못한 데이터는 정해진 양만 들고 있습니다.
- 앱의 종료 동작을 바꾸지 않습니다. 처리되지 않은 예외를 잡으면 서버로 보낸 뒤(최대 1초 대기) 원래대로 종료하고, 종료 시그널(SIGTERM) 처리는 가로채지 않습니다.

### 5.2 서버

- 두 곳에서 데이터를 받습니다.
  - SDK: 앱 내부 상태
  - Kubernetes API watch: Pod 상태(Running, 재시작 횟수, OOMKilled 같은 종료 이유), Deployment의 replica 수, 클러스터 이벤트
- Pod(namespace + 이름)를 키로 둘을 합쳐 Pod 하나의 그림을 만듭니다. 예: "Pod A: Running, 재시작 3회, 큐 길이 1,200, 마지막 예외는 DB timeout"
- 클러스터 안에 Deployment로 띄우고, 자기 ServiceAccount로 API를 호출합니다. 권한은 RBAC로 필요한 만큼만 줍니다(5.4).
- SDK 신호와 Pod 상태를 함께 보고 상태를 판단합니다(7.5).

### 5.3 웹 화면

- **목록**: Deployment와 그 아래 Pod별 상태. 이상한 Pod는 강조합니다.
- **상세**: Pod 하나의 앱 내부 값이 시간에 따라 변한 모습, 최근 이벤트와 예외, snapshot 조회
- **조치 버튼**: 확인창을 거쳐 서버로 요청합니다. 브라우저는 쿠버네티스를 직접 호출하지 않고, 권한은 서버에만 있습니다.
- **규칙 관리**와 **조치 기록** 조회

### 5.4 쿠버네티스 조치

| 조치 | 쿠버네티스에서 일어나는 일 | 필요한 권한 | 쓰는 상황 |
| --- | --- | --- | --- |
| Pod 재시작 | Pod를 삭제하면 컨트롤러가 새로 만듦 | pods: delete | 한 Pod만 이상할 때 |
| 트래픽에서 빼기 (격리) | Pod 라벨을 바꿔 Service와 ReplicaSet에서 떼어 냄. ReplicaSet이 대신할 새 Pod를 만들고, 기존 Pod는 살아 있는 채로 남음 | pods: patch | 원인 조사 |
| 스케일 조정 | Deployment의 scale 값 수정 | deployments/scale: get, patch | 부하가 늘었을 때 |
| 전체 재시작 | Deployment 템플릿에 재시작 시각 주석 추가 (`kubectl rollout restart`와 같은 방식) | deployments: patch | 설정 변경 반영 |
| 롤백 | 이전 ReplicaSet의 Pod 템플릿으로 Deployment를 되돌림. API에 롤백 명령이 따로 없어 직접 구현 | replicasets: list, deployments: patch | 새 버전 배포 뒤 문제 |

관찰에 필요한 권한은 pods, deployments, replicasets, events의 get/list/watch와 services의 get/list입니다.

주의할 점:

- **격리**: Service selector와 ReplicaSet selector가 함께 쓰는 라벨을 바꿔야 합니다. 어느 라벨을 바꿀지는 실행할 때 두 selector를 읽어 정합니다. 격리된 Pod는 더 이상 Deployment가 관리하지 않으므로 조사가 끝나면 직접 삭제해야 합니다. 화면에 격리된 Pod 목록을 따로 보여 줍니다.
- **스케일**: HPA가 관리하는 Deployment는 수동으로 바꾼 값을 HPA가 다시 덮어씁니다. HPA가 있으면 버튼에 경고를 표시합니다.
- **기록**: 수동이든 자동이든 모든 조치를 기록합니다. 실행 주체(개발자 또는 규칙 이름), 시각, 대상, 조치, 결과를 남깁니다.

### 5.5 자동 규칙 (확장 기능)

- **구조**: 조건 + 조치 + 안전장치
- **예**: `app.queue.length`가 1,000을 넘은 채 2분 계속되면 replica를 1 늘린다 (최대 5개, 10분에 한 번까지)
- **안전장치**: 조건 지속 시간(순간적으로 튄 값 무시), 쿨다운, 상한(최대 replica, 시간당 실행 횟수), 대상 범위(namespace, Deployment)
- **모드**: 꺼짐(기본) → 알림만 → 자동. "알림만"에서는 조건이 맞으면 실행하지 않고 "이 규칙이 지금 실행됐을 것"을 화면에 표시합니다. 개발자가 판단이 맞는지 확인한 뒤 자동으로 바꿉니다.
- 규칙을 적는 문법은 미정입니다(10장).

## 6. 대표 시나리오: Pod 하나가 느려질 때

1. Pod A의 큐 길이가 계속 늘어나고, SDK가 이 값을 서버로 보냅니다. 헬스체크는 통과하므로 쿠버네티스는 아무 일도 하지 않습니다.
2. 서버는 Pod A의 값이 다른 Pod보다 높은 것을 보고 화면에 강조합니다.
3. 개발자가 Pod A 상세를 열어 마지막 예외가 DB timeout인 것을 확인합니다.
4. "트래픽에서 빼기"를 누르면 서버가 Pod A의 라벨을 바꿉니다. 새 Pod가 트래픽을 받고, Pod A는 그대로 남습니다.
5. 개발자는 Pod A의 상태를 계속 보며 원인을 찾고, 끝나면 "Pod 삭제"를 누릅니다.
6. 같은 일이 반복되면 규칙으로 등록합니다. 처음에는 알림만 받다가 나중에 자동으로 바꿉니다.

## 7. SDK–서버 프로토콜 v1 (초안)

### 7.1 흐름

```text
SDK (앱 안)                         서버
  |  connect  ------------------>  |
  |  hello    ------------------>  |  나는 누구인가 (Pod, 인스턴스)
  |  <------------------  welcome  |  서버가 정한 주기와 한도
  |  metrics  ------------------>  |  정해진 주기마다 (heartbeat 겸용)
  |  event    ------------------>  |  일어나자마자
  |  <------------------  request  |  개발자가 상세 화면을 열 때
  |  response ------------------>  |
```

### 7.2 공통 규칙

- 메시지는 JSON이고, WebSocket 텍스트 프레임 하나에 메시지 하나를 담습니다.
- SDK가 보내는 모든 메시지에는 `type`, `seq`, `ts`를 붙입니다.
  - `seq`: 프로세스가 시작될 때 0부터 셉니다. 재연결해도 이어서 늘어나므로 서버가 중복과 누락을 판단할 수 있습니다.
  - `ts`: 보낸 시각(epoch ms)입니다. 서버는 받은 시각을 따로 기록합니다.
- 서버가 보내는 메시지에는 `type`만 필수입니다.
- 프로토콜 버전은 `hello`에서 한 번만 알립니다.
- 메시지 형식은 JSON Schema로 정의합니다. Node SDK와 서버는 여기서 타입을 만들어 쓰고, 다른 언어의 SDK도 같은 스키마를 따릅니다.
- 받는 쪽은 모르는 필드를 무시합니다. 필드를 추가할 때는 버전을 올리지 않고, 필드를 없애거나 의미를 바꿀 때 `protocol` 번호를 올립니다.

### 7.3 메시지

#### hello (SDK → 서버, 연결 직후 한 번)

```json
{
  "type": "hello", "seq": 0, "ts": 1793873730120,
  "protocol": 1,
  "sdk": { "lang": "node", "version": "0.1.0" },
  "pod": { "namespace": "shop", "name": "orders-7d9f8-x2kq1" },
  "instanceId": "4f1c2a9e",
  "app": { "name": "orders", "version": "1.4.2" },
  "capabilities": ["snapshot"]
}
```

- `instanceId`: SDK가 시작할 때 무작위로 만듭니다. Pod 이름은 같은데 `instanceId`가 바뀌었으면 컨테이너가 재시작된 것입니다.
- `capabilities`: 이 SDK가 응답할 수 있는 요청 목록입니다.

#### welcome / reject (서버 → SDK)

```json
{ "type": "welcome", "metricsIntervalMs": 5000, "maxEventsPerMinute": 120 }
```

```json
{ "type": "reject", "reason": "unknown-pod" }
```

- 보내는 주기와 한도를 서버가 정합니다. push 방식이어도 서버가 부하를 조절할 수 있습니다.
- `reject`를 보낸 뒤 서버는 연결을 닫습니다.

#### metrics (SDK → 서버, 정해진 주기마다)

```json
{
  "type": "metrics", "seq": 42, "ts": 1793873735120,
  "values": [
    { "name": "runtime.event_loop.lag_p99_ms", "kind": "gauge", "value": 12.4 },
    { "name": "runtime.heap.used_bytes", "kind": "gauge", "value": 48234496 },
    { "name": "http.requests.total", "kind": "counter", "value": 1532 },
    { "name": "app.queue.length", "kind": "gauge", "value": 1200 }
  ]
}
```

- 이름 접두어로 출처를 구분합니다. `runtime.*`과 `http.*`은 SDK 자동 수집, `app.*`은 개발자 등록입니다. 이름은 소문자와 `_`, 단계는 `.`으로 나누고, 단위가 있으면 끝에 붙입니다(`_ms`, `_bytes`).
- `kind`는 `gauge`(지금 값)와 `counter`(누적값) 두 가지입니다.
- counter는 누적값으로 보냅니다. 메시지 하나를 잃어도 다음 값으로 메워집니다. 값이 줄어들면 서버는 프로세스가 재시작됐다고 판단합니다.
- 보낼 값이 없어도 주기마다 빈 묶음을 보냅니다. 이것이 heartbeat입니다.
- 응답 시간은 v1에서 SDK가 주기마다 p50과 p99를 계산해 gauge로 보냅니다.

#### event (SDK → 서버, 일어나자마자)

```json
{
  "type": "event", "seq": 43, "ts": 1793873733870,
  "level": "error", "name": "exception",
  "message": "DB timeout after 5000ms",
  "count": 1,
  "data": { "errorType": "TimeoutError", "route": "GET /orders", "stack": "..." }
}
```

- `name`의 종류
  - `exception`: 처리되지 않은 예외, 또는 SDK로 보고한 예외
  - `state`: 개발자가 등록한 상태의 전환 (예: `ready` → `draining`)
  - 그 밖에 개발자가 정의한 이벤트
- 같은 예외가 쏟아지면 SDK가 묶어서 `count`로 보냅니다. 예를 들어 10초 동안 같은 예외가 120번 나면 한 건으로 보내고 `count`를 120으로 둡니다. 한도는 `welcome`의 `maxEventsPerMinute`를 따릅니다.
- 처리되지 않은 예외는 서버로 먼저 보내고 프로세스가 종료되므로, 컨테이너가 교체돼도 직전 예외가 서버에 남습니다. OOMKilled는 보낼 틈이 없지만 그 직전 metrics에 힙이 늘어나는 모습이 남습니다.

#### request / response (서버 → SDK → 서버)

```json
{ "type": "request", "id": "r-7", "action": "snapshot" }
```

```json
{
  "type": "response", "seq": 51, "ts": 1793873740020, "replyTo": "r-7", "ok": true,
  "data": {
    "state": { "app.mode": "draining" },
    "inFlight": [{ "route": "GET /orders", "elapsedMs": 8200 }],
    "process": { "uptimeSec": 3600, "heapUsedBytes": 48234496 }
  }
}
```

- v1의 요청은 `snapshot` 하나입니다. 등록된 상태 값, 진행 중인 요청과 경과 시간, 프로세스 정보를 돌려줍니다.
- 실패하면 `"ok": false`와 `error` 필드로 이유를 돌려줍니다.
- 서버는 5초 안에 답이 없으면 "응답 없음"으로 표시합니다. 이것도 이벤트 루프가 막혔다는 단서입니다.
- 서버가 SDK에 보내는 요청은 정보 조회만 허용합니다. 앱 상태를 바꾸는 요청은 만들지 않습니다.

### 7.4 연결이 끊겼을 때 (SDK)

- **재연결 간격**: 1초, 2초, 4초…로 늘려 최대 30초까지 기다리고, 무작위 지연을 더합니다. 서버가 재시작될 때 모든 Pod가 한꺼번에 몰려오지 않게 하려는 것입니다.
- **끊긴 동안의 데이터**
  - event는 최대 500개까지 들고 있다가 넘치면 오래된 것부터 버립니다.
  - metrics는 쌓지 않고 최신 값 하나만 유지합니다. counter가 누적값이라 최신 값 하나면 충분합니다.
- **재연결 후**: `hello`를 다시 보내고(`instanceId`는 그대로), 들고 있던 event를 원래 `ts` 그대로 보냅니다. `seq`가 이어지므로 서버가 중복을 걸러냅니다.

### 7.5 서버의 상태 판단

| SDK 신호 | 쿠버네티스 Pod 상태 | 서버의 판단 |
| --- | --- | --- |
| 정상 | Running | 정상 |
| 연결은 열려 있는데 metrics가 3주기째 없음 | Running | 앱 멈춤 의심 (이벤트 루프 막힘 등) |
| 연결 끊김 | Running | SDK 연결 문제 또는 앱 멈춤 |
| 연결 끊김 | 종료 중이거나 없음 | 정상 종료 |
| 새 `instanceId`로 `hello` | Running, 재시작 횟수 증가 | 컨테이너 재시작. 직전 이벤트를 원인 후보로 표시 |

## 8. 앱 배포 설정

감시 대상 앱의 Deployment에 환경변수 세 개를 넣습니다. Pod 정보는 Downward API로 받습니다.

```yaml
env:
  - name: GLASSPOD_SERVER
    value: ws://glasspod-server.glasspod.svc.cluster.local:8080/agent
  - name: POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
  - name: POD_NAMESPACE
    valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
```

앱 코드에서 SDK를 쓰는 모습입니다. 패키지 이름과 API는 가칭입니다.

```js
import { glasspod } from '@glasspod/sdk';

glasspod.start();                                       // 환경변수에서 서버 주소와 Pod 정보를 읽음
app.use(glasspod.express());                            // HTTP 요청 자동 수집
glasspod.gauge('app.queue.length', () => queue.length); // 앱 고유 값 등록
glasspod.state('app.mode', 'ready');                    // 상태 등록, 바뀌면 state 이벤트 전송
```

## 9. 보안

- **가짜 데이터 막기**: 자동 규칙은 SDK가 보낸 값을 근거로 쿠버네티스를 움직이므로, Pod인 척 접속해 가짜 값을 넣을 수 있으면 안 됩니다.
  - v1: `hello`의 Pod 이름으로 쿠버네티스에서 Pod IP를 조회해 실제 접속 IP와 대조합니다.
  - 이후: SDK가 ServiceAccount 토큰을 보내고 서버가 TokenReview API로 검증합니다.
- **SDK로 가는 요청은 읽기 전용**: 서버를 통해 앱 상태를 바꾸는 통로를 만들지 않습니다.
- **서버 권한 최소화**: RBAC로 5.4의 권한만 줍니다. 개발 중에는 조치 대상 namespace를 제한합니다.
- **브라우저에는 쿠버네티스 권한이 없음**: 모든 조치는 서버를 거칩니다.

## 10. 미정 사항

| 항목 | 현재 상황과 제안 |
| --- | --- |
| 서버 데이터 보관 | 제안: 서버 메모리에 Pod별 최근 30분. 오래 보관해야 할 필요가 생기면 DB 추가 |
| 웹 화면 접속 방식 | 제안: 서버가 웹 화면 파일도 함께 제공하고, 로컬에서는 `kubectl port-forward`로 접속 |
| 로컬 클러스터 구성 | 2026-11-05 확인: Docker Desktop 4.59.1 설치됨(데몬 꺼져 있음), kubectl 1.34.1, kubeconfig 없음(내장 Kubernetes가 켜진 적 없음). Kubernetes를 켜는 방식과 직접 빌드한 이미지를 클러스터에 넣는 방법을 정해야 함 |
| 접속 IP 대조 | 로컬 클러스터에서 서버가 보는 접속 IP가 Pod IP와 같은지 구현할 때 확인 |
| 규칙 문법 | 미정 |

## 11. 이후 확장

- Spring Boot SDK: 스레드 덤프(`threadDump` 요청), 데드락 감지, 스레드 풀·커넥션 풀 사용량
- ServiceAccount 토큰으로 SDK 신원 확인
- 히스토그램 지표
- 장기 보관용 DB
- 지표 메시지 줄이기: 이름과 `kind`를 `hello`에서 한 번만 알리기

## 12. 브랜드

2026-11-05 확정. 세 시안(Glasspod, Porthole, Podscope) 가운데 골랐습니다.

| 항목 | 결정 |
| --- | --- |
| 이름 | Glasspod (글래스팟) |
| 바꾼 이유 | 작업명 ConMonO는 같은 분야의 컨테이너 런타임 모니터 conmon(`containers/conmon`, Podman과 CRI-O가 사용)과 글자 하나만 달라 검색에 섞이고 파생 프로젝트로 오해받기 쉬움 |
| 뜻 | 오케스트레이터에게 컨테이너는 블랙박스지만, Glasspod는 Pod를 유리 상자처럼 들여다보게 함 |
| 태그라인 | See inside your pods · Pod 속까지 투명하게 |
| 표기 | 문서와 화면 제목은 `Glasspod`. 저장소, 패키지, namespace는 소문자 `glasspod`, 환경변수는 `GLASSPOD_*` |
| 분위기 | 밝고 맑음, 투명함, 가벼움. 경고만 코랄색으로 튀게 해 이상한 Pod가 바로 눈에 띄게 함 |

### 로고

육각형은 Pod, 그 안의 맥박선은 들여다보이는 앱 상태를 뜻합니다.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <polygon points="32,6 54.5,19 54.5,45 32,58 9.5,45 9.5,19"
           fill="#D9F3F7" stroke="#0E9DB5" stroke-width="3" stroke-linejoin="round"/>
  <polyline points="16,34 24,34 28,24 34,44 38,30 42,34 48,34"
            fill="none" stroke="#0B5F6E" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

글자 로고는 소문자 `glasspod`를 Manrope(굵기 500), Deep teal로 씁니다.

### 색

| 이름 | 값 | 쓰임 |
| --- | --- | --- |
| Deep teal | `#0B5F6E` | 글자 로고, 제목, 주요 버튼 |
| Glass cyan | `#0E9DB5` | 로고 테두리, 강조, 링크 |
| Mist | `#D9F3F7` | 로고 면, 선택된 항목 배경 |
| Paper | `#F7FBFC` | 페이지 배경 |
| Coral | `#FF7A59` | 경고, 이상한 Pod 강조 |

다크 모드 색은 아직 정하지 않았습니다. 웹 화면 작업 때 정합니다.

### 글꼴

| 쓰임 | 글꼴 |
| --- | --- |
| 글자 로고 | Manrope |
| 화면 본문 (한글, 영문) | Pretendard |
| 지표 숫자, 코드 | JetBrains Mono |

### 이름 사용 가능 여부 (2026-11-05 확인)

- npm: `glasspod`, `@glasspod/sdk` 모두 등록되어 있지 않음
- GitHub: `glasspod` 계정·조직 없음. 같은 이름의 저장소는 설명 없는 개인 저장소 하나(별 1개)
- 웹 검색으로 같은 이름의 쿠버네티스 도구를 찾지 못함. 상표 검토는 하지 않음
