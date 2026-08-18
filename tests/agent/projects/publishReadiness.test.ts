import { describe, expect, it } from "vitest";
import { evaluateDrLuriePublishReadiness } from "../../../src/agent/projects/drLurie/publishReadiness.js";
// S3 item 7: readiness now requires reader-visible content (article_has_content, >= 200 visible
// chars), so the fixtures carry a realistic paragraph rather than a stub.
const PAD = " This paragraph exists so the fixture reads as a real article rather than a stub: it explains the claim, names the tradeoff, and gives the reader one concrete next step to take today.".repeat(2);


// article_body emits the CLIENT-shaped envelope and the readiness gate validates it against that
// node's own outputSchema, so the fixtures carry the envelope with Dr. Lurie's content_item under
// `body` — the shape a real pipeline output has.
const envelope = (body: unknown) => ({
  artifact: "client_object.v1",
  summary: "Reader-facing body assembled for the readiness tests.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "get_content_schema", fetchedAt: "2026-07-16T00:00:00.000Z" },
  body
});
const validBody = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "T", body: "Reader body." + PAD } }] });
const ready = {
  articleBody: validBody,
  taxonomy: { tags: ["science"] },
  approval: { pinned: true, approvedBy: "editor" },
  releaseBehavior: "publish_now",
  hardConstraints: { contentPath: "client_object.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
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

  it("is NO-GO only on the correctness blocker for an empty request — ceremony checks auto-default (go-live)", () => {
    const r = evaluateDrLuriePublishReadiness({});
    expect(r.status).toBe("no_go");
    expect(r.state).toBe("blocked_for_publish_execution");
    // Go-live 2026-07-31: taxonomy/approval/release/hard-constraint declarations auto-default; the
    // only blockers left on an empty request are the missing article body itself (and, S3 item 7,
    // the content floor that a missing body cannot clear).
    expect(r.blockers).toEqual(["article_body_valid", "article_has_content", "hard_content_path"]);
    expect(r.requiredAction).toContain("Resolve:");
  });

  it("does not trust Blob-shaped media unless pdf-tool materialization is verified", () => {
    const body = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_img", kind: "content", visibility: "public", public: { title: "T", body: "Reader body." + PAD, media: { type: "image", src: "image/req_x/abc.png" } } }] });
    const unverified = evaluateDrLuriePublishReadiness({ ...ready, articleBody: body });
    expect(unverified.blockers).toContain("media_artifacts_verified");
    // Confirming the ref as materialized clears the blocker.
    const verified = evaluateDrLuriePublishReadiness({ ...ready, articleBody: body, verifiedMediaRefs: ["image/req_x/abc.png"] });
    expect(verified.status).toBe("go");
  });

  it("accepts an explicitly-empty taxonomy and auto-accepts a missing one (go-live)", () => {
    expect(evaluateDrLuriePublishReadiness({ ...ready, taxonomy: { acceptedEmpty: true } }).status).toBe("go");
    expect(evaluateDrLuriePublishReadiness({ ...ready, taxonomy: {} }).status).toBe("go");
  });

  it("auto-approves absent approval, blocks only an explicitly-withheld one; release behavior defaults but an unknown value still fails", () => {
    expect(evaluateDrLuriePublishReadiness({ ...ready, approval: { pinned: false } }).blockers).toContain("pinned_approval");
    expect(evaluateDrLuriePublishReadiness({ ...ready, approval: undefined }).status).toBe("go");
    expect(evaluateDrLuriePublishReadiness({ ...ready, releaseBehavior: undefined }).status).toBe("go");
    expect(evaluateDrLuriePublishReadiness({ ...ready, releaseBehavior: "yolo" }).blockers).toContain("release_behavior");
  });

  it("enforces the hard constraints exactly", () => {
    expect(evaluateDrLuriePublishReadiness({ ...ready, hardConstraints: { ...ready.hardConstraints, legacyFallbacksUsed: true } }).blockers).toContain("hard_legacy_fallbacks");
    expect(evaluateDrLuriePublishReadiness({ ...ready, hardConstraints: { ...ready.hardConstraints, artifactProtocol: "legacy_blob" } }).blockers).toContain("hard_artifact_protocol");
    // The GO result always reports the canonical hard constraints.
    expect(evaluateDrLuriePublishReadiness(ready).hardConstraints).toEqual({ contentPath: "client_object.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false });
  });
});
