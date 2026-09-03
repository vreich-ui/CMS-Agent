import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";

const ENDPOINT = "https://dr-lurie.example/mcp";
const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, max = 30) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max; i++) {
    const state = run.nodes.find((node) => node.nodeId === untilNodeId);
    if (state && state.status !== "queued" && state.status !== "running") return run;
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

// F1 (T-2, run_1785352838155_l544ye): verifies the actual wiring, not just the unit pieces —
// dispatching contract_intelligence through the real DAG (mock execution mode, so no real model call
// is needed) must inject `prefetchedContract` into its input BEFORE the node runs, exactly the way a
// live (openai-mode) run would receive it instead of having to fetch the contract itself.
// A prefetch READ, identified the way the run identifies it: the tool plus the argument that selects
// WHICH object it reads. object_contract is called twice on a publishing run — once for the client's
// content object type, once for the SITE — and those are two different reads, not a repeat.
const readKey = (tool: string | undefined, args: Record<string, unknown> | undefined): string =>
  `${tool ?? "unknown"}${typeof args?.object_type === "string" ? `(${args.object_type})` : ""}`;

describe("contract prefetch wired into node dispatch (F1, end to end through the DAG)", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;
  const remoteCalls: string[] = [];

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    remoteCalls.length = 0;
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (request.method === "tools/call") remoteCalls.push(readKey(request.params?.name, request.params?.arguments));
      // dr-lurie now also carries a voiceObjectId (GUI rework Session B), so nodes upstream of
      // contract_intelligence that declare metadata.voicePrefetch (topic_opportunity, research,
      // brief_architect, draft_writer, trust_factual) fetch object_get("editorial_voice") the same
      // way contract_intelligence fetches object_contract — both go over this same stub.
      const tool = request.params?.name;
      const objectType = request.params?.arguments?.object_type;
      // FINDING-C: contract_intelligence now also runs the SITE prefetch, so this stub answers its
      // five reads too — a realistic site object (its pdf block naming the published default), one
      // published article template, and the image-model policy's own usage-context keys.
      const isVoiceGet = tool === "object_get" && objectType === "editorial_voice";
      const result = request.method !== "tools/call"
        ? {}
        : isVoiceGet
          ? { structuredContent: { object: { name: "Stub voice", audience: "a", tone: ["calm"], cadence: "c", lexicon: { prefer: [], avoid: [] }, claim_policy: "p", cta_policy: "cta", reader_safety_notes: "n", frameworks: [{ framework_id: "fw_x", label: "X", when_to_use: "always" }], default_framework: "fw_x" } } }
          : tool === "object_get" && objectType === "site"
            ? { structuredContent: { object: { body: { pdf: { defaultTemplateId: "article_brochure_v1" }, brandTokens: { colors: { primary: "#2E5C42" } }, logo: "https://cdn.example/mark.svg" } } } }
            : tool === "object_list" && objectType === "visual_standard"
              ? { structuredContent: { items: [] } }
              : tool === "list_pdf_templates"
                ? { structuredContent: { templates: [{ templateId: "article_brochure_v1", kind: "article", label: "Article Brochure" }] } }
                : tool === "get_image_model_policy"
                  ? { structuredContent: { byUsageContext: { article_header: {}, article_body: {} } } }
                  : { structuredContent: { contract: { object_type: objectType, body_schema: { type: "object", required: ["slug"] }, constraints: [{ id: "article_slug", severity: "blocks_write" }] } } };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("injects prefetchedContract into contract_intelligence's own input before it dispatches", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "F1 e2e" }, store);

    const run = await drive(started.runId, store, "contract_intelligence");
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    expect(state.status).toBe("completed");
    const input = state.input as { prefetchedContract?: { clientObjectType: string; idConventions: unknown[] }; prefetchError?: string };
    expect(input.prefetchError).toBeUndefined();
    expect(input.prefetchedContract).toBeDefined();
    expect(input.prefetchedContract!.clientObjectType).toBe("content_item");
    expect(input.prefetchedContract!.idConventions).toEqual([expect.objectContaining({ id: "article_slug" })]);
    // THE F1 COST INVARIANT, re-baselined on purpose by FINDING-C (C3) and stated as the principle
    // rather than as the number it used to be.
    //
    // It read `expect(remoteFetch).toHaveBeenCalledTimes(2)` — one object_contract for the client's
    // content type, one object_get for the editorial voice, both run-scoped so the five
    // voicePrefetch-flagged nodes upstream (topic_opportunity, research, brief_architect,
    // draft_writer, trust_factual) share one fetch. TWO was a consequence of there being two
    // prefetches. The invariant F1 bought was never the number: it was that a prefetch is a
    // DETERMINISTIC CONDUCTOR READ THAT HAPPENS AT MOST ONCE PER RUN, never a tool call re-issued
    // inside a node's own agent loop where the raw payload is re-sent on every turn (~60K input
    // tokens/turn, the $2.57 that started F1).
    //
    // contract_intelligence now also declares the SITE prefetch (nodeGatingSeed.ts's FINDING-C entry),
    // which is what makes C1's visualStandard/pdfTemplates/imagePolicyContexts and C2's
    // usage-context/PDF-template planning rules exist on a publishing run at all instead of being
    // shape with nothing in it. That is five more reads, once, outside every model loop, each reduced
    // to a few hundred bytes before it can enter a prompt. So the count moves 2 -> 7 and the assertion
    // moves with it — but the property is now checked directly: no read is ever issued twice.
    // Order is the run's own: topic_opportunity declares the VOICE prefetch and dispatches before
    // brief_architect, which is the first node to declare the contract prefetch.
    expect(remoteCalls).toEqual([
      "object_get(editorial_voice)",
      "object_contract(content_item)",
      "object_contract(site)",
      "object_get(site)",
      "object_list(visual_standard)",
      "list_pdf_templates",
      "get_image_model_policy"
    ]);
    expect(new Set(remoteCalls).size).toBe(remoteCalls.length);
    expect(remoteFetch).toHaveBeenCalledTimes(remoteCalls.length);
    // The site half really did land on the artifact downstream nodes read, not merely in this node's
    // input: artifact_plan's prompt and artifactMaterialization.ts's readPdfTemplates /
    // readImagePolicyContexts all index contract_intelligence's OUTPUT.
    const output = state.output as { pdfTemplates?: unknown[]; imagePolicyContexts?: unknown[]; visualStandard?: Record<string, unknown> };
    expect(output.imagePolicyContexts).toEqual(["article_header", "article_body"]);
    expect(output.pdfTemplates).toEqual([{ templateId: "article_brochure_v1", kind: "article", label: "Article Brochure", isDefault: true }]);
    expect(output.visualStandard).toMatchObject({ overridePolicy: "allow" });
  });

  // FINDING-C's second half. contract_intelligence's own prompt reads `prefetchedContract` as "the
  // contract was already fetched; this is a validation and pass-through step, not a discovery one".
  // Handing that node a prefetchedContract carrying ONLY the site half — which is what a successful
  // site prefetch beside a FAILED contract prefetch would produce — would turn a client-unreachable
  // run into a confidently empty artifact. So the site half is withheld, and said out loud.
  it("withholds the site half — named, not silently — when the node's contract prefetch failed", async () => {
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "FINDING-C withheld" }, store);

    const run = await drive(started.runId, store, "contract_intelligence");
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    const input = state.input as { prefetchedContract?: unknown; prefetchError?: string };
    expect(input.prefetchError).toBeTruthy();
    // Not "a prefetchedContract with only the site half" — no prefetchedContract at all.
    expect(input.prefetchedContract).toBeUndefined();
    expect(state.warnings).toContain("contract_prefetch_failed:unknown");
    expect(state.warnings).toContain("site_prefetch_withheld:contract_prefetch_failed");
  });

  it("hands the node prefetchError instead of crashing the dispatch when the client is unreachable", async () => {
    delete process.env.DR_LURIE_MCP_ENDPOINT; // simulate an unconfigured/unreachable client connection
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "F1 e2e unreachable" }, store);

    const run = await drive(started.runId, store, "contract_intelligence");
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    // The node dispatch itself still completes (mock mode) — the executor never crashes on a
    // prefetch failure, it just hands the node a prefetchError to react to.
    expect(state.status).toBe("completed");
    const input = state.input as { prefetchedContract?: unknown; prefetchError?: string };
    expect(input.prefetchedContract).toBeUndefined();
    expect(input.prefetchError).toBeTruthy();
    // G2 (T-2 re-run, run_1785405350649_9u5mjz): a prefetch failure used to be visible ONLY inside
    // this one node's own input — a run-level warning is what would have made platform's missing
    // dialect a visible defect instead of a silent cost regression.
    expect(state.warnings).toContain("contract_prefetch_failed:unknown");
  });
});
