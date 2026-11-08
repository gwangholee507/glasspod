// 서버 로그입니다. 한 줄에 시각, 수준, 내용, key=value 필드를 씁니다.
// 예: 2026-11-08T08:00:00.000Z INFO  hello accepted pod=shop/orders-7d9f8-x2kq1 instance=4f1c2a9e
// 나중에 JSON 로그로 바꾸기 쉽게, 서버의 모든 로그는 이 함수로 남깁니다.
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
