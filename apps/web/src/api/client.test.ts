import { describe, expect, it } from "vitest";
import { UNEXPECTED_BODY, parseApiResponse } from "./client.js";

describe("parseApiResponse", () => {
  it("2xx JSON 본문은 data로 돌려줌", () => {
    expect(parseApiResponse(200, '{"instanceId":"a"}')).toEqual({
      ok: true,
      status: 200,
      data: { instanceId: "a" },
    });
  });

  it("서버의 오류 본문 { error, detail }은 그대로 씀", () => {
    expect(
      parseApiResponse(
        404,
        '{"error":"not-connected","detail":"no SDK connection for shop/orders-1"}',
      ),
    ).toEqual({
      ok: false,
      status: 404,
      error: "not-connected",
      detail: "no SDK connection for shop/orders-1",
    });
  });

  it("2xx인데 JSON이 아니면 unexpected-body", () => {
    expect(parseApiResponse(200, "<!doctype html><html>")).toEqual({
      ok: false,
      status: 200,
      error: UNEXPECTED_BODY,
      detail: "body is not JSON: <!doctype html><html>",
    });
  });

  it("빈 오류 본문은 (empty)로 알림", () => {
    expect(parseApiResponse(502, "")).toEqual({
      ok: false,
      status: 502,
      error: UNEXPECTED_BODY,
      detail: "error body is not { error, detail }: (empty)",
    });
  });

  it("모양이 다른 오류 본문은 unexpected-body", () => {
    const result = parseApiResponse(500, '{"error":500,"message":"boom"}');
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      error: UNEXPECTED_BODY,
    });
  });

  it("알아볼 수 없는 긴 본문은 앞 200자만 detail에 넣음", () => {
    const result = parseApiResponse(500, "x".repeat(1000));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toBe(
        `error body is not { error, detail }: ${"x".repeat(200)}…`,
      );
    }
  });
});
