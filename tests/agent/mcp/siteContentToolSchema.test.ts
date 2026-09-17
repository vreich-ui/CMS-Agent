import { describe, expect, it, vi } from "vitest";
import { createSiteContentTools, siteContentDraftPageInput } from "../../../src/agent/mcp/workspace/siteContentTools.js";
import { WorkspaceToolError } from "../../../src/agent/mcp/workspace/toolKit.js";

// Schema-only coverage for the `pageRecipe` parameter added to site_content.draft_page — rule 6 of
// the page-recipe layer task. The tool's execution behaviour is covered end to end by
// tests/agent/operations/siteContentDraftingExecutor.test.ts via runSiteContentDrafting; this file
// only guards the wire schema and the tool description's promises.

describe("site_content.draft_page — pageRecipe schema", () => {
  it("accepts an omitted pageRecipe", () => {
    const parsed = siteContentDraftPageInput.parse({ project_id: "acme", brief: { purpose: "test" } });
    expect(parsed.pageRecipe).toBeUndefined();
  });

  it("accepts a non-empty pageRecipe string", () => {
    const parsed = siteContentDraftPageInput.parse({ project_id: "acme", brief: { purpose: "test" }, pageRecipe: "organization_page" });
    expect(parsed.pageRecipe).toBe("organization_page");
  });

  it("rejects an empty-string pageRecipe (the wire schema requires minLength 1; unknown-but-nonempty names are refused downstream by the executor, not here)", () => {
    expect(() => siteContentDraftPageInput.parse({ project_id: "acme", brief: { purpose: "test" }, pageRecipe: "" })).toThrow();
  });

  it("the tool's JSON Schema declares pageRecipe as an optional string, and the tool description still promises no site writes", () => {
    const tools = createSiteContentTools({ projectRepository: { get: async () => null } as any });
    const draftTool = tools.find((tool) => tool.name === "site_content.draft_page");
    expect(draftTool).toBeDefined();
    const props = (draftTool as any).inputSchema.properties;
    expect(props.pageRecipe).toMatchObject({ type: "string", minLength: 1 });
    expect((draftTool as any).inputSchema.required).not.toContain("pageRecipe");
    expect(draftTool!.description).toMatch(/writes nothing to your site/i);
    expect(draftTool!.description).toMatch(/pageRecipe/);
  });
});

describe("site_content.draft_page — pageRecipe reaches the executor", () => {
  const activeProjectRepository = { get: async () => ({ id: "acme", status: "active" }) } as any;

  it("an unknown pageRecipe surfaces as a site_content_draft_failed WorkspaceToolError naming the recipe (end to end through execute(), not just the schema)", async () => {
    const executeNodeImpl = vi.fn(async () => ({ execution: { nodes: [{ nodeId: "site_content_planner", output: { sections: [] } }] } })) as any;
    const tools = createSiteContentTools({ projectRepository: activeProjectRepository, executeNodeImpl });
    const draftTool = tools.find((tool) => tool.name === "site_content.draft_page")!;

    await expect(draftTool.execute({ project_id: "acme", brief: { purpose: "test" }, pageRecipe: "not_a_real_recipe" })).rejects.toMatchObject({
      code: "site_content_draft_failed"
    });
    await expect(draftTool.execute({ project_id: "acme", brief: { purpose: "test" }, pageRecipe: "not_a_real_recipe" })).rejects.toBeInstanceOf(WorkspaceToolError);
  });

  it("a recognized pageRecipe reaches the executor and drives routing (organization_page routes its recipe-supplied section to organization_narrative_writer)", async () => {
    const calls: Array<{ nodeId: string; candidateSkillIds?: string[] }> = [];
    const executeNodeImpl = vi.fn(async (data: any) => {
      calls.push({ nodeId: data.nodeId, candidateSkillIds: data.candidateSkillIds });
      if (data.nodeId === "site_content_planner") {
        return { execution: { nodes: [{ nodeId: "site_content_planner", output: { sections: [{ order: 0, sectionType: "about", purpose: "p", mustEstablish: [] }] } }] } };
      }
      return { execution: { nodes: [{ nodeId: data.nodeId, output: { artifact: "draft" } }] } };
    }) as any;
    const tools = createSiteContentTools({ projectRepository: activeProjectRepository, executeNodeImpl });
    const draftTool = tools.find((tool) => tool.name === "site_content.draft_page")!;

    const result: any = await draftTool.execute({ project_id: "acme", brief: { purpose: "test" }, pageRecipe: "organization_page" });

    expect(result.data.result.outcomes[0].outcome).toBe("drafted");
    expect(result.data.result.outcomes[0].jobSource).toBe("recipe");
    expect(calls.find((call) => call.nodeId === "organization_narrative_writer")).toBeTruthy();
  });
});
