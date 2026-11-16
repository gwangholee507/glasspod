import { describe, expect, it } from "vitest";
import { podApiPath, podsPath, statusChangesPath, streamPath } from "./pods.js";

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

describe("목록·판단 변화·SSE 경로", () => {
  it("namespace가 없으면 쿼리를 붙이지 않음", () => {
    expect(podsPath()).toBe("/api/pods");
    expect(statusChangesPath()).toBe("/api/status-changes");
    expect(streamPath()).toBe("/api/stream");
  });

  it("namespace를 쿼리로 인코딩함", () => {
    expect(podsPath("glasspod-demo")).toBe("/api/pods?namespace=glasspod-demo");
    expect(streamPath("a&b=c")).toBe("/api/stream?namespace=a%26b%3Dc");
  });
});
