import { describe, expect, it } from "vitest";
import { InvalidValueError } from "./config.js";
import {
  blockParams,
  crashParams,
  errorsParams,
  leakParams,
  slowParams,
} from "./faults.js";

describe("고장 스위치 값", () => {
  it("값이 없으면 기본값을 쓴다", () => {
    expect(slowParams({})).toEqual({ delayMs: 1500 });
    expect(errorsParams({})).toEqual({ perSecond: 50, distinct: 1 });
    expect(leakParams({})).toEqual({ mbPerSec: 10 });
    expect(blockParams({})).toEqual({ seconds: 20 });
    expect(crashParams({})).toEqual({ kind: "exception" });
  });

  it("쿼리 문자열 값을 읽는다", () => {
    expect(slowParams({ delayMs: "300" })).toEqual({ delayMs: 300 });
    expect(errorsParams({ perSecond: "1000", distinct: "100" })).toEqual({
      perSecond: 1000,
      distinct: 100,
    });
    expect(crashParams({ kind: "rejection" })).toEqual({ kind: "rejection" });
  });

  it("범위를 벗어나거나 모르는 값은 거절한다", () => {
    expect(() => slowParams({ delayMs: "60001" })).toThrow(InvalidValueError);
    expect(() => errorsParams({ distinct: "0" })).toThrow(InvalidValueError);
    expect(() => leakParams({ mbPerSec: "-1" })).toThrow(InvalidValueError);
    expect(() => blockParams({ seconds: "301" })).toThrow(InvalidValueError);
    expect(() => crashParams({ kind: "oom" })).toThrow(
      'kind must be "exception" or "rejection" (got "oom")',
    );
  });
});
