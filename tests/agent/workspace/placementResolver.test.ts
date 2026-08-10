import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { computeAggressionTarget } from "../../../src/agent/workspace/aggressionVector.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// §2.16 — placement_resolver end to end through the executor. The aggression TARGET is computed by
// engine code (metadata.placementResolverDeterministic), never by a model: with signals present the
// node completes deterministically at $0; with signals missing a LIVE run blocks (no model fallback —
// a model guessing dial values is the failure mode the mapping exists to prevent) while a mock run
// falls through to the schema-derived placeholder so CI traversal keeps working.

const SIGNALS_INPUT = { artifact: "content_source.v1", summary: "placement fixture", trafficSource: "email", awarenessStage: "product_aware" };

const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, max = 40) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max; i++) {
    const state = run.nodes.find((node) => node.nodeId === untilNodeId);
    if (state && state.status !== "queued" && state.status !== "running") return run;
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

describe("placement_resolver deterministic execution (§2.16)", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("computes the target deterministically from run-input signals: no model, no usage record, exact mapping values", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: SIGNALS_INPUT }, store);
    const run = await drive(started.runId, store, "placement_resolver");

    const state = run.nodes.find((node) => node.nodeId === "placement_resolver")!;
    expect(state.status).toBe("completed");
    const output = state.output as { artifact: string; target: Record<string, number>; trafficSource: string; awarenessStage: string; dryRun?: boolean };
    expect(output.artifact).toBe("placement_resolution.v1");
    // Not a placeholder: the deterministic path emitted the real computed target.
    expect(output.dryRun).toBeUndefined();
    expect(output.trafficSource).toBe("email");
    expect(output.awarenessStage).toBe("product_aware");
    expect(output.target).toEqual(computeAggressionTarget("email", "product_aware").target);
    // $0: deterministic execution writes no usage record (the R-20 rule).
    const usage = await repositoryManager.getUsageRepository().list({ runId: started.runId, nodeId: "placement_resolver" });
    expect(usage).toHaveLength(0);
  });

  it("a mock run WITHOUT signals falls through to the schema placeholder so CI traversal keeps working", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "no signals here" }, store);
    const run = await drive(started.runId, store, "placement_resolver");

    const state = run.nodes.find((node) => node.nodeId === "placement_resolver")!;
    expect(state.status).toBe("completed");
    expect(state.output).toMatchObject({ artifact: "placement_resolution.v1", dryRun: true });
    expect(run.status).not.toBe("blocked");
  });

  it("a LIVE run without signals BLOCKS the node before any dispatch — no model fallback for a computed vector", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "live, but no placement signals" }, store);
    // Park the run directly in front of placement_resolver so no model call is needed to reach it.
    const record = (await store.getRun(started.runId))!;
    const triage = record.nodes.find((node) => node.nodeId === "input_triage")!;
    triage.status = "completed";
    triage.startedAt = record.startedAt;
    triage.completedAt = record.startedAt;
    record.stageOutputs.input_triage = { artifact: "content_source.v1", summary: "no signals" };
    record.currentNodeId = "placement_resolver";
    await store.saveRun(record);

    const result = await runNextNode(started.runId, { executionRepository: store });

    expect(result.status).toBe("blocked");
    const state = result.nodes.find((node) => node.nodeId === "placement_resolver")!;
    expect(state.status).toBe("blocked");
    expect(state.warnings).toContain("aggression_signals_missing");
    expect((state.output as { error: { code: string; message: string } }).error.code).toBe("aggression_signals_missing");
    expect((state.output as { error: { message: string } }).error.message).toContain("trafficSource and awarenessStage");
    // Nothing was emitted for downstream consumption and nothing was charged.
    expect(result.stageOutputs.placement_resolver).toBeUndefined();
    expect(result.artifacts.some((artifact) => artifact.nodeId === "placement_resolver")).toBe(false);
  });

  it("a LIVE run with signals completes deterministically without any provider configured — proof no model was dispatched", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: SIGNALS_INPUT }, store);
      const record = (await store.getRun(started.runId))!;
      const triage = record.nodes.find((node) => node.nodeId === "input_triage")!;
      triage.status = "completed";
      triage.startedAt = record.startedAt;
      triage.completedAt = record.startedAt;
      record.stageOutputs.input_triage = { artifact: "content_source.v1", summary: "signals in initial input" };
      record.currentNodeId = "placement_resolver";
      await store.saveRun(record);

      const result = await runNextNode(started.runId, { executionRepository: store });

      const state = result.nodes.find((node) => node.nodeId === "placement_resolver")!;
      expect(state.status).toBe("completed");
      expect((state.output as { target: unknown }).target).toEqual(computeAggressionTarget("email", "product_aware").target);
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    }
  });
});

