import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { getRun, retryNode, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { summarizeModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { REVIEW_QUARTET } from "../../../src/agent/workspace/skipPredicates.js";

// W4 (determinism program, 2026-08-12) — conductor node-gating, wired into a real run.
//
// The unit tests (skipPredicates.test.ts) prove what each predicate decides. These prove what the
// CONDUCTOR does with that decision: it never dispatches the node, it records WHY on the node itself,
// it writes no stage output / artifact / usage, and every downstream node treats the absence as
// satisfied rather than waiting for an artifact that is never coming.

const advanceUntil = async (runId: string, store: ExecutionRepository, done: (run: WorkflowExecutionRecord) => boolean) => {
  let run = (await getRun(runId, store))!;
  for (let i = 0; i < 40 && !done(run) && !["completed", "failed", "blocked", "cancelled"].includes(run.status); i++) {
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run;
};

const reached = (nodeId: string) => (run: WorkflowExecutionRecord) => ["completed", "blocked", "failed", "skipped"].includes(run.nodes.find((node) => node.nodeId === nodeId)?.status ?? "queued");
const statusOf = (run: WorkflowExecutionRecord, nodeId: string) => run.nodes.find((node) => node.nodeId === nodeId)!.status;

const runToAggregator = async (input: unknown) => {
  const store = new RepositoryManager().getExecutionRepository();
  const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input }, store);
  const run = await advanceUntil(started.runId, store, reached("review_aggregator"));
  return { run, store };
};

describe("a skipped node is a real, auditable state transition — never a silent no-op", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("marks the node skipped, records the predicate and the facts it fired on, and dispatches nothing", async () => {
    const { run } = await runToAggregator({ contentClass: "docs", topic: "Object lifecycle runbook" });
    const research = run.nodes.find((node) => node.nodeId === "research")!;

    expect(research.status).toBe("skipped");
    expect(research.skip?.predicate).toEqual({ when: "no_external_claims" });
    expect(research.skip?.reason).toMatch(/docs\/runbook class/);
    expect(research.skip?.basis).toContain("contentClass: docs");
    expect(research.skip?.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Nothing was dispatched: no output, no stage output, no artifact — a skipped node asserted nothing.
    expect(research.output).toBeUndefined();
    expect(run.stageOutputs.research).toBeUndefined();
    expect(run.artifacts.some((artifact) => artifact.nodeId === "research")).toBe(false);
    // ...and it is visible at run level without opening the node.
    expect(research.warnings).toContain("node_skipped:no_external_claims");
  });

  it("charges nothing for a node it never ran", async () => {
    const { run } = await runToAggregator({ contentClass: "docs", topic: "runbook" });
    const usage = await summarizeModelUsage({ runId: run.runId });
    expect(usage.byNode.research).toBeUndefined();
    expect(usage.byNode.monetization_strategy).toBeUndefined();
    expect(usage.byNode.input_triage).toBeDefined();
  });

  it("gates exactly the nodes the docs-class policy names, and runs the rest", async () => {
    const { run } = await runToAggregator({ contentClass: "docs", topic: "runbook" });
    const skipped = run.nodes.filter((node) => node.status === "skipped").map((node) => node.nodeId).sort();
    expect(skipped).toEqual(["emotional_resonance", "human_texture", "monetization_strategy", "reader_simulation", "research"]);
    for (const stillRuns of ["input_triage", "placement_resolver", "topic_opportunity", "reader_insight", "objection_mapping", "brief_architect", "draft_writer", "trust_factual", "review_aggregator"]) {
      expect(statusOf(run, stillRuns), `${stillRuns} should still run`).toBe("completed");
    }
  });

  it("leaves an unclassified run exactly as it was before W4 — the fail-safe is the whole pipeline", async () => {
    const { run } = await runToAggregator("Draft this");
    expect(run.nodes.filter((node) => node.status === "skipped")).toEqual([]);
    for (const reviewer of REVIEW_QUARTET) expect(statusOf(run, reviewer)).toBe("completed");
  });
});

describe("downstream semantics: a skipped dependency is SATISFIED-with-absent", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("does not park the run: brief_architect runs with research and monetization_strategy skipped", async () => {
    const { run } = await runToAggregator({ contentClass: "docs", topic: "runbook" });
    expect(statusOf(run, "research")).toBe("skipped");
    expect(statusOf(run, "monetization_strategy")).toBe("skipped");
    expect(statusOf(run, "brief_architect")).toBe("completed");
    const brief = run.nodes.find((node) => node.nodeId === "brief_architect")!;
    // The absence arrives WITH its reason attached, not as an unexplained hole.
    const skippedDependencies = (brief.input as { skippedDependencies?: Array<{ nodeId: string; reason: string }> }).skippedDependencies ?? [];
    expect(skippedDependencies.map((entry) => entry.nodeId).sort()).toEqual(["monetization_strategy", "research"]);
    expect(skippedDependencies.every((entry) => entry.reason.length > 0)).toBe(true);
    // ...and the node is TOLD, on the engine-policy channel, not to wait for or invent it.
    const runContext = (brief.input as { runContext?: { enginePolicies?: string[] } }).runContext;
    expect(runContext?.enginePolicies?.join(" ")).toMatch(/deliberately SKIPPED/);
  });

  it("carries the whole run through to the publish gate: a skip never becomes a blocker", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: { contentClass: "docs", topic: "runbook" } }, store);
    const run = await advanceUntil(started.runId, store, reached("publish_payload"));
    expect(statusOf(run, "article_body")).toBe("completed");
    expect(statusOf(run, "publish_payload")).toBe("completed");
    // The publish-approval gate is still the thing that stops the run — unchanged by gating.
    expect(run.errors).toEqual([]);
  });
});

