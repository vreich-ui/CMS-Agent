import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import { CONCURRENT_DISPATCH_LIMIT, __test__, getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { recordModelUsage } from "../../../src/agent/observability/modelUsage.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// T7 (Wave 3, 2026-08-13) — BOUNDED CONCURRENT DISPATCH.
//
// Evidence (run_1786557897658_elj34j, verified live 2026-08-12): the review quartet ran SERIALLY for
// ~113 seconds although none of the four depends on another and all four feed review_aggregator, which
// already barriers on them via dependsOn. These prove the driver now dispatches them together, that the
// bound and every gate hold, and — the part that matters most — that WHICH SIBLING FINISHES FIRST is
// not observable anywhere in the persisted record.

const QUARTET = ["human_texture", "trust_factual", "emotional_resonance", "reader_simulation"];
const TERMINAL = ["completed", "failed", "blocked", "cancelled"];
const EMPTY_RUN = { stageOutputs: {} } as unknown as WorkflowExecutionRecord;

const statusOf = (run: WorkflowExecutionRecord, nodeId: string) => run.nodes.find((node) => node.nodeId === nodeId)!.status;

// A runner stand-in that records, for every dispatch, which other nodes were in flight AT THE SAME
// MOMENT — the only direct evidence that "concurrent" means concurrent and not merely fast.
type RunnerHooks = { hold?: (nodeId: string) => Promise<void> | undefined; fail?: (nodeId: string) => { code: string; message: string } | undefined };

const installRunner = (hooks: RunnerHooks = {}) => {
  const inFlight = new Set<string>();
  const witnessed = new Map<string, Set<string>>();
  const trace = { dispatched: [] as string[], finished: [] as string[], peakInFlight: 0, witnessed };
  const observe = () => {
    trace.peakInFlight = Math.max(trace.peakInFlight, inFlight.size);
    for (const id of inFlight) {
      const seen = witnessed.get(id) ?? new Set<string>();
      for (const other of inFlight) if (other !== id) seen.add(other);
      witnessed.set(id, seen);
    }
  };
  const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
    supports: () => true,
    validateConfiguration: () => ({ ok: true as const }),
    run: async ({ node }: { node: WorkspaceNode }) => {
      inFlight.add(node.id);
      trace.dispatched.push(node.id);
      observe();
      await hooks.hold?.(node.id);
      observe();
      inFlight.delete(node.id);
      trace.finished.push(node.id);
      const failure = hooks.fail?.(node.id);
      return failure ? { ok: false as const, ...failure } : { ok: true as const, output: mockOutputForNode(node, EMPTY_RUN) };
    }
  } as never);
  return { trace, restore: () => spy.mockRestore() };
};

// Holds each of `members` until ALL of them are in flight at once, then releases them in `finishOrder`
// — so a test can stagger completions deliberately instead of hoping the scheduler staggers them. Nodes
// outside `members` are never held, so driving the run to the interesting point stays fast. The escape
// hatch means a SERIAL regression fails on the concurrency assertion rather than hanging the suite.
const barrierHold = (members: string[], finishOrder: string[] = [], stepMs = 15, escapeMs = 1500) => {
  let arrived = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async (nodeId: string) => {
    if (!members.includes(nodeId)) return;
    arrived += 1;
    if (arrived >= members.length) release();
    await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, escapeMs))]);
    const slot = finishOrder.indexOf(nodeId);
    if (slot >= 0) await new Promise((resolve) => setTimeout(resolve, slot * stepMs));
  };
};

