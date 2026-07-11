import { describe, expect, it } from "vitest";
import { defaultRoute, formatRoute, navPages, parseRoute, routeLabel, routesEqual } from "../../ui/src/route.js";

describe("parseRoute", () => {
  it("maps / and /overview and unknown paths to overview without redirects", () => {
    expect(parseRoute("/", "")).toEqual({ page: "overview" });
    expect(parseRoute("/overview", "")).toEqual({ page: "overview" });
    expect(parseRoute("/nonsense", "")).toEqual({ page: "overview" });
    expect(parseRoute("/overview/extra/segments", "")).toEqual({ page: "overview" });
  });

  it("round-trips every nav page through parse and format", () => {
    for (const { page } of navPages) {
      const formatted = formatRoute({ page } as Parameters<typeof formatRoute>[0]);
      expect(parseRoute(formatted, "")).toEqual({ page });
    }
  });

  it("parses constellation legacy and mode params and drops invalid values", () => {
    expect(parseRoute("/constellation", "?legacy=builder")).toEqual({ page: "constellation", legacy: "builder" });
    expect(parseRoute("/constellation", "?legacy=nodes&mode=design")).toEqual({ page: "constellation", legacy: "nodes", mode: "design" });
    expect(parseRoute("/constellation", "?legacy=bogus&mode=warp")).toEqual({ page: "constellation" });
    expect(parseRoute("/constellation/", "?mode=history")).toEqual({ page: "constellation", mode: "history" });
  });

  it("ignores trailing slashes", () => {
    expect(parseRoute("/runs/", "")).toEqual({ page: "runs" });
    expect(parseRoute("//settings//", "")).toEqual({ page: "settings" });
  });
});

describe("formatRoute", () => {
  it("omits defaults and serializes params", () => {
    expect(formatRoute({ page: "constellation" })).toBe("/constellation");
    expect(formatRoute({ page: "constellation", legacy: "builder" })).toBe("/constellation?legacy=builder");
    expect(formatRoute({ page: "constellation", legacy: "nodes", mode: "operate" })).toBe("/constellation?legacy=nodes&mode=operate");
    expect(formatRoute({ page: "runs" })).toBe("/runs");
  });
});

describe("routesEqual / routeLabel / defaults", () => {
  it("compares by canonical form", () => {
    expect(routesEqual({ page: "constellation" }, parseRoute("/constellation/", ""))).toBe(true);
    expect(routesEqual({ page: "constellation", legacy: "builder" }, { page: "constellation" })).toBe(false);
  });

  it("labels navigation targets for attention buttons", () => {
    expect(routeLabel({ page: "constellation", legacy: "builder" })).toBe("Open builder");
    expect(routeLabel({ page: "constellation", legacy: "nodes" })).toBe("Open nodes");
    expect(routeLabel({ page: "settings" })).toBe("Open settings");
  });

  it("defaults to overview", () => {
    expect(defaultRoute).toEqual({ page: "overview" });
  });
});
