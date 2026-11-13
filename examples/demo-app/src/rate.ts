// 초당 횟수를 100ms마다 나눠 부르는 타이머입니다. 예외 폭주, 메모리 증가, 부하 스크립트가 씁니다.
// 초당 3번처럼 100ms에 나눠 떨어지지 않는 값은 남은 몫을 다음 차례로 넘깁니다.
// 소수 더하기의 오차로 횟수가 어긋나지 않게 남은 몫은 정수(횟수 × ms)로 셉니다.

export const TICK_MS = 100;

export class RateTicker {
  private timer: ReturnType<typeof setInterval> | undefined;
  // 아직 부르지 않은 몫입니다. 단위는 횟수 × ms이고 1000이 한 번입니다.
  private carry = 0;

  constructor(
    private perSecond: number,
    private readonly onTick: (count: number) => void,
  ) {}

  start(): void {
    this.stop();
    this.carry = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // 다음 차례부터 새 값을 씁니다. 남은 몫은 그대로 둡니다.
  setRate(perSecond: number): void {
    this.perSecond = perSecond;
  }

  private tick(): void {
    this.carry += this.perSecond * TICK_MS;
    const count = Math.floor(this.carry / 1000);
    this.carry -= count * 1000;
    if (count > 0) {
      this.onTick(count);
    }
  }
}
