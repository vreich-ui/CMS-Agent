import { describe, expect, it } from "vitest";
import { summarizeArtifactPolicyWarnings, validateArticleBodyImagePlacement, validateNoRawImageArtifactPublicUrls } from "../../src/agent/projects/drLurie/artifactPolicy.js";

describe("Dr. Lurie artifact policy", () => {
  it("warns when an image node lacks inline rendering placement", () => {
    const warnings = validateArticleBodyImagePlacement({
      schema_version: "article_body.v1",
      nodes: [{ id: "n_Image1", kind: "image", media: { type: "image", src: "image/req_demo/abc123.png" } }]
    });

    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "image_missing_inline_rendering_placement", severity: "warning" })]));
  });

  it("does not warn when an image node declares inline rendering placement", () => {
    expect(validateArticleBodyImagePlacement({
      schema_version: "article_body.v1",
      nodes: [{ id: "n_Image1", kind: "image", media: { type: "image", src: "image/req_demo/abc123.png" }, rendering: { placement: "inline" } }]
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
