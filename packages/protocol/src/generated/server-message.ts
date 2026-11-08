// 이 파일은 `npm run generate`가 만든 것입니다. 직접 고치지 마세요.
// 고칠 때는 스키마(schema/server-message.schema.json)를 고친 뒤 다시 만듭니다.

/**
 * 서버가 SDK로 보내는 메시지입니다(design.md 7.3). 공통 필드는 type 하나뿐입니다.
 */
export type ServerMessage = WelcomeMessage | RejectMessage | RequestMessage;

/**
 * hello를 받아들였을 때 보냅니다. 보내는 주기와 한도를 서버가 정합니다.
 */
export interface WelcomeMessage {
  type: "welcome";
  /**
   * metrics를 보내는 주기(ms)입니다.
   */
  metricsIntervalMs: number;
  /**
   * 1분에 보낼 수 있는 event 수입니다. 넘으면 SDK가 같은 이벤트를 묶습니다.
   */
  maxEventsPerMinute: number;
}
/**
 * hello를 거절할 때 보냅니다. 보낸 뒤 서버는 연결을 닫습니다.
 */
export interface RejectMessage {
  type: "reject";
  /**
   * 거절 이유입니다. 예: unknown-pod
   */
  reason: string;
}
/**
 * 정보 조회 요청입니다. 앱 상태를 바꾸는 요청은 만들지 않습니다.
 */
export interface RequestMessage {
  type: "request";
  /**
   * 요청 id입니다. SDK는 response의 replyTo에 그대로 넣습니다.
   */
  id: string;
  /**
   * 요청 종류입니다. v1은 snapshot 하나입니다. 모르는 action이면 SDK는 ok를 false로 답합니다.
   */
  action: string;
}
