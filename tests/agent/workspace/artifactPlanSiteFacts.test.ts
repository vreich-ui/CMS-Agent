import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { readImagePolicyContexts, readPdfTemplates } from "../../../src/agent/workspace/artifactMaterialization.js";

// FINDING-C, the acceptance: on a PUBLISHING run, artifact_plan really does receive `pdfTemplates` and
// `imagePolicyContexts`, and artifact_materializer's deterministic readers really do find them.
//
// Before this, C1 had put the three fields on ReducedContract and C2 had written artifact_plan's
// prompt rules against them ("choose templateId from pdfTemplates, choose usageContext ONLY from
// imagePolicyContexts") — but nothing declared `sitePrefetch: true` on the node that PRODUCES the
// contract artifact, so on every real run those fields were absent, the prompt rules were unreachable,
// and readPdfTemplates/readImagePolicyContexts returned nothing. The mechanism existed and was tested;
// the declaration did not. This test is about the declaration, end to end through the real DAG.
const ENDPOINT = "https://dr-lurie.example/mcp";

const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, max = 40) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max; i++) {
    const state = run.nodes.find((node) => node.nodeId === untilNodeId);
    if (state && state.status !== "queued" && state.status !== "running") return run;
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

describe("the site facts reach artifact_plan on a publishing run (FINDING-C)", () => {
  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const tool = request.params?.name;
      const objectType = request.params?.arguments?.object_type;
      const result =
        request.method !== "tools/call"
          ? {}
          : tool === "object_get" && objectType === "editorial_voice"
            ? { structuredContent: { object: { name: "Stub voice", audience: "a", tone: ["calm"], cadence: "c", lexicon: { prefer: [], avoid: [] }, claim_policy: "p", cta_policy: "cta", reader_safety_notes: "n", frameworks: [{ framework_id: "fw_x", label: "X", when_to_use: "always" }], default_framework: "fw_x" } } }
            : tool === "object_get" && objectType === "site"
              ? { structuredContent: { object: { body: { pdf: { defaultTemplateId: "article_brochure_v1", byKind: { article: "article_brochure_v1" } } } } } }
              : tool === "object_list" && objectType === "visual_standard"
                ? { structuredContent: { items: [{ object_id: "vis_drlurie", body: { kind: "house", label: "House" } }, { object_id: "vis_drlurie_field_notes", body: { kind: "template", label: "Field notes", whenToUse: "Reader case write-ups." } }] } }
                : tool === "list_pdf_templates"
                  ? { structuredContent: { templates: [{ templateId: "article_brochure_v1", kind: "article", label: "Article Brochure", renderDataSchema: { type: "object", required: ["title"] } }] } }
                  : tool === "get_image_model_policy"
                    ? { structuredContent: { byUsageContext: { article_header: {}, article_body: {}, pdf_cover: {} } } }
                    : tool === "object_contract" && objectType === "site"
                      ? { structuredContent: { contract: { object_type: "site", constraints: [{ id: "brand_imagery_override_policy", value: "lock" }] } } }
                      : { structuredContent: { contract: { object_type: objectType, body_schema: { type: "object", required: ["slug"] }, constraints: [{ id: "article_slug", severity: "blocks_write" }] } } };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("delivers pdfTemplates, imagePolicyContexts and visualStandard to artifact_plan through contract_intelligence's artifact", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "FINDING-C e2e" }, store);
    const run = await drive(started.runId, store, "artifact_plan");
    const state = run.nodes.find((node) => node.nodeId === "artifact_plan")!;

    expect(state.status).not.toBe("queued");
    const dependencies = (state.input as { dependencies?: Record<string, unknown> }).dependencies ?? {};
    const intelligence = dependencies.contract_intelligence as { pdfTemplates?: unknown; imagePolicyContexts?: unknown; visualStandard?: unknown };
    expect(intelligence).toBeDefined();
    // C2's PDF rule: "choose templateId from pdfTemplates, the entry with isDefault true first".
    // isDefault is cross-referenced against the SITE's own pdf block, never assumed for a lone result.
    expect(intelligence.pdfTemplates).toEqual([
      { templateId: "article_brochure_v1", kind: "article", label: "Article Brochure", renderDataSchema: { type: "object", required: ["title"] }, isDefault: true }
    ]);
    // C2's image rule: "choose requirements.image.usageContext ONLY from imagePolicyContexts".
    expect(intelligence.imagePolicyContexts).toEqual(["article_header", "article_body", "pdf_cover"]);
    // C2's style rule needs the guardrail: a site whose owner locked overrides has `style` ignored
    // and reported, never refused — the planner can only say so if it can see it.
    expect(intelligence.visualStandard).toEqual({
      houseId: "vis_drlurie",
      templates: [{ id: "vis_drlurie_field_notes", label: "Field notes", whenToUse: "Reader case write-ups." }],
      overridePolicy: "lock"
    });
  });

  it("makes artifact_materializer's deterministic readers non-empty on the same run", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "FINDING-C readers" }, store);
    const run = await drive(started.runId, store, "artifact_plan");

    // These two read run.stageOutputs.contract_intelligence directly (artifactMaterialization.ts), so
    // they are the exact surface C2's deterministic renderData mapping and usage-context coercion use.
    // Both returned nothing on every real run until contract_intelligence declared the site prefetch.
    expect(readImagePolicyContexts(run)).toEqual(["article_header", "article_body", "pdf_cover"]);
    expect(readPdfTemplates(run)).toEqual([
      { templateId: "article_brochure_v1", kind: "article", label: "Article Brochure", renderDataSchema: { type: "object", required: ["title"] }, isDefault: true }
    ]);
  });
});
