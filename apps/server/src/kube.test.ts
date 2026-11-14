import { ApiException } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { chooseKubeSource, describeError } from "./kube.js";
import { retryDelayMs } from "./watch.js";

describe("chooseKubeSource", () => {
  it("context를 정하면 클러스터 안에서도 kubeconfig의 그 context", () => {
    expect(
      chooseKubeSource("docker-desktop", {
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
      }),
    ).toEqual({ kind: "kubeconfig", context: "docker-desktop" });
  });

  it("context가 없고 클러스터 안이면 ServiceAccount", () => {
    expect(
      chooseKubeSource(undefined, { KUBERNETES_SERVICE_HOST: "10.96.0.1" }),
    ).toEqual({ kind: "in-cluster" });
  });

  it("둘 다 없으면 끔. kubeconfig의 current-context는 쓰지 않음", () => {
    expect(chooseKubeSource(undefined, { KUBECONFIG: "/tmp/config" })).toEqual({
      kind: "disabled",
      reason: "GLASSPOD_KUBE_CONTEXT is not set and not running in a cluster",
    });
  });
});

describe("describeError", () => {
  it("HTTP 오류는 상태 코드만", () => {
    expect(
      describeError(new ApiException(401, "HTTP-Code: 401", undefined, {})),
    ).toBe("http 401");
    expect(
      describeError(Object.assign(new Error("Forbidden"), { statusCode: 403 })),
    ).toBe("http 403");
  });

  it("네트워크 오류는 원인까지, 주소가 둘이면 첫 번째", () => {
    const refused = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:8001"),
      { code: "ECONNREFUSED" },
    );
    expect(
      describeError(new TypeError("fetch failed", { cause: refused })),
    ).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:8001");
    expect(
      describeError(
        new TypeError("fetch failed", {
          cause: new AggregateError([refused], ""),
        }),
      ),
    ).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:8001");
  });

  it("긴 설명은 200자에서 자름", () => {
    expect(describeError(new Error("x".repeat(300)))).toHaveLength(201);
  });
});

describe("retryDelayMs", () => {
  it("1초부터 2배씩, 30초까지", () => {
    expect([1, 2, 3, 5, 6, 10].map(retryDelayMs)).toEqual([
      1000, 2000, 4000, 16000, 30000, 30000,
    ]);
  });
});
