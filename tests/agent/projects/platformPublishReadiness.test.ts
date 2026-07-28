import { describe, expect, it } from "vitest";
import { evaluatePlatformPublishReadiness, PLATFORM_RELEASE_BEHAVIORS } from "../../../src/agent/projects/platform/publishReadiness.js";
import { getProjectHooks } from "../../../src/agent/projects/projectHooks.js";

// article_body emits the CLIENT-shaped envelope and the readiness gate validates it against that
// node's own outputSchema, so the fixtures carry the envelope with the client's object under `body` —
// the shape a real pipeline output has.
const envelope = (body: unknown) => ({
  artifact: "article_body.v1",
  summary: "Reader-facing body assembled for the readiness tests.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "contract_get", fetchedAt: "2026-07-16T00:00:00.000Z" },
  body
});
const validBody = envelope({ schema_version: "article_body.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "T", body: "Reader body." } }] });
const ready = {
  articleBody: validBody,
  taxonomy: { tags: ["engine"] },
  approval: { pinned: true, approvedBy: "editor" },
  releaseBehavior: "publish_now",
  hardConstraints: { contentPath: "article_body.v1", artifactProtocol: "pdf_tool_platform_blob.v1", legacyFallbacksUsed: false }
};

describe("Platform publish readiness", () => {
  it("is registered in the project-hook registry so the generic publisher and readiness surface find it", () => {
    expect(getProjectHooks("platform")?.evaluatePublishReadiness).toBe(evaluatePlatformPublishReadiness);
    expect(getProjectHooks("platform")?.knowledge).toBeDefined();
  });

  it("is GO when every requirement is satisfied", () => {
    const r = evaluatePlatformPublishReadiness(ready);
    expect(r.status).toBe("go");
    expect(r.state).toBe("ready_for_publish_execution");
    expect(r.blockers).toEqual([]);
    expect(r.checklist.map((c) => c.key)).toEqual(expect.arrayContaining(["article_body_valid", "media_artifacts_verified", "taxonomy", "pinned_approval", "release_behavior", "hard_content_path", "hard_artifact_protocol", "hard_legacy_fallbacks"]));
  });

  it("is NO-GO listing every blocker for an empty request", () => {
    const r = evaluatePlatformPublishReadiness({});
    expect(r.status).toBe("no_go");
    expect(r.state).toBe("blocked_for_publish_execution");
    expect(r.blockers).toEqual(expect.arrayContaining(["article_body_valid", "taxonomy", "pinned_approval", "release_behavior", "hard_artifact_protocol", "hard_legacy_fallbacks"]));
    expect(r.requiredAction).toContain("Resolve:");
  });

  it("does not trust Blob-shaped media unless pdf-tool materialization is verified", () => {
    const body = envelope({ schema_version: "article_body.v1", nodes: [{ id: "n_img", kind: "content", visibility: "public", public: { title: "T", media: { type: "image", src: "image/req_x/abc.png" } } }] });
    expect(evaluatePlatformPublishReadiness({ ...ready, articleBody: body }).blockers).toContain("media_artifacts_verified");
    expect(evaluatePlatformPublishReadiness({ ...ready, articleBody: body, verifiedMediaRefs: ["image/req_x/abc.png"] }).status).toBe("go");
  });

  it("accepts an explicitly-empty taxonomy but blocks a silently-missing one", () => {
    expect(evaluatePlatformPublishReadiness({ ...ready, taxonomy: { acceptedEmpty: true } }).status).toBe("go");
    expect(evaluatePlatformPublishReadiness({ ...ready, taxonomy: {} }).blockers).toContain("taxonomy");
  });

  it("accepts only object-substrate release behaviors — no schedule, no unpublish", () => {
    for (const behavior of PLATFORM_RELEASE_BEHAVIORS) {
      expect(evaluatePlatformPublishReadiness({ ...ready, releaseBehavior: behavior }).blockers).not.toContain("release_behavior");
    }
    // The legacy dialect's behaviors are not valid on the object-native client.
    expect(evaluatePlatformPublishReadiness({ ...ready, releaseBehavior: "schedule" }).blockers).toContain("release_behavior");
    expect(evaluatePlatformPublishReadiness({ ...ready, releaseBehavior: "unpublish" }).blockers).toContain("release_behavior");
  });

  it("enforces platform's hard constraints exactly, including its own artifact protocol", () => {
    expect(evaluatePlatformPublishReadiness({ ...ready, hardConstraints: { ...ready.hardConstraints, artifactProtocol: "pdf_tool_dr_lurie_blob.v1" } }).blockers).toContain("hard_artifact_protocol");
    expect(evaluatePlatformPublishReadiness({ ...ready, hardConstraints: { ...ready.hardConstraints, legacyFallbacksUsed: true } }).blockers).toContain("hard_legacy_fallbacks");
    expect(evaluatePlatformPublishReadiness(ready).hardConstraints).toEqual({ contentPath: "article_body.v1", artifactProtocol: "pdf_tool_platform_blob.v1", legacyFallbacksUsed: false });
  });

  it("leaves Dr. Lurie's registration untouched", () => {
    expect(getProjectHooks("dr-lurie")?.evaluatePublishReadiness).toBeDefined();
    expect(getProjectHooks("dr-lurie")?.evaluatePublishReadiness).not.toBe(evaluatePlatformPublishReadiness);
  });
});
