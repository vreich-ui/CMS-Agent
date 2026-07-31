import { describe, expect, it } from "vitest";
import { summarizeArtifactPolicyWarnings, validateArticleBodyImagePlacement, validateNoRawImageArtifactPublicUrls } from "../../src/agent/projects/drLurie/artifactPolicy.js";

// Fixtures match Dr. Lurie's LIVE content_item contract (fetched 2026-07-31): media lives at
// nodes[].public.media, never a flat nodes[].media, and the pipeline hands the client_object
// envelope whose content sits under `.body`. The validator was dead code against both shapes.
describe("Dr. Lurie artifact policy", () => {
  it("warns when an image node lacks inline rendering placement (contract shape: nodes[].public.media)", () => {
    const warnings = validateArticleBodyImagePlacement({
      artifact: "client_object.v1",
      body: {
        nodes: [{ id: "n_a1b2c3", kind: "image", public: { media: { type: "image", src: "image/req_demo/abc123.png" } } }]
      }
    });

    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "image_missing_inline_rendering_placement", severity: "warning" })]));
  });

  it("also accepts a bare content_item (no envelope) with the same contract shape", () => {
    const warnings = validateArticleBodyImagePlacement({
      nodes: [{ id: "n_a1b2c3", kind: "image", public: { media: { type: "image", src: "image/req_demo/abc123.png" } } }]
    });
    expect(warnings).toHaveLength(1);
  });

  it("does not warn when an image node declares inline rendering placement", () => {
    expect(validateArticleBodyImagePlacement({
      artifact: "client_object.v1",
      body: {
        nodes: [{ id: "n_a1b2c3", kind: "image", public: { media: { type: "image", src: "image/req_demo/abc123.png" } }, rendering: { placement: "inline" } }]
      }
    })).toEqual([]);
  });

  it("regression: the legacy flat nodes[].media shape does not exist in the contract and matches nothing", () => {
    // The old validator ONLY matched this shape — which the pipeline never produces — so it never
    // fired. It must stay silent here (a wrong "no media" is caught downstream by artifact
    // verification), and fire on the contract shape above.
    expect(validateArticleBodyImagePlacement({
      nodes: [{ id: "n_a1b2c3", kind: "text", media: { type: "image", src: "image/req_demo/abc123.png" } }]
    })).toEqual([]);
  });

  it("errors on raw image artifact refs in public reader-facing fields", () => {
    const warnings = validateNoRawImageArtifactPublicUrls({ public: { featuredImage: "image/req_demo/abc123.png" } });

    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "raw_image_artifact_public_url", severity: "error", path: "public.featuredImage" })]));
  });

  it("treats PDF artifact routes differently from image artifacts", () => {
    expect(validateNoRawImageArtifactPublicUrls({ public: { href: "/pdf/req_demo/abc123.pdf" } })).toEqual([]);
    expect(summarizeArtifactPolicyWarnings({ public: { href: "/pdf/req_demo/abc123.pdf" } })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "pdf_artifact_route_allowed" })]));
  });
});
