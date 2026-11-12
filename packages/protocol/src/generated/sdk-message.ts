// 이 파일은 `npm run generate`가 만든 것입니다. 직접 고치지 마세요.
// 고칠 때는 스키마(schema/sdk-message.schema.json)를 고친 뒤 다시 만듭니다.

/**
 * SDK가 서버로 보내는 메시지입니다(design.md 7.3). type 값으로 종류를 나눕니다.
 */
export type SdkMessage =
  HelloMessage | MetricsMessage | EventMessage | ResponseMessage;
/**
 * 프로세스가 시작될 때 0부터 셉니다. SDK가 실제로 보낼 때 붙이므로 보낸 순서대로 늘어나고, 재연결해도 이어집니다. SDK는 보낸 메시지를 다시 보내지 않으므로 서버는 빈틈으로 누락을 알 수 있습니다.
 */
export type Seq = number;
/**
 * 보낸 시각(epoch ms)입니다. event만은 일어난 시각입니다(묶어 보낸 event는 그 묶음에서 처음 일어난 것, 연결이 없는 동안 들고 있다가 보낸 event도 원래 시각). 서버는 받은 시각을 따로 기록합니다.
 */
export type Timestamp = number;
/**
 * 지표 이름입니다. 소문자, 숫자, _로 쓰고 단계는 .으로 나눕니다. 접두어로 출처를 구분합니다(runtime.*, http.*은 SDK 자동 수집, app.*은 개발자 등록).
 */
export type MetricName = string;
/**
 * gauge는 지금 값, counter는 누적값입니다. counter 값이 줄어들면 서버는 프로세스가 재시작됐다고 판단합니다.
 */
export type MetricKind = "gauge" | "counter";
export type EventLevel = "info" | "warn" | "error";

/**
 * 연결 직후 한 번 보냅니다. 나는 누구인가(Pod, 인스턴스)를 알립니다.
 */
export interface HelloMessage {
  type: "hello";
  seq: Seq;
  ts: Timestamp;
  /**
   * 프로토콜 버전입니다. 필드를 없애거나 의미를 바꿀 때만 올립니다.
   */
  protocol: number;
  sdk: {
    /**
     * SDK 언어입니다. 예: node
     */
    lang: string;
    version: string;
  };
  pod: PodRef;
  /**
   * SDK가 시작할 때 무작위로 만듭니다. Pod 이름은 같은데 instanceId가 바뀌었으면 컨테이너가 재시작된 것입니다.
   */
  instanceId: string;
  /**
   * 감시 대상 앱의 이름과 버전입니다.
   */
  app?: {
    name: string;
    version?: string;
  };
  /**
   * 이 SDK가 응답할 수 있는 요청(request의 action) 목록입니다. 예: snapshot
   */
  capabilities?: string[];
}
/**
 * Pod를 가리키는 키입니다. SDK는 Downward API로 받은 환경변수에서 읽습니다.
 */
export interface PodRef {
  namespace: string;
  name: string;
}
/**
 * 정해진 주기마다 보냅니다. 보낼 값이 없어도 빈 묶음을 보내며, 이것이 heartbeat입니다.
 */
export interface MetricsMessage {
  type: "metrics";
  seq: Seq;
  ts: Timestamp;
  values: MetricValue[];
}
export interface MetricValue {
  name: MetricName;
  kind: MetricKind;
  value: number;
}
/**
 * 일어나자마자 보냅니다. 같은 이벤트가 쏟아지면 SDK가 묶어서 count로 보냅니다.
 */
export interface EventMessage {
  type: "event";
  seq: Seq;
  ts: Timestamp;
  level: EventLevel;
  /**
   * exception(예외), state(상태 전환), 그 밖에 개발자가 정의한 이벤트 이름입니다.
   */
  name: string;
  message?: string;
  /**
   * 묶어서 보낸 횟수입니다. 한 건이면 1입니다.
   */
  count: number;
  /**
   * 이벤트별 추가 정보입니다. 예: errorType, route, stack
   */
  data?: {
    [k: string]: unknown;
  };
}
/**
 * 서버의 request에 대한 답입니다. 실패하면 ok를 false로 두고 error에 이유를 적습니다.
 */
export interface ResponseMessage {
  type: "response";
  seq: Seq;
  ts: Timestamp;
  /**
   * 답하는 request의 id입니다.
   */
  replyTo: string;
  ok: boolean;
  /**
   * 성공했을 때의 결과입니다. 모양은 request의 action에 따라 다릅니다(snapshot은 snapshot.schema.json).
   */
  data?: {
    [k: string]: unknown;
  };
  /**
   * 실패한 이유입니다.
   */
  error?: string;
}
