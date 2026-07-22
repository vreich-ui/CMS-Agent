import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptimizerDeps } from "../../src/agent/improvement/optimizer.js";
import type { EvalResult } from "../../src/agent/improvement/improvementTypes.js";
import { stableHash } from "../../src/agent/improvement/improvementTypes.js";
import type { WorkflowExecutionRecord, NodeExecutionState } from "../../src/agent/workspace/executionTypes.js";
import {
  postRunReflectionEnabled,
  postRunReflectionMode,
  postRunReflectionMaxNodes,
  postRunReflectionMinSamples,
  reflectAfterRun
} from "../../src/agent/improvement/reflection.js";
import { runConductorJob } from "../../src/agent/entrypoints/runConductorJob.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";

// Phase 7 (docs/platform/DIRECTION.md §7): automatic post-run reflection. When a conductor run
// completes and IMPROVEMENT_POST_RUN_REFLECT is on, the executor fires GEPA-style reflection
// (optimizer.propose) for the nodes that executed — PROPOSE-ONLY, evidence-gated, best-effort, and a
// no-op by default. These tests pin the flags, the selection/gating logic, the best-effort contract,
// and an end-to-end proof that a completed conductor run drafts a proposal only when enabled.

const REFLECT_ENV = ["IMPROVEMENT_POST_RUN_REFLECT", "IMPROVEMENT_POST_RUN_REFLECT_MODE", "IMPROVEMENT_POST_RUN_REFLECT_MAX_NODES", "IMPROVEMENT_POST_RUN_REFLECT_MIN_SAMPLES"];
const clearReflectEnv = () => { for (const key of REFLECT_ENV) delete process.env[key]; };

let counter = 0;
const evalResult = (nodeId: string, pass = true): EvalResult => ({
  evalId: `eval_${counter++}`,
  rubricId: "rub_test",
  nodeId,
  subjectHash: "hash",
  subject: { model: "gpt-5.5" },
  scores: [],
  normalizedScore: pass ? 0.9 : 0.4,
  pass,
  judge: { mode: "mock", model: "judge" },
  createdAt: "2026-07-01T00:00:00.000Z"
});

// A synthetic completed-run record; reflectAfterRun only reads run.runId and run.nodes for selection.
const runWith = (states: Array<Pick<NodeExecutionState, "nodeId"> & Partial<NodeExecutionState>>): WorkflowExecutionRecord => ({
  runId: "run_reflect_test",
  workflowId: "publishing_conductor",
  projectId: "dr-lurie",
  status: "completed",
  startedAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  nodes: states.map((state) => ({ status: "completed", produces: [], ...state })),
  artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "mock"
} as unknown as WorkflowExecutionRecord);

// Minimal stub deps; individual tests override only the repository methods a given path touches.
type StubOverrides = {
  listResults?: (args: { nodeId?: string; limit?: number }) => Promise<EvalResult[]>;
  getNode?: (nodeId: string) => Promise<{ prompt: string } | undefined>;
  listProposals?: (args: { nodeId?: string }) => Promise<Array<{ status: string; baselinePromptHash: string }>>;
  saveProposal?: (proposal: unknown) => Promise<unknown>;
};
const throwing = () => { throw new Error("deps must not be touched"); };
const stubDeps = (over: StubOverrides = {}): OptimizerDeps => ({
  workspaceRepository: { getNode: over.getNode ?? (async () => undefined) } as unknown as OptimizerDeps["workspaceRepository"],
  executionRepository: { listRuns: async () => [] } as unknown as OptimizerDeps["executionRepository"],
  improvementRepository: { listProposals: over.listProposals ?? (async () => []), saveProposal: over.saveProposal ?? (async (proposal: unknown) => proposal) } as unknown as OptimizerDeps["improvementRepository"],
  evaluationRepository: { listResults: over.listResults ?? (async () => []) } as unknown as OptimizerDeps["evaluationRepository"]
});

