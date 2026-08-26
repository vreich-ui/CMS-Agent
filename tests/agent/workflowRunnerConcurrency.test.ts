import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import { MemoryExecutionRepository } from "../../src/agent/repository/memory/MemoryExecutionRepository.js";
import { RunConcurrencyError } from "../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { ExecutionRepository } from "../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../src/agent/workspace/executionTypes.js";
import { getRun, resetRun, retryNode, runNextNode, setOperatorPublishDecision, startDryRun, updateRunStatus } from "../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../src/agent/runtime/repositories.js";

const TERMINAL = ["completed", "failed", "blocked", "cancelled"];

const drive = async (runId: string, store: ExecutionRepository, options: { approved?: boolean } = {}) => {
  // T15.7 (ADR-2026-08-25-publish-autonomy §7) — `approved` is deprecated as an authority input;
  // the executor now reads the run's own durable operator record instead.
  if (options.approved) await setOperatorPublishDecision(runId, "approved", store);
  let run = await getRun(runId, store);
  for (let i = 0; run && i < 50 && !TERMINAL.includes(run.status); i++) {
    run = await runNextNode(runId, { executionRepository: store, approved: options.approved });
  }
  return run as WorkflowExecutionRecord;
};

const artifactNodeIds = (run: WorkflowExecutionRecord) => run.artifacts.map((artifact) => artifact.nodeId);
const completedNodeIds = (run: WorkflowExecutionRecord) => run.nodes.filter((node) => node.status === "completed").map((node) => node.nodeId);

