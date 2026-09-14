import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_CAPTURE_POLICY,
  SELF_CAPTURE_MAX_PAGES,
  resolveProjectCapturePolicy,
  selfCaptureOrigin,
  type ProjectCapturePolicy
} from "../../../src/agent/projects/projectTypes.js";

// W21 — every tenant may crawl its OWN site, and only its own, without an operator ever saying so.
// The live defect this closes: site_platform could not capture itself while carrying authority over
// https://www.zilbermanfilmfoundation.com, copied onto three project records by one 2026-08 clone
// job. These tests pin BOTH halves — the grant, and the fact that it grants nothing else.

const thirdPartyPolicy = (origin: string): ProjectCapturePolicy => ({
  ...structuredClone(DEFAULT_PROJECT_CAPTURE_POLICY),
  maxPages: 20,
  allowedCrawlOrigins: [origin],
  allowedPathPrefixes: ["/"],
  rights: { content: "retain_allowed_origin_content", media: "retain_referenced_allowed_origin_media" }
});

describe("selfCaptureOrigin — the tenant's own origin, from the record as it already stands", () => {
  it("derives the origin from mcpEndpoint, dropping the /mcp path", () => {
    expect(selfCaptureOrigin({ mcpEndpoint: "https://kugel-platform.netlify.app/mcp" })).toBe(
      "https://kugel-platform.netlify.app"
    );
  });

  it("falls back to the clientSiteBinding's Netlify site name when the endpoint resolves from an env var", () => {
    expect(selfCaptureOrigin({ clientSiteBinding: { netlifySiteName: "drluriescience" } })).toBe(
      "https://drluriescience.netlify.app"
    );
  });

  it("prefers the stored endpoint over the binding when a tenant has both (a custom domain outranks the convention)", () => {
    expect(
      selfCaptureOrigin({
        mcpEndpoint: "https://www.example-tenant.com/mcp",
        clientSiteBinding: { netlifySiteName: "example-tenant" }
      })
    ).toBe("https://www.example-tenant.com");
  });

  it("is undefined for a record carrying neither, and for a non-HTTPS endpoint", () => {
    expect(selfCaptureOrigin({})).toBeUndefined();
    expect(selfCaptureOrigin({ mcpEndpoint: "http://insecure.test/mcp" })).toBeUndefined();
    expect(selfCaptureOrigin({ mcpEndpoint: "not a url" })).toBeUndefined();
  });

  it("is pure: the same config derives the same origin, and no input object is mutated", () => {
    const config = { mcpEndpoint: "https://kugel-platform.netlify.app/mcp" };
    const snapshot = structuredClone(config);
    expect(selfCaptureOrigin(config)).toBe(selfCaptureOrigin(config));
    expect(config).toEqual(snapshot);
  });
});

