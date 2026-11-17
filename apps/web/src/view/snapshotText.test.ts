import { describe, expect, it } from "vitest";
import { snapshotErrorText } from "./snapshotText.js";

describe("snapshotErrorText", () => {
  it("explains server error codes", () => {
    expect(snapshotErrorText("no-response")).toBe(
      "앱이 5초 안에 답하지 않았습니다. 이벤트 루프가 막혔을 수 있습니다.",
    );
    expect(snapshotErrorText("not-connected")).toBe(
      "SDK가 연결되어 있지 않습니다.",
    );
  });

  it("treats unknown codes as not reaching the server", () => {
    expect(snapshotErrorText("network-error")).toBe(
      "서버에 닿지 못했습니다 (network-error).",
    );
    // 객체의 기본 속성 이름도 모르는 코드로 봅니다.
    expect(snapshotErrorText("toString")).toBe(
      "서버에 닿지 못했습니다 (toString).",
    );
  });
});