const driveUntil = async (runId: string, store: ExecutionRepository, done: (run: WorkflowExecutionRecord) => boolean, max = 40) => {
  let run = (await getRun(runId, store))!;
  for (let i = 0; i < max && !done(run) && !TERMINAL.includes(run.status); i++) {
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run;
};

// A run positioned so that exactly `readyIds` are dependency-ready: everything else is completed, which
// satisfies every dependency edge without dispatching anything.
const runWithReady = async (readyIds: string[], input: unknown = "Draft this") => {
  const nodes = await __test__.resolveConductorNodes(undefined, "publishing_conductor");
  const run = __test__.buildInitialRun({ projectId: "t7", input, executionMode: "mock" }, nodes);
  for (const state of run.nodes) state.status = readyIds.includes(state.nodeId) ? "queued" : "completed";
  return { run, nodes };
};

// W1 T1.1 (2026-09-04): the injected code is now a NON-retryable one (max_turns_exceeded).
// model_timeout is auto-retried by the orchestrator since W1, so it no longer produces the
// terminal failure THIS test is about — the subject here is unchanged, only the way the
// failure is provoked.

describe("four independent nodes sharing one downstream dependency dispatch concurrently", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("dispatches the whole review quartet in one advance, and review_aggregator barriers on all four", async () => {
    const { trace, restore } = installRunner({ hold: barrierHold(QUARTET) });
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ executionMode: "mock", projectId: "t7", input: "Draft this" }, store);
      const ready = await driveUntil(started.runId, store, (run) => statusOf(run, "draft_writer") === "completed");
      for (const reviewer of QUARTET) expect(statusOf(ready, reviewer)).toBe("queued");

      const batched = await runNextNode(started.runId, { executionRepository: store });

      // ONE advance completed all four, and each of the four was genuinely in flight alongside the
      // other three — not merely dispatched quickly one after another.
      for (const reviewer of QUARTET) expect(statusOf(batched, reviewer)).toBe("completed");
      expect(trace.peakInFlight).toBe(4);
      for (const reviewer of QUARTET) {
        expect([...(trace.witnessed.get(reviewer) ?? [])].sort()).toEqual(QUARTET.filter((id) => id !== reviewer).sort());
      }
      // The aggregator waited — no special case, just its own dependsOn: it was never in flight with a
      // reviewer, and it only becomes the next runnable node once the last of the four completes.
      expect(trace.dispatched).not.toContain("review_aggregator");
      expect(statusOf(batched, "review_aggregator")).toBe("queued");
      expect(batched.currentNodeId).toBe("review_aggregator");
      expect(batched.status).toBe("running");
    } finally {
      restore();
    }
  });
});

describe("what may never join a batch", () => {
  it("never dispatches a publish-risk node concurrently with anything", async () => {
    // publication_controller (riskLevel "publish") ready alongside an ordinary node: no batch at all,
    // so the publish-risk node is handed to the serial path where its gates decide the run's fate.
    const { run, nodes } = await runWithReady(["publication_controller", "learning_recorder"]);
    expect(__test__.selectConcurrentBatch(run, nodes, nodes.find((node) => node.id === "publication_controller")!, undefined)).toEqual([]);

    // And it is never picked up as a tail-end passenger of somebody else's batch either.
    const withReviewers = await runWithReady([...QUARTET, "publication_controller"]);
    const batch = __test__.selectConcurrentBatch(withReviewers.run, withReviewers.nodes, withReviewers.nodes.find((node) => node.id === "human_texture")!, undefined);
    expect(batch.map((node: WorkspaceNode) => node.id)).toEqual(QUARTET);
  });

  it("leaves deterministic-route and about-to-be-skipped nodes to the serial path", async () => {
    // contract_intelligence declares contractIntelligenceDeterministic: its evaluation is engine code,
    // so the batch ends before it rather than interleaving it with a model dispatch.
    const deterministic = await runWithReady(["draft_writer", "contract_intelligence"]);
    expect(__test__.selectConcurrentBatch(deterministic.run, deterministic.nodes, deterministic.nodes.find((node) => node.id === "draft_writer")!, undefined)).toEqual([]);

    // A docs-class run skips human_texture, so the quartet's head is a $0 skip decision, not a dispatch.
    const skipping = await runWithReady(QUARTET, { contentClass: "docs", topic: "Object lifecycle runbook" });
    expect(__test__.selectConcurrentBatch(skipping.run, skipping.nodes, skipping.nodes.find((node) => node.id === "human_texture")!, undefined)).toEqual([]);
  });

  it("holds the bound of 4 when five or more nodes are ready", async () => {
    // The publishing conductor's widest independent fan-out IS the quartet, so a six-wide fan-out is
    // built from six dependency-free clones of a reviewer node — same eligibility in every respect.
    const conductorNodes = await __test__.resolveConductorNodes(undefined, "publishing_conductor");
    const template = conductorNodes.find((node: WorkspaceNode) => node.id === "human_texture")!;
    const ids = ["fan_a", "fan_b", "fan_c", "fan_d", "fan_e", "fan_f"];
    const nodes = ids.map((id) => ({ ...template, id, dependsOn: [] }) as WorkspaceNode);
    const run = { initialInput: "Draft this", stageOutputs: {}, nodes: ids.map((id) => ({ nodeId: id, status: "queued" })) } as unknown as WorkflowExecutionRecord;

    const batch = __test__.selectConcurrentBatch(run, nodes, nodes[0], undefined);
    expect(CONCURRENT_DISPATCH_LIMIT).toBe(4);
    expect(batch).toHaveLength(CONCURRENT_DISPATCH_LIMIT);
    // The batch is the canonical PREFIX of the ready list — never an arbitrary subset of four.
    expect(batch.map((node: WorkspaceNode) => node.id)).toEqual(ids.slice(0, 4));
  });
});

