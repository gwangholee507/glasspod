import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageDir, renderGeneratedFiles } from "./codegen.js";

// 스키마를 고치고 다시 생성하지 않았으면 실패합니다. 고치려면 루트에서 npm run generate를 실행합니다.
describe("generated files", () => {
  it("match the schemas", async () => {
    const expected = await renderGeneratedFiles();

    const actualPaths = (await readdir(join(packageDir, "src/generated")))
      .map((name) => `src/generated/${name}`)
      .sort();
    expect(
      actualPaths,
      "src/generated/의 파일 목록이 스키마와 다릅니다",
    ).toEqual([...expected.keys()].sort());

    for (const [path, content] of expected) {
      const actual = await readFile(join(packageDir, path), "utf8");
      expect(
        actual,
        `${path}가 스키마와 다릅니다. npm run generate를 실행하세요`,
      ).toBe(content);
    }
  });
});
