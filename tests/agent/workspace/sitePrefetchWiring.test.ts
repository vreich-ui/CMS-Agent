import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { declaresSitePrefetch, gatedMetadata } from "../../../src/agent/workspace/nodeGatingSeed.js";
import { visualIdentityNodes } from "../../../src/agent/workspace/visualIdentityNodes.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";

// C5 — the executor half of the site prefetch, which C1 wrote sitePrefetch.ts for and explicitly left
// undone. Without it `visualStandard` / `pdfTemplates` / `imagePolicyContexts` have a shape in
// ReducedContract and nothing ever fills them, so brand_imagery_writer cannot see the site it is
// writing a look for. The assertions here are about the WIRING, not about the reads themselves
// (sitePrefetch.test.ts / contractPrefetch.test.ts already cover those): does a node that declares
// `sitePrefetch` get the site's facts merged into its `prefetchedContract` before it dispatches, and
// does a degraded prefetch stay a named run-visible warning rather than a failure.

const ENDPOINT = "https://dr-lurie.example/mcp";

const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, max = 10) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max; i++) {
    const state = run.nodes.find((node) => node.nodeId === untilNodeId);
    if (state && state.status !== "queued" && state.status !== "running") return run;
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

const startWriterRun = async (note: string) => {
  const store = new RepositoryManager().getExecutionRepository();
  const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", workflowId: "visual_identity", input: { mode: "house", brief: note } }, store);
  const run = await drive(started.runId, store, "brand_imagery_writer");
  return { run, state: run.nodes.find((node) => node.nodeId === "brand_imagery_writer")! };
};

describe("site prefetch wired into node dispatch", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const tool = request.params?.name;
      const args = request.params?.arguments ?? {};
      const result =
        request.method !== "tools/call"
          ? {}
          : tool === "object_contract" && args.object_type === "site"
            ? { structuredContent: { contract: { object_type: "site", constraints: [{ id: "brand_imagery_override_policy", value: "lock" }] } } }
            : tool === "object_get" && args.object_type === "site"
              // FIX-D: brandTokens/logo travel off this same read — a site that declares neither is
              // the degraded case (writerBrandTokensPrefetch.test.ts), not this happy path.
              ? { structuredContent: { object: { body: { pdf: { defaultTemplateId: "article_brochure_v1" }, brandTokens: { colors: { primary: "#2E5C42" } }, logo: "https://cdn.example/mark.svg" } } } }
              : tool === "object_list" && args.object_type === "visual_standard"
                ? { structuredContent: { items: [{ object_id: "vis_drlurie", body: { kind: "house", label: "House" } }, { object_id: "vis_drlurie_field_notes", body: { kind: "template", label: "Field notes", whenToUse: "Reader case write-ups." } }] } }
                : tool === "list_pdf_templates"
                  ? { structuredContent: { templates: [{ templateId: "article_brochure_v1", kind: "article", label: "Article Brochure" }] } }
                  : tool === "get_image_model_policy"
                    ? { structuredContent: { byUsageContext: { article_header: {}, article_body: {}, pdf_cover: {} } } }
                    : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("declares the prefetch on the node that needs it, and on nothing else by accident", () => {
    const writer = visualIdentityNodes.find((node) => node.id === "brand_imagery_writer")!;
    expect(declaresSitePrefetch(writer)).toBe(true);
    expect(declaresSitePrefetch({ id: "draft_writer", metadata: {} })).toBe(false);
    // The seed is a FLOOR, not an override: a node's own metadata always wins, including when it
    // switches the prefetch off explicitly.
    expect(gatedMetadata({ id: "brief_architect", metadata: { voicePrefetch: false } })?.voicePrefetch).toBe(false);
  });

  it("merges the site's visual standards, PDF templates and image-policy contexts into prefetchedContract before the writer dispatches", async () => {
    const { state } = await startWriterRun("site prefetch e2e");

    const input = state.input as { prefetchedContract?: Record<string, unknown> };
    expect(input.prefetchedContract).toBeDefined();
    expect(input.prefetchedContract!.visualStandard).toEqual({
      houseId: "vis_drlurie",
      templates: [{ id: "vis_drlurie_field_notes", label: "Field notes", whenToUse: "Reader case write-ups." }],
      // P4's guardrail read path (§3.7) travels with them — the writer must know when the owner has
      // locked overrides, and the default is never invented locally.
      overridePolicy: "lock"
    });
    expect(input.prefetchedContract!.pdfTemplates).toEqual([{ templateId: "article_brochure_v1", kind: "article", label: "Article Brochure", isDefault: true }]);
    expect(input.prefetchedContract!.imagePolicyContexts).toEqual(["article_header", "article_body", "pdf_cover"]);
    // A clean prefetch says nothing on the run — warnings are for degradation only.
    expect((state.warnings ?? []).filter((warning) => warning.startsWith("site_prefetch_degraded:"))).toEqual([]);
  });

  it("degrades to named, run-visible warnings — never a failed node — when the client is unreachable", async () => {
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    const { state } = await startWriterRun("site prefetch degraded");

    // The dispatch still happened: a site-prefetch failure can never block a node, exactly like a
    // voice-prefetch failure and unlike a contract-prefetch failure.
    expect(state.status).not.toBe("blocked");
    const degraded = (state.warnings ?? []).filter((warning) => warning.startsWith("site_prefetch_degraded:"));
    expect(degraded).toContain("site_prefetch_degraded:override_policy_unreachable");
    expect(degraded).toContain("site_prefetch_degraded:pdf_templates_unreachable");
    // `overridePolicy` always resolves — 'allow' is the stated default for every degradation — so a
    // downstream node is never left to invent one.
    const input = state.input as { prefetchedContract?: { visualStandard?: { overridePolicy?: string } } };
    expect(input.prefetchedContract?.visualStandard?.overridePolicy).toBe("allow");
  });
});