describe("resolveProjectCapturePolicy — self-capture is layered on the deny-all floor, never through it", () => {
  it("grants a project with NO stored policy exactly its own origin, at the self-capture page floor", () => {
    const resolved = resolveProjectCapturePolicy({ mcpEndpoint: "https://kugel-platform.netlify.app/mcp" });
    expect(resolved.allowedCrawlOrigins).toEqual(["https://kugel-platform.netlify.app"]);
    expect(resolved.allowedPathPrefixes).toEqual(["/"]);
    expect(resolved.maxPages).toBe(SELF_CAPTURE_MAX_PAGES);
  });

  it("grants NOTHING to a record that names no site at all — the floor still stands where there is no own origin", () => {
    expect(resolveProjectCapturePolicy({ capturePolicy: undefined })).toEqual(DEFAULT_PROJECT_CAPTURE_POLICY);
  });

  it("adds the own origin ALONGSIDE a stored third-party origin without disturbing it", () => {
    const resolved = resolveProjectCapturePolicy({
      capturePolicy: thirdPartyPolicy("https://www.zilbermanfilmfoundation.com"),
      mcpEndpoint: "https://kugel-platform.netlify.app/mcp"
    });
    expect(resolved.allowedCrawlOrigins).toEqual([
      "https://www.zilbermanfilmfoundation.com",
      "https://kugel-platform.netlify.app"
    ]);
  });

  it("never DOUBLES an own origin a stored policy already lists", () => {
    const resolved = resolveProjectCapturePolicy({
      capturePolicy: thirdPartyPolicy("https://kugel-platform.netlify.app"),
      mcpEndpoint: "https://kugel-platform.netlify.app/mcp"
    });
    expect(resolved.allowedCrawlOrigins).toEqual(["https://kugel-platform.netlify.app"]);
  });

  it("treats maxPages as a FLOOR: a project that authorized more keeps its own number", () => {
    const generous = { ...thirdPartyPolicy("https://elsewhere.test"), maxPages: 45 };
    const resolved = resolveProjectCapturePolicy({
      capturePolicy: generous,
      mcpEndpoint: "https://kugel-platform.netlify.app/mcp"
    });
    expect(resolved.maxPages).toBe(45);
  });

  it("does NOT raise rights: retention is policy-wide, so self-capture must not widen it over a third-party origin", () => {
    const resolved = resolveProjectCapturePolicy({
      capturePolicy: {
        ...thirdPartyPolicy("https://www.zilbermanfilmfoundation.com"),
        rights: { content: "prohibited", media: "prohibited" }
      },
      mcpEndpoint: "https://kugel-platform.netlify.app/mcp"
    });
    expect(resolved.rights).toEqual({ content: "prohibited", media: "prohibited" });
  });

  it("leaves every other invariant exactly as stored — this resolver may add an origin and nothing else", () => {
    const stored = thirdPartyPolicy("https://elsewhere.test");
    const resolved = resolveProjectCapturePolicy({
      capturePolicy: stored,
      mcpEndpoint: "https://kugel-platform.netlify.app/mcp"
    });
    expect(resolved.sameOriginOnly).toBe(stored.sameOriginOnly);
    expect(resolved.respectRobots).toBe(stored.respectRobots);
    expect(resolved.authenticatedAccess).toBe(stored.authenticatedAccess);
    expect(resolved.concurrency).toBe(stored.concurrency);
    expect(resolved.delayMs).toBe(stored.delayMs);
    expect(resolved.designReferences).toEqual(stored.designReferences);
    expect(resolved.fidelity).toEqual(stored.fidelity);
  });

  it("does not mutate the stored policy it was handed (two resolves never accumulate origins)", () => {
    const stored = thirdPartyPolicy("https://elsewhere.test");
    const config = { capturePolicy: stored, mcpEndpoint: "https://kugel-platform.netlify.app/mcp" };
    resolveProjectCapturePolicy(config);
    const second = resolveProjectCapturePolicy(config);
    expect(stored.allowedCrawlOrigins).toEqual(["https://elsewhere.test"]);
    expect(second.allowedCrawlOrigins).toHaveLength(2);
  });

  // INTERACTION WITH MINT-ONLY GENESIS (#340). A tenant minted with no sourceUrl is seeded
  // DENY-ALL on the record — allowedCrawlOrigins: [] — on the reading that "no source was
  // supplied" must fail closed. That reading is about THIRD-PARTY authority and it survives here
  // intact: the stored record is untouched, and nothing this resolver does lets a newborn tenant
  // crawl anyone else.
  //
  // What it does get is its own origin, because reading back the pages you just published is not
  // an authority over somebody else's site. #340 asserts the STORED record (correctly, and it
  // still passes); this pins the RESOLVED value, the layer self-capture acts on. Both laws hold at
  // once and they are about different things — if that stops being the intent, this is the test
  // that should fail, and #340's "inventing one (its own origin…)" comment is the one to correct.
  it("still self-captures a tenant whose stored policy is explicitly deny-all (a mint-only genesis record)", () => {
    const mintOnly: ProjectCapturePolicy = {
      ...structuredClone(DEFAULT_PROJECT_CAPTURE_POLICY),
      allowedCrawlOrigins: [],
      allowedPathPrefixes: []
    };
    const resolved = resolveProjectCapturePolicy({
      capturePolicy: mintOnly,
      mcpEndpoint: "https://kugel-genesis-lab-3.netlify.app/mcp"
    });
    expect(resolved.allowedCrawlOrigins).toEqual(["https://kugel-genesis-lab-3.netlify.app"]);
    expect(resolved.maxPages).toBe(SELF_CAPTURE_MAX_PAGES);
    // The record it was handed is still deny-all — self-capture resolves, it never writes.
    expect(mintOnly.allowedCrawlOrigins).toEqual([]);
  });

  it("is parity by construction: two tenants differing only in their own origin resolve identically otherwise", () => {
    const a = resolveProjectCapturePolicy({ mcpEndpoint: "https://tenant-a.netlify.app/mcp" });
    const b = resolveProjectCapturePolicy({ mcpEndpoint: "https://tenant-b.netlify.app/mcp" });
    expect(a.allowedCrawlOrigins).toEqual(["https://tenant-a.netlify.app"]);
    expect(b.allowedCrawlOrigins).toEqual(["https://tenant-b.netlify.app"]);
    expect({ ...a, allowedCrawlOrigins: [] }).toEqual({ ...b, allowedCrawlOrigins: [] });
  });
});
