import { describe, expect, it } from "vitest";

import { createSiteContentTools } from "../../../src/agent/mcp/workspace/siteContentTools.js";
import type { SiteContextSource } from "../../../src/agent/operations/siteContext.js";
import { WorkspaceToolError } from "../../../src/agent/mcp/workspace/toolKit.js";

// site_content.compile_page_objects -- the read-only review surface. The compilation rules
// themselves are pinned in tests/agent/operations/siteContentObjectCompiler.test.ts; this file
// guards the wire behaviour: project gating, a snapshot read failure reported as itself rather than
// compiled against nothing, a refusal returned as a RESULT, and the absence of any write path.

const activeProject = { get: async () => ({ projectId: "acme", status: "active" }) } as never;

const SECTION_CONTRACT = {
  objectType: "section",
  required: ["sectionType", "data"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["sectionType", "data"],
    properties: { sectionType: { type: "string", enum: ["prose", "bio", "faq", "steps"] }, data: { type: "object", additionalProperties: true } }
  },
  // The real registry lives here — a TOP-LEVEL contract field, never a path inside `schema` (see
  // siteContentObjectCompiler.ts's "CORRECTION" note, PR #387 review).
  sectionTypes: ["prose", "bio", "faq", "steps"]
};
const PAGE_CONTRACT = {
  objectType: "page",
  required: ["pageType", "slug", "title", "sections"],
  schema: {
    type: "object",
    additionalProperties: true,
    required: ["pageType", "slug", "title", "sections"],
    properties: { pageType: { type: "string" }, slug: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, sections: { type: "array" } }
  }
};

// Every method a write would have to travel through throws if touched; a compile that completes
// proves no write path was taken (the same structural argument siteContextSourceAdapter.test.ts
// makes about its own transport).
const readOnlySource = (revisionId: string | null = "rev_1"): SiteContextSource => ({
  listObjects: async () => [],
  getObjectContract: async ({ objectType }) => (objectType === "section" ? (SECTION_CONTRACT as never) : objectType === "page" ? (PAGE_CONTRACT as never) : null),
  getRegistries: async () => ({ visualStandards: [], pdfTemplates: [], imagePolicyContexts: [] }),
  getRevisionId: async () => revisionId
});

const compileTool = (source: SiteContextSource) =>
  createSiteContentTools({ projectRepository: activeProject, siteContextSource: source }).find((entry) => entry.name === "site_content.compile_page_objects")!;

const ORGANIZATION = { order: 1, sectionType: "about_overview", draft: { narrativeKind: "organization", title: "Who we are", body: "<p>Since 1974.</p>", groundedIn: ["src"] }, runId: "run_a", executionId: "exec_a" };
const PAGE = { fields: { pageType: "standard", slug: "about", title: "About" } };

describe("site_content.compile_page_objects", () => {
  it("is registered, and its description says compiling is not applying", () => {
    const tool = compileTool(readOnlySource());
    expect(tool).toBeDefined();
    expect(tool.description).toContain("read-only");
    expect(tool.description).toMatch(/nothing here saves, applies, publishes or releases/i);
  });

  it("compiles a drafted section into a reviewable plan, carrying the snapshot it was computed from", async () => {
    // A fresh revision id per test avoids the module-level snapshot cache handing back another
    // test's capture.
    const result = (await compileTool(readOnlySource("rev_compile_ok")).execute({ project_id: "acme", drafted: [ORGANIZATION], page: PAGE })) as { data: unknown };
    const payload = result.data as { compiled: boolean; plan: { schemaVersion: string; sectionProvenance: { componentType: string; order: number; sourceRunId: string }[] }; revisionId: string };

    expect(payload.compiled).toBe(true);
    expect(payload.plan.schemaVersion).toBe("site-page-materialization.v2");
    expect(payload.plan.sectionProvenance[0]).toMatchObject({ componentType: "prose", order: 1, sourceRunId: "run_a" });
    expect(payload.revisionId).toBe("rev_compile_ok");
  });

  it("returns a refusal as a result with named blockers, not a thrown error", async () => {
    const result = (await compileTool(readOnlySource("rev_compile_refuse")).execute({
      project_id: "acme",
      drafted: [{ order: 0, sectionType: "questions", draft: { referenceKind: "faq", title: "Q", body: "<p>…</p>", groundedIn: ["s"] } }],
      page: PAGE
    })) as { data: unknown };
    const payload = result.data as { compiled: boolean; blockers: { code: string; remedy: string }[] };

    expect(payload.compiled).toBe(false);
    expect(payload.blockers[0]!.code).toBe("faq_items_missing");
    expect(payload.blockers[0]!.remedy.length).toBeGreaterThan(0);
  });

  it("reports an unreadable snapshot as itself rather than compiling against an empty one", async () => {
    const blind: SiteContextSource = { ...readOnlySource("rev_blind"), getObjectContract: async () => { throw new Error("object_inventory refused: tool not granted"); } };
    await expect(compileTool(blind).execute({ project_id: "acme", drafted: [ORGANIZATION], page: PAGE })).rejects.toBeInstanceOf(WorkspaceToolError);
  });

  it("refuses a project that is not active before reading anything", async () => {
    const disabled = createSiteContentTools({ projectRepository: { get: async () => ({ projectId: "acme", status: "disabled" }) } as never, siteContextSource: readOnlySource() })
      .find((entry) => entry.name === "site_content.compile_page_objects")!;
    await expect(disabled.execute({ project_id: "acme", drafted: [ORGANIZATION], page: PAGE })).rejects.toThrow(/disabled/);
  });

  it("refuses a sectionTargets key that is not a section order", async () => {
    await expect(
      compileTool(readOnlySource("rev_bad_key")).execute({ project_id: "acme", drafted: [ORGANIZATION], page: { ...PAGE, sectionTargets: { "not-an-order": "sec_1" } } })
    ).rejects.toThrow(/section order/);
  });
});

describe("site_content.compile_page_objects — section target keys", () => {
  it("refuses a non-canonical numeric key rather than letting two keys collide on one order", async () => {
    const tool = createSiteContentTools({ projectRepository: activeProject, siteContextSource: readOnlySource("rev_pad_key") })
      .find((entry) => entry.name === "site_content.compile_page_objects")!;
    // "04" and "4" are the same number; silently keeping one would drop a target the caller named.
    await expect(tool.execute({ project_id: "acme", drafted: [ORGANIZATION], page: { ...PAGE, sectionTargets: { "04": "sec_1" } } })).rejects.toThrow(/section order/);
  });
});
