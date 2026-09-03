import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeterministicContractIntelligence } from "../../../src/agent/workspace/deterministicContractIntelligence.js";
import type { ReducedContract } from "../../../src/agent/workspace/contractReduction.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// Session D (2026-08 improvement phase): contract_intelligence is 52% of historical spend, and the
// #93/#95 prefetch already dropped it to ~$0.134/run by removing the raw contract re-send. What's left
// is a model call whose whole job is field mapping the deterministic prefetch already did. This
// suite proves: (1) the mapper alone produces schema-valid, content-faithful output; (2) wired into a
// real run, it replaces the model call entirely — proven by zero usage records and by succeeding in
// "openai" mode with no model-provider network stub configured at all; (3) the safety net (a prefetch
// failure) still falls through to the normal model path unchanged.

const sampleReduced = (overrides: Partial<ReducedContract> = {}): ReducedContract => ({
  clientObjectType: "content_item",
  bodySchema: { type: "object", required: ["slug", "title", "nodes"], additionalProperties: false },
  idConventions: [{ id: "article_slug", severity: "blocks_write", note: "lowercase-hyphen slug" }],
  mediaConvention: { policy: { max_image_bytes: 153600, preferred_image_format: "webp", over_budget: "warn" }, notes: [{ input: "image artifacts", how: "materialize via pdf-tool" }] },
  taxonomy: { notes: [{ input: "taxonomy terms", how: "resolve via tax_platform registry" }], blockingConstraints: [{ id: "article_taxonomy", note: "unknown terms block" }] },
  constraints: [
    { id: "schema_zod", severity: "blocks_write", enforcedLive: true, note: "body must parse against the zod schema" },
    { id: "article_slug", severity: "blocks_write", enforcedLive: true, note: "slug pattern" }
  ],
  publishPolicy: { gated: true, requires_approval: false, note: "autonomous publish permitted" },
  workflowSequence: ["object_validate", "object_patch", "object_publish"],
  validationSurface: [{ op: "object_patch", requiredFields: ["lock_token"], note: "checkout required first" }],
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-04T09:00:00.000Z", fingerprint: "fp_sample" },
  ...overrides
});

