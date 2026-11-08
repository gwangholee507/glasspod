// 스키마(schema/*.schema.json)에서 TypeScript 파일(src/generated/)을 만드는 코드입니다.
// generate.ts가 이 결과를 파일로 쓰고, codegen.test.ts가 커밋된 파일과 같은지 확인합니다.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import * as prettier from "prettier";

// packages/protocol 폴더의 절대 경로입니다.
export const packageDir = fileURLToPath(new URL("../", import.meta.url));

// 스키마 파일 하나에서 타입 파일 하나를 만듭니다.
// schemaExport는 검증에 쓰는 스키마 객체를 schemas.ts에서 내보낼 이름입니다.
const targets = [
  {
    schema: "sdk-message.schema.json",
    typeName: "SdkMessage",
    output: "sdk-message.ts",
    schemaExport: "sdkMessageSchema",
  },
  {
    schema: "server-message.schema.json",
    typeName: "ServerMessage",
    output: "server-message.ts",
    schemaExport: "serverMessageSchema",
  },
  {
    schema: "snapshot.schema.json",
    typeName: "SnapshotData",
    output: "snapshot.ts",
    schemaExport: "snapshotDataSchema",
  },
] as const;

function banner(sources: string): string {
  return [
    "// 이 파일은 `npm run generate`가 만든 것입니다. 직접 고치지 마세요.",
    `// 고칠 때는 스키마(${sources})를 고친 뒤 다시 만듭니다.`,
    "",
    "",
  ].join("\n");
}

// json-schema-to-typescript가 입력 객체를 바꿀 수 있으므로 쓸 때마다 새로 읽습니다.
async function readSchema(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(packageDir, "schema", file), "utf8"));
}

// 저장소의 Prettier 설정으로 정리해서, 생성한 파일도 format:check를 통과하게 합니다.
async function format(code: string, path: string): Promise<string> {
  const filepath = join(packageDir, path);
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(code, { ...config, filepath });
}

// 만들 파일의 경로(packages/protocol 기준)와 내용을 돌려줍니다.
export async function renderGeneratedFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const schemaObjects: string[] = [];

  for (const target of targets) {
    const types = await compile(
      await readSchema(target.schema),
      target.typeName,
      {
        // 스키마는 모르는 필드를 허용하지만(받는 쪽이 무시), 타입에는 아는 필드만 둡니다.
        additionalProperties: false,
        bannerComment: "",
        format: false,
        unknownAny: true,
      },
    );
    const path = `src/generated/${target.output}`;
    files.set(
      path,
      await format(banner(`schema/${target.schema}`) + types, path),
    );

    const schema = JSON.stringify(await readSchema(target.schema), null, 2);
    schemaObjects.push(
      `// schema/${target.schema}\nexport const ${target.schemaExport} = ${schema};\n`,
    );
  }

  const schemasPath = "src/generated/schemas.ts";
  const sources = targets.map((target) => `schema/${target.schema}`).join(", ");
  files.set(
    schemasPath,
    await format(banner(sources) + schemaObjects.join("\n"), schemasPath),
  );

  return files;
}
