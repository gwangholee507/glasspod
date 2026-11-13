import { describe, expect, it } from "vitest";
import { podApiPath } from "./pods.js";

describe("podApiPath", () => {
  it("namespace와 이름을 경로에 넣음", () => {
    expect(podApiPath({ namespace: "glasspod-demo", name: "demo-1" })).toBe(
      "/api/pods/glasspod-demo/demo-1",
    );
  });

  it("주소에서 온 값은 경로 한 칸으로 인코딩함", () => {
    expect(podApiPath({ namespace: "a/b", name: "x y?" })).toBe(
      "/api/pods/a%2Fb/x%20y%3F",
    );
  });
});
