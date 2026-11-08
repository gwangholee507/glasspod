// 스키마에서 TypeScript 파일을 만들어 src/generated/에 씁니다.
// 실행: npm run generate (루트에서)
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageDir, renderGeneratedFiles } from "./codegen.js";

const outputDir = join(packageDir, "src/generated");
const files = await renderGeneratedFiles();

// 없어진 스키마의 결과물이 남지 않게, 이번에 만들지 않는 파일은 지웁니다.
await mkdir(outputDir, { recursive: true });
for (const name of await readdir(outputDir)) {
  if (!files.has(`src/generated/${name}`)) {
    await rm(join(outputDir, name));
    console.log(`삭제: packages/protocol/src/generated/${name}`);
  }
}

for (const [path, content] of files) {
  await writeFile(join(packageDir, path), content);
  console.log(`생성: packages/protocol/${path}`);
}
