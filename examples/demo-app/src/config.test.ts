import { describe, expect, it } from "vitest";
import {
  InvalidValueError,
  loadAppConfig,
  loadLoadConfig,
  readInteger,
} from "./config.js";

describe("readInteger", () => {
  it("값이 없거나 비어 있으면 기본값을 쓴다", () => {
    expect(readInteger(undefined, "n", 7, 1, 10)).toBe(7);
    expect(readInteger(" ", "n", 7, 1, 10)).toBe(7);
  });

  it("정수가 아니거나 범위를 벗어나거나 문자열이 아니면 거절한다", () => {
    for (const raw of ["abc", "1.5", "0", "11", ["1", "2"]]) {
      expect(() => readInteger(raw, "n", 7, 1, 10)).toThrow(InvalidValueError);
    }
    expect(() => readInteger("abc", "delayMs", 1, 1, 60000)).toThrow(
      'delayMs must be an integer from 1 to 60000 (got "abc")',
    );
  });
});

describe("loadAppConfig", () => {
  it("기본값은 3000, 127.0.0.1:3001이다", () => {
    expect(loadAppConfig({})).toEqual({
      port: 3000,
      adminHost: "127.0.0.1",
      adminPort: 3001,
    });
  });

  it("환경변수를 읽고, 두 포트가 같으면 거절한다", () => {
    expect(
      loadAppConfig({
        PORT: "8000",
        ADMIN_PORT: "9000",
        ADMIN_HOST: "0.0.0.0",
      }),
    ).toEqual({ port: 8000, adminHost: "0.0.0.0", adminPort: 9000 });
    expect(() => loadAppConfig({ PORT: "abc" })).toThrow(InvalidValueError);
    expect(() => loadAppConfig({ PORT: "3001" })).toThrow(
      "PORT and ADMIN_PORT must be different",
    );
  });
});

describe("loadLoadConfig", () => {
  it("기본값은 http://localhost:3000, 초당 10이다", () => {
    const config = loadLoadConfig({});
    expect(config.target.origin).toBe("http://localhost:3000");
    expect(config.rps).toBe(10);
  });

  it("http 주소가 아니거나 rps가 범위를 벗어나면 거절한다", () => {
    expect(() => loadLoadConfig({ LOAD_TARGET: "localhost:3000" })).toThrow(
      InvalidValueError,
    );
    expect(() => loadLoadConfig({ LOAD_TARGET: "https://demo" })).toThrow(
      "LOAD_TARGET must be an http:// URL",
    );
    expect(() => loadLoadConfig({ LOAD_RPS: "1001" })).toThrow(
      InvalidValueError,
    );
  });
});
