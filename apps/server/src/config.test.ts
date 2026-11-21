import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig action namespaces", () => {
  it("turns actions off when GLASSPOD_ACTION_NAMESPACES is missing or empty", () => {
    expect(loadConfig({}).actionNamespaces).toEqual([]);
    expect(
      loadConfig({ GLASSPOD_ACTION_NAMESPACES: " " }).actionNamespaces,
    ).toEqual([]);
  });

  it("reads watched namespaces once each", () => {
    expect(
      loadConfig({
        GLASSPOD_NAMESPACES: "shop,pay",
        GLASSPOD_ACTION_NAMESPACES: "pay, shop,pay",
      }).actionNamespaces,
    ).toEqual(["pay", "shop"]);
  });

  it("refuses a namespace that is not watched or not a name", () => {
    expect(() => loadConfig({ GLASSPOD_ACTION_NAMESPACES: "default" })).toThrow(
      /GLASSPOD_ACTION_NAMESPACES must be namespaces in/,
    );
    expect(() =>
      loadConfig({ GLASSPOD_ACTION_NAMESPACES: "glasspod-demo," }),
    ).toThrow(/GLASSPOD_ACTION_NAMESPACES must be a comma-separated list/);
  });
});