describe("post-run reflection flags", () => {
  afterEach(clearReflectEnv);

  it("is OFF by default and treats only truthy strings as enabled", () => {
    delete process.env.IMPROVEMENT_POST_RUN_REFLECT; expect(postRunReflectionEnabled()).toBe(false);
    for (const on of ["true", "1", "on", "yes", "TRUE"]) { process.env.IMPROVEMENT_POST_RUN_REFLECT = on; expect(postRunReflectionEnabled()).toBe(true); }
    for (const off of ["false", "0", "", "no"]) { process.env.IMPROVEMENT_POST_RUN_REFLECT = off; expect(postRunReflectionEnabled()).toBe(false); }
  });

  it("defaults reflection mode to mock and honors openai", () => {
    delete process.env.IMPROVEMENT_POST_RUN_REFLECT_MODE; expect(postRunReflectionMode()).toBe("mock");
    process.env.IMPROVEMENT_POST_RUN_REFLECT_MODE = "openai"; expect(postRunReflectionMode()).toBe("openai");
    process.env.IMPROVEMENT_POST_RUN_REFLECT_MODE = "MOCK"; expect(postRunReflectionMode()).toBe("mock");
    process.env.IMPROVEMENT_POST_RUN_REFLECT_MODE = "anything"; expect(postRunReflectionMode()).toBe("mock");
  });

  it("bounds proposals per run (default 3, override, invalid falls back)", () => {
    delete process.env.IMPROVEMENT_POST_RUN_REFLECT_MAX_NODES; expect(postRunReflectionMaxNodes()).toBe(3);
    process.env.IMPROVEMENT_POST_RUN_REFLECT_MAX_NODES = "5"; expect(postRunReflectionMaxNodes()).toBe(5);
    for (const bad of ["0", "-2", "abc", ""]) { process.env.IMPROVEMENT_POST_RUN_REFLECT_MAX_NODES = bad; expect(postRunReflectionMaxNodes()).toBe(3); }
  });

  it("sets the minimum eval-evidence samples (default 1, override, invalid falls back)", () => {
    delete process.env.IMPROVEMENT_POST_RUN_REFLECT_MIN_SAMPLES; expect(postRunReflectionMinSamples()).toBe(1);
    process.env.IMPROVEMENT_POST_RUN_REFLECT_MIN_SAMPLES = "4"; expect(postRunReflectionMinSamples()).toBe(4);
    for (const bad of ["0", "abc", ""]) { process.env.IMPROVEMENT_POST_RUN_REFLECT_MIN_SAMPLES = bad; expect(postRunReflectionMinSamples()).toBe(1); }
  });
});

