import { configDefaults, defineConfig } from "vitest/config";

// 워크스페이스 패키지를 dist/가 아니라 src/에서 바로 불러오게 하는 조건입니다.
// 각 라이브러리 package.json의 exports에 같은 이름의 조건이 있습니다.
const sourceCondition = "@glasspod/source";

export default defineConfig({
  test: {
    // tsc -b가 dist/에 만든 테스트 파일은 실행하지 않습니다(Vitest 4부터 기본 제외 목록에 dist가 없음).
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
  ssr: {
    resolve: {
      conditions: [sourceCondition, "module", "node", "development|production"],
    },
  },
});
