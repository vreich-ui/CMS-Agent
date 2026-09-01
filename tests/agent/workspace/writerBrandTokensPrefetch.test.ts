import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";

// FIX-D — BRIEF §3.5 names the writer's executor prefetch as "site `brandTokens` + `logo`, editorial
// voice, house standard when mode:'template'". C1's getSitePrefetch returned only visualStandard /
// pdfTemplates / imagePolicyContexts, so brand_imagery_writer's hardest rule — "never invent a hex
// that is near neither a reference nor a brandToken" — was enforceable against the references half
// alone (C5's finding D). These tests pin the closed half end to end, through the real dispatch.
//
// THE NAME. The carried key is `brandPalette`, not `brandTokens`, and the third test is why: the node
// runners' credential redactor replaces the value of any input key matching /token/i before a model
// sees it, so a field literally named `brandTokens` would arrive as the string "[REDACTED]" — the
// defect T13.3 already recorded once on the clone briefing (capture/provenance.ts). The security
// control is untouched; the carrier's name is chosen not to collide, and a guard test keeps it that
// way rather than trusting a comment.

const ENDPOINT = "https://dr-lurie.example/mcp";
const SITE_BODY = {
  brandTokens: {
    colors: { primary: "#2E5C42", "bg-page": "#FCFBF8" },
    fonts: { sans: "'Inter Variable'" }
  },
  // REVIEW: platform's site body declares `logo` as a STRICT `{ text, imageAssetRef? }`
  // (packages/core/schema/bodies/site-v1.ts). The fixture used to carry `{url, alt}` — a shape the
  // real substrate cannot produce — so it proved the extractor worked on data no site ever sends.
  logo: { text: "Dr Lurie Science", imageAssetRef: "https://cdn.example/dr-lurie/mark.svg" },
  pdf: { defaultTemplateId: "article_brochure_v1" }
};

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

describe("the writer's site prefetch carries the site's brandTokens and logo (FIX-D)", () => {
  let siteBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    siteBody = SITE_BODY;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const tool = request.params?.name;
      const args = request.params?.arguments ?? {};
      const result =
        request.method !== "tools/call"
          ? {}
          : tool === "object_get" && args.object_type === "site"
            ? { structuredContent: { object: { body: siteBody ?? {} } } }
            : tool === "object_list" && args.object_type === "visual_standard"
              ? { structuredContent: { items: [{ object_id: "vis_drlurie", body: { kind: "house", label: "House" } }] } }
              : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("delivers brandPalette (the site's brandTokens) and logo in the writer's own prefetchedContract", async () => {
    const { state } = await startWriterRun("brand tokens reach the writer");

    const input = state.input as { prefetchedContract?: Record<string, unknown> };
    expect(input.prefetchedContract).toBeDefined();
    expect(input.prefetchedContract!.brandPalette).toEqual({
      colors: { primary: "#2E5C42", "bg-page": "#FCFBF8" },
      fonts: { sans: "'Inter Variable'" }
    });
    expect(input.prefetchedContract!.logo).toEqual({ url: "https://cdn.example/dr-lurie/mark.svg", alt: "Dr Lurie Science" });
    // A site that HAS both says nothing on the run: the absence warnings below are for absence only.
    const degraded = (state.warnings ?? []).filter((warning) => warning.startsWith("site_prefetch_degraded:site_"));
    expect(degraded).not.toContain("site_prefetch_degraded:site_brand_tokens_absent");
    expect(degraded).not.toContain("site_prefetch_degraded:site_logo_absent");
  });

  it("treats an absent brandTokens/logo as a named warning, never a failed node", async () => {
    siteBody = { pdf: { defaultTemplateId: "article_brochure_v1" } };
    const { state } = await startWriterRun("brand tokens absent");

    // The dispatch happened, exactly as it does for every other degraded site read: the node was
    // reached and given its input. (REVIEW: a mock traversal of this node used to end `failed` on its
    // own output_schema_violation, because mockValueFromSchema could satisfy neither the hex-pattern
    // palette nor the patternProperties-keyed aspectRatios map — fixed in the generator, and pinned
    // for every registered workflow by workflowRegistry.test.ts. The assertion stays about being
    // dispatched and never blocked, the same shape sitePrefetchWiring.test.ts uses, because that is
    // the property the prefetch owns.)
    expect(state.status).not.toBe("blocked");
    expect(state.input).toBeDefined();
    const warnings = state.warnings ?? [];
    expect(warnings).toContain("site_prefetch_degraded:site_brand_tokens_absent");
    expect(warnings).toContain("site_prefetch_degraded:site_logo_absent");
    // Absent, not defaulted: nothing invents a palette for a site that declares none.
    const input = state.input as { prefetchedContract?: Record<string, unknown> };
    expect(input.prefetchedContract?.brandPalette).toBeUndefined();
    expect(input.prefetchedContract?.logo).toBeUndefined();
    // The rest of the site half still travels — one absent fact never suppresses the others.
    expect(input.prefetchedContract?.visualStandard).toMatchObject({ houseId: "vis_drlurie" });
  });

  it("carries the palette under a key the runners' credential redactor does not eat", async () => {
    // The runners' own pattern, copied verbatim from AnthropicNodeRunner.ts / OpenAINodeRunner.ts. A
    // key matching it has its VALUE replaced with "[REDACTED]" before the model sees the input, so
    // this walk is the guard that FIX-D delivers a palette rather than a redaction marker — the same
    // guard clone.test.mjs added after T13.3 ate theme_reconciler's palette the same way.
    const forbidden = /api[_-]?key|authorization|bearer|jwt|cookie|token|secret|blob.*credential/i;
    const { state } = await startWriterRun("redactor guard");
    const walk = (value: unknown, path: string): string[] => {
      if (Array.isArray(value)) return value.flatMap((entry, index) => walk(entry, `${path}[${index}]`));
      if (!value || typeof value !== "object") return [];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
        forbidden.test(key) ? [`${path}.${key}`] : walk(entry, `${path}.${key}`));
    };
    expect(walk((state.input as { prefetchedContract?: unknown }).prefetchedContract, "prefetchedContract")).toEqual([]);
  });
});