describe("review_aggregator aggregates over whichever reviewers ran — 1, 3 or 4", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  const aggregatorInput = (run: WorkflowExecutionRecord) => {
    const state = run.nodes.find((node) => node.nodeId === "review_aggregator")!;
    const input = state.input as { dependencies: Record<string, unknown>; skippedDependencies?: Array<{ nodeId: string }> };
    const present = Object.entries(input.dependencies).filter(([, value]) => value !== undefined).map(([id]) => id).sort();
    return { state, present, skipped: (input.skippedDependencies ?? []).map((entry) => entry.nodeId).sort() };
  };

  it("docs class: one reviewer present, three recorded as deliberately absent", async () => {
    const { run } = await runToAggregator({ contentClass: "docs", topic: "runbook" });
    const { state, present, skipped } = aggregatorInput(run);
    expect(state.status).toBe("completed");
    expect(present).toEqual(["trust_factual"]);
    expect(skipped).toEqual(["emotional_resonance", "human_texture", "reader_simulation"]);
  });

  it("standard editorial: three reviewers present, emotional_resonance absent by policy", async () => {
    const { run } = await runToAggregator({ contentClass: "standard", topic: "how we chose the substrate" });
    const { state, present, skipped } = aggregatorInput(run);
    expect(state.status).toBe("completed");
    expect(present).toEqual(["human_texture", "reader_simulation", "trust_factual"]);
    expect(skipped).toEqual(["emotional_resonance"]);
  });

  it("money class: all four present, no ledger at all", async () => {
    const { run } = await runToAggregator({ contentClass: "money", topic: "best GLP-1 telehealth" });
    const { state, present, skipped } = aggregatorInput(run);
    expect(state.status).toBe("completed");
    expect(present).toEqual([...REVIEW_QUARTET].sort());
    expect(skipped).toEqual([]);
  });

  it("unknown class: all four, because the fail-safe is to review more, not less", async () => {
    const { run } = await runToAggregator({ contentClass: "a_class_this_policy_has_never_seen", topic: "x" });
    expect(aggregatorInput(run).present).toEqual([...REVIEW_QUARTET].sort());
  });
});

describe("an operator's retry overrides the gate", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("runs a skipped node when explicitly retried, and does not re-skip it", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-a", input: { contentClass: "docs", topic: "runbook" } }, store);
    const gated = await advanceUntil(started.runId, store, reached("review_aggregator"));
    expect(statusOf(gated, "human_texture")).toBe("skipped");

    const retried = (await retryNode(started.runId, "human_texture", { executionRepository: store }))!;
    const state = retried.nodes.find((node) => node.nodeId === "human_texture")!;
    expect(state.skipOverride).toBe(true);
    expect(state.skip).toBeUndefined();
    // The retry actually ran it (the advance that follows a retry dispatches the node).
    expect(["completed", "running"]).toContain(state.status);
    expect(retried.stageOutputs.human_texture).toBeDefined();
  });
});