describe("buildDeterministicContractIntelligence (unit)", () => {
  it("produces output that validates against the real node's own outputSchema", () => {
    const node = getWorkspaceNode("contract_intelligence")!;
    const output = buildDeterministicContractIntelligence(sampleReduced(), "platform");
    const result = validateOutput(output, node.outputSchema);
    expect(result.ok, JSON.stringify(result.ok ? [] : result.errors)).toBe(true);
  });

  it("carries constraints, publishPolicy and bodySchema through verbatim — no rewriting", () => {
    const reduced = sampleReduced();
    const output = buildDeterministicContractIntelligence(reduced, "platform");
    expect(output.constraints).toEqual(reduced.constraints);
    expect(output.publishPolicy).toEqual(reduced.publishPolicy);
    expect(output.bodySchema).toEqual(reduced.bodySchema);
    expect(output.contractSource).toEqual(reduced.contractSource);
  });

  it("does not invent an idConventions object/nodes split — carries the flat reduced list as-is", () => {
    const output = buildDeterministicContractIntelligence(sampleReduced(), "platform");
    expect(output.idConventions.conventions).toEqual([{ id: "article_slug", severity: "blocks_write", note: "lowercase-hyphen slug" }]);
  });

  it("does not emit a separate mediaPolicy duplicate of mediaConvention.policy (the fidelity risk the rubric review flagged)", () => {
    const output = buildDeterministicContractIntelligence(sampleReduced(), "platform") as Record<string, unknown>;
    expect(output).not.toHaveProperty("mediaPolicy");
    expect(output.mediaConvention).toEqual(sampleReduced().mediaConvention);
  });

  it("derives taxonomy.unknownTermsBlock from blockingConstraints without inventing an unstated source field", () => {
    const blocking = buildDeterministicContractIntelligence(sampleReduced(), "platform");
    expect(blocking.taxonomy.unknownTermsBlock).toBe(true);

    const nonBlocking = buildDeterministicContractIntelligence(sampleReduced({ taxonomy: { notes: [], blockingConstraints: [] } }), "platform");
    expect(nonBlocking.taxonomy.unknownTermsBlock).toBe(false);
    expect(nonBlocking).not.toHaveProperty("taxonomy.source");
  });

  it("surfaces unmapped contract content as explicit notes rather than dropping it", () => {
    const output = buildDeterministicContractIntelligence(sampleReduced({ unmapped: { legacy_flag: true } }), "platform");
    expect(output.notes.some((note) => note.includes("Unmapped contract data preserved for downstream attention: legacy_flag"))).toBe(true);
  });

  it("never fabricates a blocker — this path only runs when the prefetch already succeeded", () => {
    expect(buildDeterministicContractIntelligence(sampleReduced(), "platform").blockers).toEqual([]);
  });

  // The live outputSchema (the workspace-store overlay, not the canonical definition this file
  // validates against) requires `ceiling` on any output with an empty `blockers` array. Emitting no
  // ceiling is what made this mapper fail that check on every live dispatch and fall through to the
  // model — which then omitted the field on 5 of 7 attempts. These cover the carry, its bounds, and
  // the deliberate non-decision when the contract has no complete ceiling.
  const CEILING = { claim_strength: 0.45, urgency: 0.1, emotional_agitation: 0.15, cta_density: 0.2 };

  it("carries a complete aggression ceiling through verbatim rather than leaving it to the model", () => {
    const output = buildDeterministicContractIntelligence(sampleReduced({ aggressionCeiling: CEILING }), "platform");
    expect(output.ceiling).toEqual(CEILING);
    expect(output.blockers).toEqual([]);
  });

  it("omits ceiling — and still fabricates no blocker — when the contract has none, so the artifact falls through to the model", () => {
    const output = buildDeterministicContractIntelligence(sampleReduced(), "platform");
    expect(output).not.toHaveProperty("ceiling");
    expect(output.blockers).toEqual([]);
  });

  it("treats a PARTIAL or out-of-range ceiling as no ceiling — a ceiling is all four dials in 0..1 or nothing", () => {
    const partial = buildDeterministicContractIntelligence(
      sampleReduced({ aggressionCeiling: { claim_strength: 0.45, urgency: 0.1, emotional_agitation: 0.15 } }),
      "platform"
    );
    expect(partial).not.toHaveProperty("ceiling");

    for (const bad of [{ ...CEILING, urgency: 1.4 }, { ...CEILING, cta_density: -0.1 }, { ...CEILING, claim_strength: "0.45" }]) {
      expect(buildDeterministicContractIntelligence(sampleReduced({ aggressionCeiling: bad }), "platform")).not.toHaveProperty("ceiling");
    }
  });

  // C1 (BRIEF §3.7): visualStandard/pdfTemplates/imagePolicyContexts are carried through unchanged —
  // this mapper computes nothing further, exactly like constraints/publishPolicy/bodySchema above.
  const SITE_FIELDS: Pick<ReducedContract, "visualStandard" | "pdfTemplates" | "imagePolicyContexts"> = {
    visualStandard: {
      houseId: "vis_drlurie",
      houseStatus: "present",
      derivedHouseId: "vis_drlurie",
      templates: [{ id: "vis_drlurie_ad", label: "Ad campaign", whenToUse: "Paid ad creative only." }],
      overridePolicy: "lock"
    },
    pdfTemplates: [{ templateId: "tmpl_article", kind: "article", label: "Article Brochure", renderDataSchema: { type: "object" }, isDefault: true }],
    imagePolicyContexts: ["article_body", "hero_image"]
  };

  it("carries visualStandard, pdfTemplates and imagePolicyContexts through unchanged when the reduction has them", () => {
    const output = buildDeterministicContractIntelligence(sampleReduced(SITE_FIELDS), "platform");
    expect(output.visualStandard).toEqual(SITE_FIELDS.visualStandard);
    expect(output.pdfTemplates).toEqual(SITE_FIELDS.pdfTemplates);
    expect(output.imagePolicyContexts).toEqual(SITE_FIELDS.imagePolicyContexts);

    const node = getWorkspaceNode("contract_intelligence")!;
    const result = validateOutput(output, node.outputSchema);
    expect(result.ok, JSON.stringify(result.ok ? [] : result.errors)).toBe(true);
  });

  it("omits visualStandard, pdfTemplates and imagePolicyContexts when sitePrefetch never ran for this project/run — no invented defaulting", () => {
    const output = buildDeterministicContractIntelligence(sampleReduced(), "platform") as Record<string, unknown>;
    expect(output).not.toHaveProperty("visualStandard");
    expect(output).not.toHaveProperty("pdfTemplates");
    expect(output).not.toHaveProperty("imagePolicyContexts");
  });
});

