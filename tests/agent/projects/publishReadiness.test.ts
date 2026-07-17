import { describe, expect, it } from "vitest";
import { evaluateDrLuriePublishReadiness } from "../../../src/agent/projects/drLurie/publishReadiness.js";

const validBody = { schema_version: "article_body.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "T", body: "Reader body." } }] };
const ready = {
  articleBody: validBody,
  taxonomy: { tags: ["science"] },
  approval: { pinned: true, approvedBy: "editor" },
  releaseBehavior: "publish_now",
  hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
};
const keys = (r: ReturnType<typeof evaluateDrLuriePublishReadiness>) => r.checklist.map((c) => c.key);

describe("Dr. Lurie publish readiness", () => {
  it("is GO when every requirement is satisfied", () => {
    const r = evaluateDrLuriePublishReadiness(ready);
    expect(r.status).toBe("go");
    expect(r.state).toBe("ready_for_publish_execution");
    expect(r.blockers).toEqual([]);
    expect(keys(r)).toEqual(expect.arrayContaining(["article_body_valid", "media_artifacts_verified", "taxonomy", "pinned_approval", "release_behavior", "hard_content_path", "hard_artifact_protocol", "hard_legacy_fallbacks"]));
  });

  it("is NO-GO listing every blocker for an empty request", () => {
    const r = evaluateDrLuriePublishReadiness({});
    expect(r.status).toBe("no_go");
    expect(r.state).toBe("blocked_for_publish_execution");
    expect(r.blockers).toEqual(expect.arrayContaining(["article_body_valid", "taxonomy", "pinned_approval", "release_behavior", "hard_artifact_protocol", "hard_legacy_fallbacks"]));
    expect(r.requiredAction).toContain("Resolve:");
  });

  it("does not trust Blob-shaped media unless pdf-tool materialization is verified", () => {
    const body = { schema_version: "article_body.v1", nodes: [{ id: "n_img", kind: "content", visibility: "public", public: { title: "T", media: { type: "image", src: "image/req_x/abc.png" } } }] };
    const unverified = evaluateDrLuriePublishReadiness({ ...ready, articleBody: body });
    expect(unverified.blockers).toContain("media_artifacts_verified");
    // Confirming the ref as materialized clears the blocker.
    const verified = evaluateDrLuriePublishReadiness({ ...ready, articleBody: body, verifiedMediaRefs: ["image/req_x/abc.png"] });
    expect(verified.status).toBe("go");
  });

  it("accepts an explicitly-empty taxonomy but blocks a silently-missing one", () => {
    expect(evaluateDrLuriePublishReadiness({ ...ready, taxonomy: { acceptedEmpty: true } }).status).toBe("go");
    expect(evaluateDrLuriePublishReadiness({ ...ready, taxonomy: {} }).blockers).toContain("taxonomy");
  });

  it("blocks a missing pinned approval and an unselected release behavior", () => {
    expect(evaluateDrLuriePublishReadiness({ ...ready, approval: { pinned: false } }).blockers).toContain("pinned_approval");
    expect(evaluateDrLuriePublishReadiness({ ...ready, releaseBehavior: undefined }).blockers).toContain("release_behavior");
    expect(evaluateDrLuriePublishReadiness({ ...ready, releaseBehavior: "yolo" }).blockers).toContain("release_behavior");
  });

  it("enforces the hard constraints exactly", () => {
    expect(evaluateDrLuriePublishReadiness({ ...ready, hardConstraints: { ...ready.hardConstraints, legacyFallbacksUsed: true } }).blockers).toContain("hard_legacy_fallbacks");
    expect(evaluateDrLuriePublishReadiness({ ...ready, hardConstraints: { ...ready.hardConstraints, artifactProtocol: "legacy_blob" } }).blockers).toContain("hard_artifact_protocol");
    // The GO result always reports the canonical hard constraints.
    expect(evaluateDrLuriePublishReadiness(ready).hardConstraints).toEqual({ contentPath: "article_body.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false });
  });
});
