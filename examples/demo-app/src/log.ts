// 데모 앱과 부하 스크립트의 로그입니다(docs/guides/T10.md 결정 21).
// 서버 로그(apps/server/src/log.ts)와 같은 모양으로 한 줄에 시각, 수준, 내용, key=value 필드를 씁니다.
// 예: 2026-11-13T08:00:00.000Z INFO  fault on name=slow delayMs=1500
type Level = "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | undefined>;

// 공백이나 따옴표가 있는 값은 따옴표로 감싸, 한 줄 안에서 필드를 나눌 수 있게 합니다.
function formatValue(value: string | number | boolean): string {
  const text = String(value);
  return text === "" || /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

function write(level: Level, message: string, fields: LogFields = {}): void {
  const parts = [
    new Date().toISOString(),
    level.toUpperCase().padEnd(5),
    message,
  ];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      parts.push(`${key}=${formatValue(value)}`);
    }
  }
  const line = parts.join(" ");
  if (level === "info") {
    console.log(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.error(line);
  }
}

export const log = {
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) =>
    write("error", message, fields),
};

// 예외 값에서 로그에 쓸 한 줄을 뽑습니다.
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