describe("Publishing Conductor runner state advancement", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("never re-runs a completed node under overlapping run_next_node calls", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "concurrent" }, store);

    // Fire many advances concurrently on the same run. The reproduced bug re-ran already-completed
    // nodes (two artifacts for the same node); with per-run serialization each call must advance one
    // distinct node.
    await Promise.all(Array.from({ length: 8 }, () => runNextNode(run.runId, { executionRepository: store })));
    const final = (await getRun(run.runId, store))!;

    // T7 (Wave 3): NINE distinct nodes for eight advances, still exactly one execution each. The head of
    // the graph is no longer linear to the driver — monetization_strategy and reader_insight both hang
    // off topic_opportunity and are independent of one another, so one advance dispatches both as a
    // bounded concurrent batch. Completion order is still canonical node order, which is the property
    // this test guards alongside "no node ever runs twice".
    expect(completedNodeIds(final)).toEqual([
      "input_triage", "placement_resolver", "topic_opportunity", "monetization_strategy",
      "reader_insight", "research", "objection_mapping", "narrative_movement", "angle_strategy"
    ]);
    // One artifact per completed node — no duplicates from a replayed node.
    expect(artifactNodeIds(final)).toEqual(completedNodeIds(final));
    expect(new Set(artifactNodeIds(final)).size).toBe(artifactNodeIds(final).length);
    // Sixteen atomic commits over the seeded rev 0: each advance now persists a dispatch CLAIM
    // before executing the node (the ~300s silent-death heartbeat) plus the completion save. T7 does
    // not change that arithmetic — a concurrent batch claims all its members in ONE save and merges
    // their results into ONE reconciliation save, so eight advances are still sixteen revisions.
    expect(final.rev).toBe(16);
    expect(final.currentNodeId).toBe("brief_architect");

    // Usage is recorded once per completed node, not once per (possibly replayed) execution.
    const usage = await repositoryManager.getUsageRepository().list({ runId: run.runId });
    expect(usage).toHaveLength(9);
    expect(new Set(usage.map((record) => record.nodeId)).size).toBe(9);
  });

  it("advances deterministically through article_body -> publish_payload and stops before the publish-risk node", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "late path" }, store);

    const final = await drive(run.runId, store);

    const articleBody = final.nodes.find((node) => node.nodeId === "article_body")!;
    const publishPayload = final.nodes.find((node) => node.nodeId === "publish_payload")!;
    expect(articleBody.status).toBe("completed");
    expect(publishPayload.status).toBe("completed");
    // article_body must have completed before publish_payload started (dependency order).
    expect(Date.parse(articleBody.completedAt!)).toBeLessThanOrEqual(Date.parse(publishPayload.startedAt!));

    // Stops at the publish-risk node without approval; the downstream node never runs.
    expect(final.status).toBe("blocked");
    expect(final.currentNodeId).toBe("publication_controller");
    expect(final.nodes.find((node) => node.nodeId === "publication_controller")!.status).toBe("blocked");
    // F4 (T-2, run_1785352838155_l544ye): learning_recorder no longer waits on publication_controller
    // completing (which never happens on a dry run — every dry run blocks there by design, so the
    // dependency was permanently unsatisfiable and zero observations were ever recorded). It now fires
    // as a best-effort side effect the moment the run reaches ANY terminal outcome, including this
    // blocked-for-approval one, without changing the run's own reported status/currentNodeId.
    expect(final.nodes.find((node) => node.nodeId === "learning_recorder")!.status).toBe("completed");
    expect(final.status).toBe("blocked");
    expect(final.currentNodeId).toBe("publication_controller");
    expect(final.approvalsRequired).toEqual([
      expect.objectContaining({ nodeId: "publication_controller", type: "approval_required" })
    ]);
  });

  it("runs the publish-risk node and completes when approval is supplied", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "approved" }, store);

    const final = await drive(run.runId, store, { approved: true });

    expect(final.status).toBe("completed");
    expect(final.nodes.find((node) => node.nodeId === "publication_controller")!.status).toBe("completed");
    // §2.15: learning_recorder now sits DOWNSTREAM of publish_executor, so on the approved path it
    // observes the executor's publish_execution.v1 outcome instead of running in parallel with it.
    const executor = final.nodes.find((node) => node.nodeId === "publish_executor")!;
    const learning = final.nodes.find((node) => node.nodeId === "learning_recorder")!;
    expect(executor.status).toBe("completed");
    expect(learning.status).toBe("completed");
    expect(Date.parse(executor.completedAt!)).toBeLessThanOrEqual(Date.parse(learning.startedAt!));
    expect(final.currentNodeId).toBeUndefined();
  });

  it("reset clears node state/artifacts/stageOutputs and resume does not restore pre-reset state", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "reset" }, store);
    await runNextNode(run.runId, { executionRepository: store });
    await runNextNode(run.runId, { executionRepository: store });
    const beforeReset = (await getRun(run.runId, store))!;
    expect(completedNodeIds(beforeReset).length).toBe(2);

    const afterReset = await resetRun(run.runId, store);
    expect(afterReset.nodes.every((node) => node.status === "queued")).toBe(true);
    expect(afterReset.currentNodeId).toBe("input_triage");
    expect(afterReset.artifacts).toEqual([]);
    expect(afterReset.stageOutputs).toEqual({});

    // get_run agrees with the reset state.
    const fetched = (await getRun(run.runId, store))!;
    expect(completedNodeIds(fetched)).toEqual([]);

    // resume only flips status; it must not resurrect completed node state.
    const resumed = (await updateRunStatus(run.runId, "queued", store))!;
    expect(resumed.status).toBe("queued");
    expect(completedNodeIds(resumed)).toEqual([]);
    expect(resumed.stageOutputs).toEqual({});
    expect(resumed.artifacts).toEqual([]);
  });

  it("rejects a save whose base revision is stale (compare-and-swap)", async () => {
    const repo = new MemoryExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "cas" }, repo);

    const readA = (await repo.getRun(run.runId))!;
    const readB = (await repo.getRun(run.runId))!;
    expect(readA.rev).toBe(readB.rev);

    await repo.saveRun({ ...readA, status: "running" });
    // readB holds the now-stale revision, so its save must be rejected rather than clobber readA.
    await expect(repo.saveRun({ ...readB, status: "completed" })).rejects.toBeInstanceOf(RunConcurrencyError);
  });

  it("a reset invalidates an in-flight save so stale completed state cannot be restored", async () => {
    const repo = new MemoryExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "reset-race" }, repo);
    const inFlight = (await getRun(run.runId, repo))!; // captured before reset

    await resetRun(run.runId, repo);

    // Persisting the pre-reset snapshot must fail; the reset bumped the revision past it.
    await expect(repo.saveRun({ ...inFlight, status: "completed", nodes: inFlight.nodes.map((node) => ({ ...node, status: "completed" as const })) }))
      .rejects.toBeInstanceOf(RunConcurrencyError);
    const current = (await getRun(run.runId, repo))!;
    expect(completedNodeIds(current)).toEqual([]);
  });

  it("run_next_node on a terminal (blocked) run is an idempotent no-op", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "idempotent" }, store);
    const blocked = await drive(run.runId, store);
    expect(blocked.status).toBe("blocked");
    const artifactsBefore = blocked.artifacts.length;
    const revBefore = blocked.rev;
    const usageBefore = (await repositoryManager.getUsageRepository().list({ runId: run.runId })).length;

    // Further advances on a blocked run change nothing: no node runs, no new artifacts, no new usage,
    // and the revision does not move (the read-mutate-write cycle short-circuits before any save).
    await runNextNode(run.runId, { executionRepository: store });
    await runNextNode(run.runId, { executionRepository: store });
    const after = (await getRun(run.runId, store))!;

    expect(after.status).toBe("blocked");
    expect(after.currentNodeId).toBe("publication_controller");
    expect(after.artifacts).toHaveLength(artifactsBefore);
    expect(after.rev).toBe(revBefore);
    expect(await repositoryManager.getUsageRepository().list({ runId: run.runId })).toHaveLength(usageBefore);
  });

  it("retry_node re-runs an already-completed node without leaving duplicate artifacts", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "retry" }, store);
    await runNextNode(run.runId, { executionRepository: store });
    expect((await getRun(run.runId, store))!.nodes.find((node) => node.nodeId === "input_triage")!.status).toBe("completed");

    const retried = (await retryNode(run.runId, "input_triage", { executionRepository: store }))!;

    // input_triage ran again (explicit retry) and there is still exactly one artifact for it.
    expect(retried.nodes.find((node) => node.nodeId === "input_triage")!.status).toBe("completed");
    expect(artifactNodeIds(retried).filter((id) => id === "input_triage")).toHaveLength(1);
    expect(retried.currentNodeId).toBe("placement_resolver");
  });
});
