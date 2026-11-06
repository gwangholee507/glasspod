import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@glasspod/protocol";

// 모노레포 설정 확인용 테스트입니다.
// dist/가 없어도 다른 워크스페이스의 소스(src/)를 불러오는지 봅니다.
describe("workspace setup", () => {
  it("imports @glasspod/protocol from source", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
