// 이 파일은 `npm run generate`가 만든 것입니다. 직접 고치지 마세요.
// 고칠 때는 스키마(schema/snapshot.schema.json)를 고친 뒤 다시 만듭니다.

/**
 * snapshot 요청에 대한 답(response의 data)입니다(design.md 7.3). 서버는 validateSnapshotData로 검증합니다.
 */
export interface SnapshotData {
  /**
   * 등록된 상태 값입니다. 예: { "app.mode": "draining" }
   */
  state: {
    [k: string]: string;
  };
  /**
   * 진행 중인 요청과 경과 시간입니다. 시작한 순서(경과 시간이 긴 것부터)로 적습니다.
   */
  inFlight: {
    /**
     * 요청의 라우트 모양입니다(예: GET /orders/:id). 라우트가 정해지기 전이면 메서드만 씁니다(예: GET). 실제 경로는 id와 개인 정보가 들어갈 수 있어 쓰지 않습니다.
     */
    route: string;
    /**
     * 요청이 시작된 뒤 지난 시간(ms)입니다.
     */
    elapsedMs: number;
  }[];
  /**
   * 프로세스 정보입니다.
   */
  process: {
    /**
     * 프로세스가 시작된 뒤 지난 시간(초)입니다.
     */
    uptimeSec: number;
    /**
     * JavaScript 힙 사용량(바이트)입니다.
     */
    heapUsedBytes: number;
  };
}