describe("reflectAfterRun (gating, stub deps)", () => {
  afterEach(clearReflectEnv);

  it("is a no-op that never reads repositories when the flag is OFF", async () => {
    delete process.env.IMPROVEMENT_POST_RUN_REFLECT;
    const deps = stubDeps({ listResults: throwing as never, getNode: throwing as never, listProposals: throwing as never });
    const result = await reflectAfterRun(runWith([{ nodeId: "input_triage" }]), deps);
    expect(result.enabled).toBe(false);
    expect(result.candidates).toBe(0);
    expect(result.proposals).toEqual([]);
  });

  it("counts only nodes that executed — excludes queued and late-stage-seeded/skipped nodes", async () => {
    process.env.IMPROVEMENT_POST_RUN_REFLECT = "true";
    const deps = stubDeps({ listResults: async () => [] }); // no evidence, so every candidate is skipped
    const result = await reflectAfterRun(runWith([
      { nodeId: "input_triage", status: "completed" },
      { nodeId: "research", status: "queued" },
      { nodeId: "topic_opportunity", status: "completed", warnings: ["late_stage_entry_skipped"] },
      { nodeId: "brief_architect", status: "completed", warnings: ["late_stage_entry_seeded"] }
    ]), deps);
    expect(result.candidates).toBe(1); // only input_triage genuinely executed
    expect(result.skipped).toEqual([{ nodeId: "input_triage", reason: "no_evidence" }]);
    expect(result.proposals).toEqual([]);
  });

  it("skips a node without enough eval evidence", async () => {
    process.env.IMPROVEMENT_POST_RUN_REFLECT = "true";
    process.env.IMPROVEMENT_POST_RUN_REFLECT_MIN_SAMPLES = "2";
    const deps = stubDeps({ listResults: async () => [evalResult("input_triage")] }); // 1 < min 2
    const result = await reflectAfterRun(runWith([{ nodeId: "input_triage" }]), deps);
    expect(result.skipped).toEqual([{ nodeId: "input_triage", reason: "no_evidence" }]);
    expect(result.proposals).toEqual([]);
  });

  it("skips (dedupes) a node with an already-open proposal for its current prompt", async () => {
    process.env.IMPROVEMENT_POST_RUN_REFLECT = "true";
    let saved = 0;
    const deps = stubDeps({
      listResults: async () => [evalResult("input_triage")],
      getNode: async () => ({ prompt: "CURRENT PROMPT" }),
      listProposals: async () => [{ status: "proposed", baselinePromptHash: stableHash("CURRENT PROMPT") }],
      saveProposal: async (proposal) => { saved += 1; return proposal; }
    });
    const result = await reflectAfterRun(runWith([{ nodeId: "input_triage" }]), deps);
    expect(result.skipped).toEqual([{ nodeId: "input_triage", reason: "duplicate_open_proposal" }]);
    expect(result.proposals).toEqual([]);
    expect(saved).toBe(0); // proposeImprovement never ran
  });

  it("does NOT treat a promoted proposal (or a drifted prompt) as an open duplicate", async () => {
    process.env.IMPROVEMENT_POST_RUN_REFLECT = "true";
    // An open proposal exists but against a DIFFERENT prompt hash, plus a promoted one at the current
    // hash — neither should block a fresh proposal. proposeImprovement then runs against the stub and
    // fails (analyzeNode has no real data), so the node lands in `errors`, proving it was NOT deduped.
    const deps = stubDeps({
      listResults: async () => [evalResult("input_triage")],
      getNode: async () => ({ prompt: "CURRENT PROMPT" }),
      listProposals: async () => [
        { status: "proposed", baselinePromptHash: stableHash("OLD PROMPT") },
        { status: "promoted", baselinePromptHash: stableHash("CURRENT PROMPT") }
      ]
    });
    const result = await reflectAfterRun(runWith([{ nodeId: "input_triage" }]), deps);
    expect(result.skipped).toEqual([]); // not deduped
    // proposeImprovement was attempted; with stub deps it can't complete, so it is isolated as an error.
    expect(result.errors.map((entry) => entry.nodeId)).toEqual(["input_triage"]);
    expect(result.proposals).toEqual([]);
  });

  it("isolates per-node errors and never throws (best-effort)", async () => {
    process.env.IMPROVEMENT_POST_RUN_REFLECT = "true";
    const deps = stubDeps({ listResults: async () => { throw new Error("eval store down"); } });
    const result = await reflectAfterRun(runWith([{ nodeId: "input_triage" }, { nodeId: "research" }]), deps);
    expect(result.errors.map((entry) => entry.nodeId)).toEqual(["input_triage", "research"]);
    expect(result.errors[0]!.message).toContain("eval store down");
    expect(result.proposals).toEqual([]);
  });
});

