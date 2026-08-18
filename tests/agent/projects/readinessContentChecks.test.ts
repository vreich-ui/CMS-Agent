import { describe, expect, it } from "vitest";
import { evaluateDrLuriePublishReadiness } from "../../../src/agent/projects/drLurie/publishReadiness.js";
import { evaluatePlatformPublishReadiness } from "../../../src/agent/projects/platform/publishReadiness.js";
import { evaluateContentReadiness, mediaRefsOf } from "../../../src/agent/projects/readinessContentChecks.js";

// S3 item 7 — the three probe bodies from the live audit. Before this, an EMPTY body (nodes: [])
// reached "go", and an image node whose /img/... path pointed at nothing passed because only
// blob-shaped keys were checked.

const PARAGRAPH = "This paragraph exists so the fixture reads as a real article rather than a stub: it explains the claim, names the tradeoff, and gives the reader one concrete next step to take today. ".repeat(2);
const envelope = (body: unknown, extra: Record<string, unknown> = {}) => ({
  artifact: "client_object.v1",
  summary: "Probe body.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "get_content_schema", fetchedAt: "2026-07-16T00:00:00.000Z" },
  body,
  ...extra
});
const ready = {
  taxonomy: { tags: ["science"] },
  approval: { pinned: true, approvedBy: "editor" },
  releaseBehavior: "publish_now",
  hardConstraints: { contentPath: "client_object.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
};
const check = (r: { checklist: Array<{ key: string; status: string; detail?: string }> }, key: string) => r.checklist.find((c) => c.key === key);

describe("readiness content checks (S3 item 7)", () => {
  it("probe 1: nodes: [] is NO-GO on article_has_content", () => {
    const r = evaluateDrLuriePublishReadiness({ ...ready, articleBody: envelope({ schema_version: "client_object.v1", nodes: [] }) });
    expect(r.status).toBe("no_go");
    expect(r.blockers).toContain("article_has_content");
    expect(check(r, "article_has_content")?.detail).toContain("body.nodes is empty");
  });

  it("probe 2: one image node with a nonexistent /img/... src and no verifiedMediaRefs is NO-GO on media_artifacts_verified", () => {
    const body = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_img", kind: "content", visibility: "public", public: { title: "T", body: PARAGRAPH, media: { type: "image", src: "/img/req_probe_20260818_01/deadbeef.png", alt: "hero" } } }] });
    const r = evaluateDrLuriePublishReadiness({ ...ready, articleBody: body });
    expect(r.status).toBe("no_go");
    expect(r.blockers).toContain("media_artifacts_verified");
    // The same public path is accepted once the caller confirms the RAW key it renders from.
    const verified = evaluateDrLuriePublishReadiness({ ...ready, articleBody: body, verifiedMediaRefs: ["image/req_probe_20260818_01/deadbeef.png"] });
    expect(verified.blockers).not.toContain("media_artifacts_verified");
  });

  it("probe 3: a valid body with verified refs is GO, on both project twins", () => {
    const body = envelope({ schema_version: "client_object.v1", nodes: [
      { id: "n_intro", kind: "content", visibility: "public", public: { title: "Title", body: PARAGRAPH } },
      { id: "n_img", kind: "content", visibility: "public", public: { title: "Figure", body: "Caption.", media: { type: "image", src: "/img/req_probe_20260818_01/deadbeef.png", alt: "hero" } } }
    ] });
    const stageOutputs = { brief_architect: { artifact: "article_brief.v1", mediaSlots: [{ slotId: "hero" }] }, contract_intelligence: { artifact: "contract_intelligence.v1", blockers: [] } };
    const dr = evaluateDrLuriePublishReadiness({ ...ready, articleBody: body, verifiedMediaRefs: ["image/req_probe_20260818_01/deadbeef.png"], stageOutputs });
    expect(dr.status).toBe("go");
    expect(dr.blockers).toEqual([]);
    expect(check(dr, "media_requested_vs_delivered")?.status).toBe("pass");
    expect(check(dr, "upstream_blockers")?.status).toBe("pass");
    const platform = evaluatePlatformPublishReadiness({ ...ready, hardConstraints: { ...ready.hardConstraints, artifactProtocol: "pdf_tool_platform_blob.v1" }, articleBody: body, verifiedMediaRefs: ["image/req_probe_20260818_01/deadbeef.png"], stageOutputs });
    expect(platform.status).toBe("go");
  });

  it("article_body's own blockers and an unwaivable upstream blocker (aggression_ceiling_missing) each fail the gate", () => {
    const body = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_intro", kind: "content", visibility: "public", public: { title: "Title", body: PARAGRAPH } }] }, { blockers: ["client validator unreachable"] });
    const own = evaluateDrLuriePublishReadiness({ ...ready, articleBody: body });
    expect(own.blockers).toContain("article_body_blockers");
    const clean = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_intro", kind: "content", visibility: "public", public: { title: "Title", body: PARAGRAPH } }] });
    const upstream = evaluateDrLuriePublishReadiness({ ...ready, articleBody: clean, stageOutputs: { contract_intelligence: { blockers: [{ code: "aggression_ceiling_missing", message: "no ceiling" }] } } });
    expect(upstream.status).toBe("no_go");
    expect(upstream.blockers).toContain("upstream_blockers");
    expect(check(upstream, "upstream_blockers")?.detail).toContain("contract_intelligence: aggression_ceiling_missing");
  });

  it("media requested by brief_architect but none delivered fails media_requested_vs_delivered; unknown stage outputs are accepted_empty, not passed", () => {
    const clean = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_intro", kind: "content", visibility: "public", public: { title: "Title", body: PARAGRAPH } }] });
    const r = evaluateDrLuriePublishReadiness({ ...ready, articleBody: clean, stageOutputs: { brief_architect: { mediaSlots: [{ slotId: "hero" }, { slotId: "diagram" }] } } });
    expect(r.blockers).toContain("media_requested_vs_delivered");
    const noStages = evaluateDrLuriePublishReadiness({ ...ready, articleBody: clean });
    expect(check(noStages, "media_requested_vs_delivered")?.status).toBe("accepted_empty");
    expect(check(noStages, "upstream_blockers")?.status).toBe("accepted_empty");
    expect(noStages.status).toBe("go");
  });

  it("walks image src AND pdf refs (public.href, media.pdf) when collecting references", () => {
    const body = envelope({ schema_version: "client_object.v1", nodes: [
      { id: "n_a", kind: "content", public: { title: "A", body: PARAGRAPH, media: { type: "image", src: "image/req_x/a.png", pdf: "pdf/req_x/a.pdf" } } },
      { id: "n_b", kind: "content", public: { title: "B", href: "/pdf/req_x/b.pdf" } }
    ] });
    expect(mediaRefsOf(body).sort()).toEqual(["/pdf/req_x/b.pdf", "image/req_x/a.png", "pdf/req_x/a.pdf"]);
    const checks = evaluateContentReadiness({ articleBody: body, articleBodyValid: true, verifiedMediaRefs: ["image/req_x/a.png", "pdf/req_x/a.pdf"] });
    expect(checks.find((c) => c.key === "media_artifacts_verified")?.detail).toContain("/pdf/req_x/b.pdf");
  });
});