describe("wired into a real run: replaces the model call entirely (Session D end to end)", () => {
  const ENDPOINT = "https://platform.example/mcp";
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.PLATFORM_MCP_ENDPOINT = ENDPOINT;
    process.env.PLATFORM_MCP_TOKEN = "secret-token";
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { arguments?: Record<string, unknown> } };
      const result = request.method === "tools/call"
        ? { structuredContent: { contract: { object_type: request.params?.arguments?.object_type, body_schema: { type: "object", required: ["slug"] }, constraints: [{ id: "article_slug", severity: "blocks_write" }] } } }
        : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLATFORM_MCP_ENDPOINT;
    delete process.env.PLATFORM_MCP_TOKEN;
  });

  const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, max = 30) => {
    let run = await getRun(runId, store);
    for (let i = 0; run && i < max; i++) {
      const state = run.nodes.find((node) => node.nodeId === untilNodeId);
      if (state && state.status !== "queued" && state.status !== "running") return run;
      run = await runNextNode(runId, { executionRepository: store });
    }
    return run!;
  };

  // "openai" mode with no OpenAI network stub configured anywhere: if the deterministic bypass did
  // NOT fire, the model runner would attempt a real provider call and this test would hang or throw a
  // network/auth error. Succeeding here IS the proof the model call never happened. Entered late-stage
  // at brief_architect (contract_intelligence's own dependency) so only contract_intelligence itself
  // is actually dispatched — no need to fake seven upstream nodes' worth of real model calls too.
  it("completes contract_intelligence in openai mode with zero model calls and zero usage records", async () => {
    repositoryManager.getUsageRepository().clear();
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({
      executionMode: "openai",
      projectId: "platform",
      input: "Session D e2e",
      budgetUsd: 100,
      entrypoint: { nodeId: "review_aggregator", output: { artifact: "review_aggregation.v1", summary: "Test review aggregation for Session D." } }
    }, store);

    const run = await drive(started.runId, store, "contract_intelligence");
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    expect(state.status).toBe("completed");
    const output = state.output as { artifact: string; summary: string; constraints: unknown[] };
    expect(output.artifact).toBe("contract_intelligence.v1");
    expect(output.summary).toMatch(/deterministic pass-through, no model call/);
    expect(output.constraints).toEqual([{ id: "article_slug", severity: "blocks_write", enforcedLive: undefined, note: undefined }].map((c) => expect.objectContaining({ id: c.id, severity: c.severity })));

    // Every network call made anywhere was a DETERMINISTIC PREFETCH READ, issued once by the
    // conductor — not one-per-turn the way the pre-#93 self-fetch behaved, which is the property this
    // assertion has always been about. FINDING-C (C3) moved the count 1 -> 6: contract_intelligence
    // now declares the SITE prefetch as well (nodeGatingSeed.ts), whose five reads are what make C1's
    // visualStandard/pdfTemplates/imagePolicyContexts and C2's planning rules exist on a real run.
    // Six reads, once each, outside every model loop; the model-call count this test exists to pin is
    // still zero, which is what the empty usage list below proves.
    expect(remoteFetch).toHaveBeenCalledTimes(6);

    // No model call means no usage record for this node at all — not even a $0 one.
    const usage = await repositoryManager.getUsageRepository().list({ runId: started.runId, nodeId: "contract_intelligence" });
    expect(usage).toEqual([]);
  });

  it("falls back to the normal model path when the prefetch fails (safety net, mock mode so the fallback is cheap to observe)", async () => {
    delete process.env.PLATFORM_MCP_ENDPOINT; // simulate an unreachable/unconfigured client
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "Session D fallback" }, store);

    const run = await drive(started.runId, store, "contract_intelligence");
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    // Falls through to the mock runner exactly as before this change — still completes, still reports
    // the prefetch failure, never silently produces a deterministic output from missing data.
    expect(state.status).toBe("completed");
    expect(state.warnings).toContain("contract_prefetch_failed:unknown");
    const output = state.output as { summary?: string };
    expect(output.summary).not.toMatch(/deterministic pass-through/);
  });
});