// §2.16 — the resolution seam: min(ceiling, target) is computed where BOTH halves first coexist (the
// contract prefetch at contract_intelligence dispatch) and stamped into the node's input, its
// warnings, and the deterministic contract_intelligence artifact downstream nodes consume.
describe("aggression resolution against the prefetched client contract (§2.16)", () => {
  const ENDPOINT = "https://dr-lurie.example/mcp";
  const CEILING = { claim_strength: 0.6, urgency: 0.3, emotional_agitation: 0.9, cta_density: 0.5 };
  let withCeiling: boolean;

  beforeEach(() => {
    repositoryManager.getUsageRepository().clear();
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const isVoiceGet = request.params?.name === "object_get" && request.params?.arguments?.object_type === "editorial_voice";
      const result = request.method !== "tools/call"
        ? {}
        : isVoiceGet
          ? { structuredContent: { object: { name: "Stub voice", audience: "a", tone: ["calm"], cadence: "c", lexicon: { prefer: [], avoid: [] }, claim_policy: "p", cta_policy: "cta", reader_safety_notes: "n", frameworks: [{ framework_id: "fw_x", label: "X", when_to_use: "always" }], default_framework: "fw_x" } } }
          : { structuredContent: { contract: { object_type: request.params?.arguments?.object_type, body_schema: { type: "object", required: ["slug"] }, constraints: [{ id: "article_slug", severity: "blocks_write" }], ...(withCeiling ? { aggression_ceiling: CEILING } : {}) } } };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("stamps the RESOLVED vector (min componentwise) into contract_intelligence's input and artifact when the contract declares a ceiling", async () => {
    withCeiling = true;
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: SIGNALS_INPUT }, store);
    const run = await drive(started.runId, store, "contract_intelligence");

    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;
    expect(state.status).toBe("completed");
    const target = computeAggressionTarget("email", "product_aware").target; // {0.8, 0.7, 0.6, 0.7}
    const expectedResolved = { claim_strength: 0.6, urgency: 0.3, emotional_agitation: 0.6, cta_density: 0.5 };
    expect((state.input as { resolvedAggression?: { resolved: unknown; ceiling: unknown; target: unknown } }).resolvedAggression).toEqual({ resolved: expectedResolved, ceiling: CEILING, target });
    // The artifact downstream nodes consume carries the resolved vector, not the raw target.
    expect(run.stageOutputs.contract_intelligence).toMatchObject({ artifact: "contract_intelligence.v1", resolvedAggression: { resolved: expectedResolved } });
    expect(state.warnings ?? []).not.toContain("aggression_ceiling_missing");
  });

  it("an absent ceiling is a BLOCKER stamped into input, warnings, and the artifact's blockers — never a default", async () => {
    withCeiling = false;
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: SIGNALS_INPUT }, store);
    const run = await drive(started.runId, store, "contract_intelligence");

    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;
    expect(state.status).toBe("completed");
    expect(state.warnings).toContain("aggression_ceiling_missing");
    expect((state.input as { aggressionBlocker?: { code: string } }).aggressionBlocker?.code).toBe("aggression_ceiling_missing");
    const artifact = run.stageOutputs.contract_intelligence as { blockers: string[]; resolvedAggression?: unknown };
    expect(artifact.resolvedAggression).toBeUndefined();
    expect(artifact.blockers.some((blocker) => blocker.startsWith("aggression_ceiling_missing"))).toBe(true);
  });

  it("a mock placeholder placement output never feeds a resolution (dryRun guard)", async () => {
    withCeiling = true;
    const store = new RepositoryManager().getExecutionRepository();
    // No signals: placement_resolver emits the dryRun placeholder, which readPlacementTarget refuses.
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "no signals" }, store);
    const run = await drive(started.runId, store, "contract_intelligence");

    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;
    expect(state.status).toBe("completed");
    expect((state.input as { resolvedAggression?: unknown }).resolvedAggression).toBeUndefined();
    expect((state.input as { aggressionBlocker?: unknown }).aggressionBlocker).toBeUndefined();
    expect(state.warnings ?? []).not.toContain("aggression_ceiling_missing");
  });
});
