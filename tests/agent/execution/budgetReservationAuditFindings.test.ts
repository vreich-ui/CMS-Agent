import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { recordModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// P3-cost §2.22 — VERIFICATION, not new behavior: the handoff's audit (2026-08-10) named two live
// failure modes and asked this work package to confirm the run-level reservation (executor.ts
// advanceRun, "reservationExceeded") and the runner-level pre-flight reserve (OpenAINodeRunner.ts)
// actually cover them, strengthening only if a gap is found. Both mechanisms were already present in
// this tree (comments cite run_1785435947311_jl8hl4 as the hardening commit, which reads as landing
// AFTER the audit) and tests/agent/workspace/budgetGate.test.ts + openaiNodeRunnerProspectiveBudget.
// test.ts already cover the general case. This file pins the exact two scenarios the audit quoted, by
// name, so the audit's own numbers are the regression guard — no source change accompanies it.

describe("§2.22 audit scenario (a): a run must stop BEFORE overshoot, not discover it afterwards", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  // Audit quote: "blocked at $5 ceiling with $5.26 already spent and contract_intelligence never run".
  // That $5.26 figure is itself the bug being checked for: it is OVER the $5 ceiling, proof the old
  // gate discovered the overshoot only after it happened. The fix under test is the reservation added
  // to advanceRun (executor.ts ~line 628): before dispatching the next node, halt when accrued spend
  // PLUS that node's own declared budgetUsd would cross the ceiling — so accrued spend at the moment
  // of the block must never exceed the ceiling, and the node that would have overshot it (here,
  // contract_intelligence) must never have dispatched at all.
  it("blocks before contract_intelligence dispatches, with accrued spend at block time under the $5 ceiling", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({
      executionMode: "mock",
      projectId: "dr-lurie",
      input: "Session §2.22 audit replay",
      budgetUsd: 5,
      // Late-stage entrypoint: review_aggregator and its ancestors (including contract_intelligence's
      // own dependency, brief_architect) are seeded completed, so contract_intelligence is the very
      // next runnable node — exactly the node the audit's run stalled in front of.
      entrypoint: { nodeId: "review_aggregator", output: { artifact: "review_aggregation.v1", summary: "Test review aggregation for §2.22 audit replay." } }
    }, store);

    // Simulate a run that has already spent $4.80 of real (actual) model cost on earlier nodes —
    // under the $5 ceiling on its own, but contract_intelligence's own budgetUsd reservation (0.35)
    // would push it to $5.15, past the ceiling.
    const contractIntelligenceBudget = getWorkspaceNode("contract_intelligence")!.modelConfig!.budgetUsd as number;
    expect(contractIntelligenceBudget).toBeGreaterThan(0);
    await recordModelUsage({ runId: started.runId, nodeId: "brief_architect", model: "gpt-5.5", provider: "openai", inputTokens: 0, outputTokens: 0, costUsdEstimate: 4.8, status: "actual" });

    const run = await runNextNode(started.runId, { executionRepository: store });

    expect(run.status).toBe("blocked");
    expect(run.budgetBlock).toBeDefined();
    expect(run.budgetBlock!.nextNodeId).toBe("contract_intelligence");
    // The number the audit called out (5.26) must never be reached — the block fires at accrued spend
    // ($4.80), strictly under the $5 ceiling, never at or above it.
    expect(run.budgetBlock!.spentUsdEstimate).toBeLessThan(5);
    expect(run.budgetBlock!.spentUsdEstimate).toBe(4.8);
    // contract_intelligence itself never dispatched — "never ran" is preserved as the correct
    // (resumable, un-charged) outcome, not "ran and blew the ceiling".
    expect(run.nodes.find((node) => node.nodeId === "contract_intelligence")!.status).toBe("queued");

    const reloaded = await getRun(started.runId, store);
    expect(reloaded!.status).toBe("blocked");
  });
});

describe("§2.22 audit scenario (b): budget_exceeded on publish_payload/learning_recorder is refused BEFORE the model is ever invoked, not killed mid-turn", () => {
  const makeRun = (budgetUsd: number): WorkflowExecutionRecord => ({
    runId: "run-audit-b", workflowId: "independent_node", projectId: "dr-lurie", status: "running",
    startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], artifacts: [],
    errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai", budgetUsd
  });

  beforeEach(() => { resetRepositoryManager(); process.env.OPENAI_API_KEY = "test-key"; });
  afterEach(() => { delete process.env.OPENAI_API_KEY; resetRepositoryManager(); });

  // Audit quote: "budget_exceeded failures on publish_payload and learning_recorder at $6". The
  // question was whether that stop happens BEFORE a model turn starts (cheap, no wasted spend) or
  // mid-flight (the turn already ran, wasted spend accrued). OpenAINodeRunner's pre-flight check
  // (~line 139) answers this directly: with prior run spend already at the $6 ceiling, it refuses
  // before resolving tools, building the Agent, or touching the model client at all — provably not a
  // mid-flight kill, because nothing was ever dispatched to kill.
  it.each(["publish_payload", "learning_recorder"])("refuses %s with a run-ceiling budget_exceeded before any model call", async (nodeId) => {
    const node = getWorkspaceNode(nodeId)!;
    const run = makeRun(6);
    // Prior spend already AT the $6 ceiling — no room left for even one turn's reserve, so the
    // pre-flight check (not the in-loop per-turn guard, which only engages once a turn starts) must
    // be what refuses this.
    await recordModelUsage({ runId: run.runId, nodeId: "publication_controller", model: "gpt-5.5", provider: "openai", inputTokens: 0, outputTokens: 0, costUsdEstimate: 6, status: "actual" });

    const runner = new OpenAINodeRunner();
    const result = await runner.run({ node, input: {} }, { run, executionRepository: repositoryManager.getExecutionRepository() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("budget_exceeded");
    expect((result.details as { ceiling: string }).ceiling).toBe("run");
    // Pre-flight refusal details carry spentUsdEstimate/reserveUsdEstimate (this node's shape) rather
    // than the in-loop guard's accruedNodeUsage/prospectiveTurnUsd shape — evidence this is the
    // before-dispatch path, not a turn that started and was then aborted.
    expect(result.details).not.toHaveProperty("accruedNodeUsage");
    expect(result.details).toHaveProperty("spentUsdEstimate");
  });
});
