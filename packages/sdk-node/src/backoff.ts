// 재연결 간격입니다(design.md 7.4). 1초, 2초, 4초…로 늘려 30초까지 기다리고 0~1초 무작위 지연을 더합니다.
// 무작위 지연은 서버가 재시작될 때 모든 Pod가 한꺼번에 몰려오지 않게 하려는 것입니다.
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 30_000;
export const MAX_JITTER_MS = 1000;

// failures: welcome을 받은 뒤로 연속해서 실패한 횟수(1부터).
// random: 0 이상 1 미만의 수를 돌려주는 함수. 테스트에서 바꿔 넣습니다.
export function reconnectDelay(
  failures: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, failures - 1);
  // 2의 거듭제곱이 아주 커져도(Infinity) 상한에서 멈춥니다.
  const base = Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
  return base + Math.floor(random() * MAX_JITTER_MS);
}