// NOTE ON ISOLATION: the memory repositories keep state in a process-static store shared by every
// manager instance (resetRepositoryManager rebuilds the manager but not the store — the existing
// improvement-engine tests rely on that accumulation). So these tests never assert on a globally-empty
// store; each uses a DISTINCT canonical node and asserts on that node's proposals, which keeps them
// independent of what other tests have already written.
describe("reflectAfterRun (propose-only, real repositories)", () => {
  beforeEach(() => { clearReflectEnv(); resetRepositoryManager(); process.env.IMPROVEMENT_POST_RUN_REFLECT = "true"; });
  afterEach(() => { clearReflectEnv(); resetRepositoryManager(); });

  const realDeps = (): OptimizerDeps => ({
    workspaceRepository: repositoryManager.getWorkspaceRepository(),
    executionRepository: repositoryManager.getExecutionRepository(),
    improvementRepository: repositoryManager.getImprovementRepository(),
    evaluationRepository: repositoryManager.getEvaluationRepository()
  });
  const seed = async (nodeId: string, n: number) => { const repo = repositoryManager.getEvaluationRepository(); for (let index = 0; index < n; index++) await repo.recordResult(evalResult(nodeId)); };

  it("drafts a propose-only proposal for an evidence-bearing node", async () => {
    await seed("input_triage", 2);
    const result = await reflectAfterRun(runWith([{ nodeId: "input_triage" }]), realDeps());
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.nodeId).toBe("input_triage");
    const proposals = await repositoryManager.getImprovementRepository().listProposals({ nodeId: "input_triage" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("proposed");       // PROPOSE-ONLY — never promoted
    expect(proposals[0]!.change.kind).toBe("prompt");
  });

  it("bounds the number of proposals to maxNodes", async () => {
    // Two fresh nodes both have evidence; with maxNodes=1 only the first is proposed and the cap trips.
    await seed("research", 2);
    await seed("objection_mapping", 2);
    const result = await reflectAfterRun(runWith([{ nodeId: "research" }, { nodeId: "objection_mapping" }]), realDeps(), { maxNodes: 1 });
    expect(result.proposals).toHaveLength(1);
    expect(result.reachedMaxNodes).toBe(true);
  });

  it("dedupes across repeated reflections (no duplicate drafts until the prompt or proposal changes)", async () => {
    await seed("angle_strategy", 2);
    const first = await reflectAfterRun(runWith([{ nodeId: "angle_strategy" }]), realDeps());
    expect(first.proposals).toHaveLength(1);
    const second = await reflectAfterRun(runWith([{ nodeId: "angle_strategy" }]), realDeps());
    expect(second.proposals).toEqual([]);
    expect(second.skipped).toEqual([{ nodeId: "angle_strategy", reason: "duplicate_open_proposal" }]);
    expect(await repositoryManager.getImprovementRepository().listProposals({ nodeId: "angle_strategy" })).toHaveLength(1);
  });
});

describe("conductor fires post-run reflection on completion (integration)", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => { clearReflectEnv(); resetRepositoryManager(); });
  afterEach(() => { process.env = { ...savedEnv }; resetRepositoryManager(); });

  const seed = async (nodeId: string, n: number) => { const repo = repositoryManager.getEvaluationRepository(); for (let index = 0; index < n; index++) await repo.recordResult(evalResult(nodeId)); };
  const run = () => runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "reflect integration", approved: true });

  it("drafts a proposal for an evidence-bearing node when a run completes with the flag on", async () => {
    process.env.IMPROVEMENT_POST_RUN_REFLECT = "true";
    process.env.IMPROVEMENT_POST_RUN_REFLECT_MAX_NODES = "50"; // reflect every evidence-bearing node
    await seed("reader_simulation", 2); // a node no other test touches
    const result = await run();
    expect(result.outcome).toBe("completed");

    const proposals = await repositoryManager.getImprovementRepository().listProposals({ nodeId: "reader_simulation" });
    expect(proposals).toHaveLength(1);       // fired automatically, exactly once, for the evidence node
    expect(proposals[0]!.status).toBe("proposed");
  });

  it("does not reflect when the flag is off (default), even with qualifying evidence", async () => {
    delete process.env.IMPROVEMENT_POST_RUN_REFLECT;
    await seed("emotional_resonance", 2); // fresh node with evidence, but reflection is OFF
    const result = await run();
    expect(result.outcome).toBe("completed");
    expect(await repositoryManager.getImprovementRepository().listProposals({ nodeId: "emotional_resonance" })).toEqual([]);
  });

  it("still completes the run when reflection errors (best-effort, never fails a run)", async () => {
    process.env.IMPROVEMENT_POST_RUN_REFLECT = "true";
    process.env.IMPROVEMENT_POST_RUN_REFLECT_MAX_NODES = "50";
    await seed("trust_factual", 2);
    // Force every reflection write to blow up; the run must still reach completed with all nodes done.
    const improvementRepository = repositoryManager.getImprovementRepository();
    const original = improvementRepository.saveProposal.bind(improvementRepository);
    improvementRepository.saveProposal = async () => { throw new Error("proposal store down"); };
    try {
      const result = await run();
      expect(result.outcome).toBe("completed");
      expect(result.run.nodes.every((node) => node.status === "completed")).toBe(true);
      expect(await improvementRepository.listProposals({ nodeId: "trust_factual" })).toEqual([]); // write failed → nothing persisted
    } finally {
      improvementRepository.saveProposal = original;
    }
  });
});
