// 이 파일은 `npm run generate`가 만든 것입니다. 직접 고치지 마세요.
// 고칠 때는 스키마(schema/snapshot.schema.json)를 고친 뒤 다시 만듭니다.

/**
 * snapshot 요청에 대한 답(response의 data)입니다(design.md 7.3).
 */
export interface SnapshotData {
  /**
   * 등록된 상태 값입니다. 예: { "app.mode": "draining" }
   */
  state: {
    [k: string]: string;
  };
  /**
   * 진행 중인 요청과 경과 시간입니다.
   */
  inFlight: {
    route: string;
    elapsedMs: number;
  }[];
  /**
   * 프로세스 정보입니다.
   */
  process: {
    uptimeSec: number;
    heapUsedBytes: number;
  };
}
