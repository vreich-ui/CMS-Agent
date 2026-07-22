import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvaluationRepository } from "../../src/agent/repository/interfaces/EvaluationRepository.js";
import type { EvalResult } from "../../src/agent/improvement/improvementTypes.js";
import type { WorkspaceNode } from "../../src/agent/workspace/nodeTypes.js";
import { enforceModelLadder, modelLadderEnforcementEnabled } from "../../src/agent/improvement/modelLadder.js";
import { getRun, runNextNode, startDryRun } from "../../src/agent/workspace/executor.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";

// Phase 7 (docs/platform/DIRECTION.md §7): model-ladder ENFORCEMENT. recommendModel() is advisory;
// enforcement applies the cheapest eval-qualified model at conductor dispatch, gated by
// IMPROVEMENT_MODEL_LADDER_ENFORCE (default OFF) and as a per-run override (never a mutation).

let counter = 0;
const evalResult = (nodeId: string, model: string, pass: boolean): EvalResult => ({
  evalId: `eval_${counter++}`,
  rubricId: "rub_test",
  nodeId,
  subjectHash: "hash",
  subject: { model },
  scores: [],
  normalizedScore: pass ? 0.9 : 0.4,
  pass,
  judge: { mode: "mock", model: "judge" },
  createdAt: "2026-07-01T00:00:00.000Z"
});
const repeat = (n: number, make: () => EvalResult): EvalResult[] => Array.from({ length: n }, make);
const stubRepo = (results: EvalResult[]): EvaluationRepository => ({ listResults: async () => results } as unknown as EvaluationRepository);
const node = (model?: string): WorkspaceNode => ({ id: "n", modelConfig: model ? { model } : undefined } as unknown as WorkspaceNode);

const LADDER_ENV = ["IMPROVEMENT_MODEL_LADDER_ENFORCE", "IMPROVEMENT_MODEL_LADDER_THRESHOLD", "IMPROVEMENT_MODEL_LADDER_MIN_SAMPLES"];
const clearLadderEnv = () => { for (const key of LADDER_ENV) delete process.env[key]; };

describe("modelLadderEnforcementEnabled", () => {
  afterEach(clearLadderEnv);
  it("defaults OFF and treats only truthy strings as enabled", () => {
    delete process.env.IMPROVEMENT_MODEL_LADDER_ENFORCE; expect(modelLadderEnforcementEnabled()).toBe(false);
    for (const on of ["true", "1", "on", "yes", "TRUE"]) { process.env.IMPROVEMENT_MODEL_LADDER_ENFORCE = on; expect(modelLadderEnforcementEnabled()).toBe(true); }
    for (const off of ["false", "0", "", "no"]) { process.env.IMPROVEMENT_MODEL_LADDER_ENFORCE = off; expect(modelLadderEnforcementEnabled()).toBe(false); }
  });
});

describe("enforceModelLadder", () => {
  afterEach(clearLadderEnv);

  it("downshifts to the cheapest model that CLEARS the threshold, skipping a cheaper failing model", async () => {
    // qwen3-8b is cheapest (0.4) but fails the threshold; gemini-3.1-flash-lite (1.75) passes and is
    // cheaper than the node's gpt-5.5 (20) — so gemini is enforced, not qwen and not gpt-5.5.
    const results = [
      ...repeat(5, () => evalResult("n", "gpt-5.5", true)),
      ...repeat(4, () => evalResult("n", "gemini-3.1-flash-lite", true)),
      ...repeat(1, () => evalResult("n", "qwen3-8b", true)), ...repeat(3, () => evalResult("n", "qwen3-8b", false))
    ];
    const { modelConfig, enforcement } = await enforceModelLadder(node("gpt-5.5"), stubRepo(results));
    expect(enforcement.applied).toBe(true);
    expect(enforcement.fromModel).toBe("gpt-5.5");
    expect(enforcement.toModel).toBe("gemini-3.1-flash-lite");
    expect(modelConfig?.model).toBe("gemini-3.1-flash-lite");
  });

  it("does not override when the node is already on the recommended model", async () => {
    const results = repeat(4, () => evalResult("n", "gemini-3.1-flash-lite", true));
    const { modelConfig, enforcement } = await enforceModelLadder(node("gemini-3.1-flash-lite"), stubRepo(results));
    expect(enforcement.applied).toBe(false);
    expect(enforcement.reason).toBe("already_on_recommended_model");
    expect(modelConfig).toEqual({ model: "gemini-3.1-flash-lite" });
  });

  it("does not override when no model has enough samples", async () => {
    const results = repeat(2, () => evalResult("n", "gemini-3.1-flash-lite", true)); // < default minSamples (3)
    const { modelConfig, enforcement } = await enforceModelLadder(node("gpt-5.5"), stubRepo(results));
    expect(enforcement.applied).toBe(false);
    expect(modelConfig).toEqual({ model: "gpt-5.5" });
  });

  it("honors IMPROVEMENT_MODEL_LADDER_THRESHOLD (a borderline model qualifies only under a lower bar)", async () => {
    const results = [...repeat(2, () => evalResult("n", "gemini-3.1-flash-lite", true)), ...repeat(1, () => evalResult("n", "gemini-3.1-flash-lite", false))]; // 0.667 pass-rate, 3 samples
    expect((await enforceModelLadder(node("gpt-5.5"), stubRepo(results))).enforcement.applied).toBe(false); // default 0.7 bar
    process.env.IMPROVEMENT_MODEL_LADDER_THRESHOLD = "0.6";
    expect((await enforceModelLadder(node("gpt-5.5"), stubRepo(results))).enforcement.applied).toBe(true);
  });
});

describe("conductor honors model-ladder enforcement at dispatch (integration)", () => {
  beforeEach(() => { clearLadderEnv(); resetRepositoryManager(); });
  afterEach(() => { clearLadderEnv(); resetRepositoryManager(); });

  const seedTriageEvals = async () => {
    const evalRepo = repositoryManager.getEvaluationRepository();
    for (const result of repeat(4, () => evalResult("input_triage", "gemini-3.1-flash-lite", true))) await evalRepo.recordResult(result);
  };
  const runFirstNode = async () => {
    const store = repositoryManager.getExecutionRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "x" }, store);
    await runNextNode(run.runId, { executionRepository: store });
    return (await getRun(run.runId, store))!.nodes.find((n) => n.nodeId === "input_triage")!;
  };

  it("tags the dispatched node when the flag is on and a cheaper model qualifies", async () => {
    process.env.IMPROVEMENT_MODEL_LADDER_ENFORCE = "true";
    await seedTriageEvals();
    const triage = await runFirstNode();
    expect(triage.status).toBe("completed");
    expect(triage.warnings ?? []).toContain("model_ladder_enforced:default->gemini-3.1-flash-lite");
  });

  it("does not tag the node when enforcement is off (default), even with qualifying evals", async () => {
    delete process.env.IMPROVEMENT_MODEL_LADDER_ENFORCE;
    await seedTriageEvals();
    const triage = await runFirstNode();
    expect(triage.status).toBe("completed");
    expect((triage.warnings ?? []).some((w) => w.startsWith("model_ladder_enforced"))).toBe(false);
  });
});
