import { describe, expect, it } from "vitest";
import { seededGenesisCapturePolicy } from "../../../src/agent/capture/siteGenesis.js";
import { DEFAULT_PROJECT_CAPTURE_POLICY, resolveProjectCapturePolicy } from "../../../src/agent/projects/projectTypes.js";
import { PLATFORM_CAPTURE_POLICY } from "../../../src/agent/projects/platform/definition.js";

// T15.13 — ProjectCapturePolicy derived from the source URL, generalized beyond the one
// hand-provisioned client (platform's hardcoded https://www.zilbermanfilmfoundation.com). These
// tests exercise `seededGenesisCapturePolicy` directly (a pure function of the source origin — no
// clock, no randomness, no repository read) against an origin that appears in NO project
// definition anywhere in this codebase, per the issue's own acceptance test.

// Deliberately not the platform project's hardcoded origin, and not used by any other project
// definition or default connection in this repo (verified against platform/definition.ts, the only
// file that hardcodes allowedCrawlOrigins).
const ARBITRARY_SOURCE_URL = "https://an-example-prospect-site.test/about/team?ref=homepage";
const ARBITRARY_ORIGIN = "https://an-example-prospect-site.test";

describe("seededGenesisCapturePolicy — derive ProjectCapturePolicy from an arbitrary source URL", () => {
  it("derives allowedCrawlOrigins as exactly the source ORIGIN (path/query stripped), for a URL naming no project anywhere", () => {
    const derivedOrigin = new URL(ARBITRARY_SOURCE_URL).origin;
    expect(derivedOrigin).toBe(ARBITRARY_ORIGIN);
    const policy = seededGenesisCapturePolicy(derivedOrigin);
    expect(policy.allowedCrawlOrigins).toEqual([ARBITRARY_ORIGIN]);

    // This origin is genuinely arbitrary: it is not the one project definition that hardcodes a
    // crawl origin (platform), so nothing about the derivation is coincidentally piggybacking on
    // pre-existing configuration.
    expect(PLATFORM_CAPTURE_POLICY.allowedCrawlOrigins).not.toContain(ARBITRARY_ORIGIN);
  });

  it("stays a conservative default: maxPages 20 (comfortably under pdf-tool's 50 hard cap), same-origin, robots-respecting, single-connection, no rights or design-reference authority granted", () => {
    const policy = seededGenesisCapturePolicy(ARBITRARY_ORIGIN);
    expect(policy.maxPages).toBe(20);
    expect(policy.maxPages).toBeLessThan(50);
    expect(policy.allowedPathPrefixes).toEqual(["/"]);
    expect(policy.sameOriginOnly).toBe(true);
    expect(policy.respectRobots).toBe(true);
    expect(policy.concurrency).toBe(1);
    expect(policy.authenticatedAccess).toBe("prohibited");
    expect(policy.rights).toEqual({ content: "prohibited", media: "prohibited" });
    expect(policy.designReferences).toEqual([]);
    expect(policy.fidelity).toEqual({ mode: "source_faithful", sourceDesignTreatment: "source_content_and_design" });
  });

  it("is deterministic: the same source origin derives byte-for-byte the same policy every time, with no shared mutable state between calls", () => {
    const first = seededGenesisCapturePolicy(ARBITRARY_ORIGIN);
    const second = seededGenesisCapturePolicy(ARBITRARY_ORIGIN);
    expect(second).toEqual(first);
    expect(second).not.toBe(first); // fresh objects — mutating one result can never affect another
    first.allowedCrawlOrigins.push("https://mutation-should-not-leak.test");
    expect(second.allowedCrawlOrigins).toEqual([ARBITRARY_ORIGIN]);
  });

  it("scopes to exactly the given origin: two different arbitrary sources never derive each other's authority", () => {
    const policyA = seededGenesisCapturePolicy("https://prospect-a.test");
    const policyB = seededGenesisCapturePolicy("https://prospect-b.test");
    expect(policyA.allowedCrawlOrigins).toEqual(["https://prospect-a.test"]);
    expect(policyB.allowedCrawlOrigins).toEqual(["https://prospect-b.test"]);
    expect(policyA.allowedCrawlOrigins).not.toEqual(policyB.allowedCrawlOrigins);
  });
});

describe("T15.13 — the deny-all floor is untouched by URL-derived policy", () => {
  it("DEFAULT_PROJECT_CAPTURE_POLICY (the fallback for every project nobody has pointed a duplication at) is still deny-all, independent of any source URL", () => {
    expect(DEFAULT_PROJECT_CAPTURE_POLICY.maxPages).toBe(0);
    expect(DEFAULT_PROJECT_CAPTURE_POLICY.allowedCrawlOrigins).toEqual([]);
    expect(DEFAULT_PROJECT_CAPTURE_POLICY.allowedPathPrefixes).toEqual([]);
  });

  it("resolveProjectCapturePolicy denies capture for a project with no stored capturePolicy — deriving a policy from a URL is not something this resolver does, by construction (it takes no URL at all)", () => {
    const resolved = resolveProjectCapturePolicy({ capturePolicy: undefined });
    expect(resolved).toEqual(DEFAULT_PROJECT_CAPTURE_POLICY);
    expect(resolved.maxPages).toBe(0);
    expect(resolved.allowedCrawlOrigins).toEqual([]);
  });
});