describe("failure isolation and canonical ordering under a concurrent batch", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  const toQuartet = async (store: ExecutionRepository) => {
    const started = await startDryRun({ executionMode: "mock", projectId: "t7", input: "Draft this" }, store);
    await driveUntil(started.runId, store, (run) => statusOf(run, "draft_writer") === "completed");
    return started.runId;
  };
  const batchArtifacts = (run: WorkflowExecutionRecord) => run.artifacts.filter((artifact) => QUARTET.includes(artifact.nodeId)).map((artifact) => artifact.nodeId);

  it("keeps three siblings' results when the fourth fails, and halts the run at the failing node", async () => {
    const { trace, restore } = installRunner({ hold: barrierHold(QUARTET), fail: (nodeId) => nodeId === "trust_factual" ? { code: "max_turns_exceeded", message: "timed out" } : undefined });
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const runId = await toQuartet(store);
      const batched = await runNextNode(runId, { executionRepository: store });

      expect(trace.peakInFlight).toBe(4);
      expect(statusOf(batched, "trust_factual")).toBe("failed");
      for (const survivor of ["human_texture", "emotional_resonance", "reader_simulation"]) {
        expect(statusOf(batched, survivor)).toBe("completed");
        expect(batched.stageOutputs[survivor]).toBeDefined();
      }
      // The run is in the state a serial run would have reached: halted AT the failing node, with the
      // failure named once in the run-level ledger and the aggregator still waiting.
      expect(batched.status).toBe("failed");
      expect(batched.currentNodeId).toBe("trust_factual");
      expect(batched.errors).toEqual(["trust_factual:max_turns_exceeded"]);
      expect(statusOf(batched, "review_aggregator")).toBe("queued");
      // Halted means halted: the next advance does not walk past the failure.
      const after = await runNextNode(runId, { executionRepository: store });
      expect(after.status).toBe("failed");
      expect(statusOf(after, "review_aggregator")).toBe("queued");
    } finally {
      restore();
    }
  });

  it("orders errors, artifacts and node statuses canonically no matter which sibling finishes first", async () => {
    // Deliberately staggered: the quartet finishes in REVERSE canonical order, and the two failures are
    // the canonically first and last members — so completion order and canonical order disagree at every
    // position where the record could leak the schedule.
    const reversed = [...QUARTET].reverse();
    const { trace, restore } = installRunner({
      hold: barrierHold(QUARTET, reversed),
      fail: (nodeId) => ["human_texture", "reader_simulation"].includes(nodeId) ? { code: "max_turns_exceeded", message: "timed out" } : undefined
    });
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const runId = await toQuartet(store);
      const batched = await runNextNode(runId, { executionRepository: store });

      // The stagger really happened...
      expect(trace.finished.slice(-4)).toEqual(reversed);
      // ...and none of it is visible in the record. Errors in canonical order, not completion order.
      expect(batched.errors).toEqual(["human_texture:max_turns_exceeded", "reader_simulation:max_turns_exceeded"]);
      // Artifacts in canonical order — the two survivors, oldest-canonical first.
      expect(batchArtifacts(batched)).toEqual(["trust_factual", "emotional_resonance"]);
      // Node statuses stay in the canonical `nodes` order the run was built with.
      const nodes = await __test__.resolveConductorNodes(undefined, "publishing_conductor");
      expect(batched.nodes.map((node) => node.nodeId)).toEqual(nodes.map((node: WorkspaceNode) => node.id));
      expect(QUARTET.map((id) => statusOf(batched, id))).toEqual(["failed", "completed", "completed", "failed"]);
      // The run halts at the canonically FIRST failure — the node a serial run would have stopped at,
      // even though it was the LAST to finish here.
      expect(batched.status).toBe("failed");
      expect(batched.currentNodeId).toBe("human_texture");
    } finally {
      restore();
    }
  });

  it("stamps no lingering dispatch claim on a batch's completed nodes", async () => {
    const { restore } = installRunner({ hold: barrierHold(QUARTET) });
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const runId = await toQuartet(store);
      const batched = await runNextNode(runId, { executionRepository: store });
      // The claim save marks all four in flight (the heartbeat runContinuation reads); the
      // reconciliation must clear every one of them, or a completed run looks permanently mid-dispatch.
      for (const reviewer of QUARTET) expect(batched.nodes.find((node) => node.nodeId === reviewer)!.dispatch).toBeUndefined();
      expect(batched.nodes.some((node) => node.status === "running")).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("the run-level budget gate still stops the run under concurrent dispatch", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  // Drive to the quartet under a ceiling, then inject the measured (status "actual") spend the way live
  // model cost actually arrives — a mock run's own estimates never consume the ceiling (R-20).
  const atQuartetWithSpend = async (store: ExecutionRepository, budgetUsd: number, spentUsd: number) => {
    const started = await startDryRun({ executionMode: "mock", projectId: "t7", input: "Draft this", budgetUsd }, store);
    await driveUntil(started.runId, store, (run) => statusOf(run, "draft_writer") === "completed");
    await recordModelUsage({ runId: started.runId, nodeId: "draft_writer", model: "gpt-5.5", provider: "openai", inputTokens: 0, outputTokens: 0, costUsdEstimate: spentUsd, status: "actual" });
    return started.runId;
  };

  it("blocks the run before the batch when the head node's own reservation would cross the ceiling", async () => {
    const { trace, restore } = installRunner({ hold: barrierHold(QUARTET) });
    try {
      const store = new RepositoryManager().getExecutionRepository();
      const runId = await atQuartetWithSpend(store, 3, 2.9); // 2.9 + human_texture's own 0.25 > 3
      const blocked = await runNextNode(runId, { executionRepository: store });

      expect(blocked.status).toBe("blocked");
      expect(blocked.budgetBlock!.nextNodeId).toBe("human_texture");
      // Not one of the four was dispatched — a batch cannot be the thing that walks through the gate.
      for (const reviewer of QUARTET) {
        expect(statusOf(blocked, reviewer)).toBe("queued");
        expect(trace.dispatched).not.toContain(reviewer);
      }
    } finally {
      restore();
    }
  });

  it("reserves the ceiling for the WHOLE batch, so four nodes cannot collectively overshoot it", async () => {
    const { trace, restore } = installRunner({ hold: barrierHold(["human_texture", "trust_factual"]) });
    try {
      const store = new RepositoryManager().getExecutionRepository();
      // 2.2 spent of a $3 ceiling: human_texture (0.25) and trust_factual (0.4) fit at 2.85;
      // emotional_resonance's 0.2 would reach 3.05, so the batch ENDS at two.
      const runId = await atQuartetWithSpend(store, 3, 2.2);
      const batched = await runNextNode(runId, { executionRepository: store });

      expect(trace.peakInFlight).toBe(2);
      expect(statusOf(batched, "human_texture")).toBe("completed");
      expect(statusOf(batched, "trust_factual")).toBe("completed");
      expect(statusOf(batched, "emotional_resonance")).toBe("queued");
      expect(statusOf(batched, "reader_simulation")).toBe("queued");
      // ...and the two the reservation held back meet the gate again on the next advance, now against
      // the spend the batch actually accrued. Charge that spend and the run halts exactly where a serial
      // run would have — at the node whose own reservation crosses the ceiling, never after it.
      await recordModelUsage({ runId, nodeId: "trust_factual", model: "gpt-5.5", provider: "openai", inputTokens: 0, outputTokens: 0, costUsdEstimate: 0.75, status: "actual" });
      const next = await runNextNode(runId, { executionRepository: store });
      expect(next.status).toBe("blocked");
      expect(next.budgetBlock!.nextNodeId).toBe("emotional_resonance");
      expect(statusOf(next, "emotional_resonance")).toBe("queued");
      expect(statusOf(next, "reader_simulation")).toBe("queued");
    } finally {
      restore();
    }
  });
});
