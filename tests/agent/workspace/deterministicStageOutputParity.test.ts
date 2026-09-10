import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getRun, retryNode, runNextNode, startDryRun, stageOutputMirrorId, STAGE_OUTPUT_MIRROR_FAILED } from "../../../src/agent/workspace/executor.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../../../src/agent/repository/interfaces/WorkspaceRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T3 (2026-09-10) — DETERMINISTIC OUTPUT-PERSISTENCE PARITY.
//
// THE DEFECT this pins (run_1789034392364_o7bhnj): a completed DETERMINISTIC node wrote
// run.stageOutputs + a run artifact and returned `{ run }` with no `commit`, so the workspace
// stage-output mirror that the generic MODEL path performed never ran for it. `node_list_outputs`
// held ~177KB of real `capture_map.v1` output while `stage_list_outputs({stage:"capture_map"})`
// answered with two records from OLDER runs — and the Workbench, reading the stage store, told the
// operator "No stage output recorded for this node in this run".
//
// The contract these tests hold to is the one stated in executor.ts: the run/artifact ledger is
// canonical, the stage store is a compatibility surface, and EVERY successful node completion —
// deterministic or model — populates it with the same value under the same idempotent id.

const drive = async (runId: string, store: ExecutionRepository, workspaceRepository: WorkspaceRepository, max = 60): Promise<WorkflowExecutionRecord> => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max && !HALTED_EXECUTION_STATUSES.has(run.status) && run.status !== "completed"; i++) {
    run = await runNextNode(runId, { executionRepository: store, workspaceRepository });
  }
  return run!;
};

const completedNodeIds = (run: WorkflowExecutionRecord): string[] =>
  run.nodes.filter((state) => state.status === "completed" && Object.prototype.hasOwnProperty.call(run.stageOutputs, state.nodeId)).map((state) => state.nodeId);

describe("every successful node completion reaches the stage store (deterministic and model alike)", () => {
  it("mirrors EVERY completed node's output under `${runId}:${nodeId}`, with the same value the run record holds", async () => {
    const manager = new RepositoryManager();
    const store = manager.getExecutionRepository();
    const workspaceRepository = manager.getWorkspaceRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "stage-output parity", budgetUsd: 100 }, store, workspaceRepository);

    const run = await drive(started.runId, store, workspaceRepository);
    const completed = completedNodeIds(run);
    // A run that completed nothing would make every assertion below vacuously true.
    expect(completed.length).toBeGreaterThan(2);

    const missing: string[] = [];
    const divergent: string[] = [];
    for (const nodeId of completed) {
      const record = await workspaceRepository.getStageOutput(stageOutputMirrorId(run.runId, nodeId));
      if (!record) { missing.push(nodeId); continue; }
      expect(record.stage).toBe(nodeId);
      if (JSON.stringify(record.value) !== JSON.stringify(run.stageOutputs[nodeId])) divergent.push(nodeId);
    }
    expect(missing, `completed nodes with no stage-store record: ${missing.join(", ")}`).toEqual([]);
    expect(divergent, `stage-store value diverged from the run ledger: ${divergent.join(", ")}`).toEqual([]);
  });

  it("a RETRIED node still holds exactly one stage record, carrying the new attempt's value — never a second record and never the stale one", async () => {
    const manager = new RepositoryManager();
    const store = manager.getExecutionRepository();
    const workspaceRepository = manager.getWorkspaceRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "stage-output idempotency", budgetUsd: 100 }, store, workspaceRepository);
    const run = await drive(started.runId, store, workspaceRepository);
    const nodeId = completedNodeIds(run)[0];
    const before = await workspaceRepository.getStageOutput(stageOutputMirrorId(run.runId, nodeId));
    expect(before).toBeDefined();

    // retryNode deletes run.stageOutputs[nodeId] and drops the node's artifacts, then the node runs
    // again. The mirror id is stable, so the second completion UPSERTS its own record rather than
    // adding a second one — this is what keeps the two surfaces from disagreeing after a retry.
    await retryNode(started.runId, nodeId, { executionRepository: store, workspaceRepository });
    const replayed = await drive(started.runId, store, workspaceRepository);

    const owned = (await workspaceRepository.listStageOutputs(nodeId)).filter((output) => output.id.startsWith(`${run.runId}:`));
    expect(owned).toHaveLength(1);
    expect(owned[0].id).toBe(stageOutputMirrorId(run.runId, nodeId));
    // And it holds what the ledger holds NOW, not what the first attempt produced.
    expect(JSON.stringify(owned[0].value)).toBe(JSON.stringify(replayed.stageOutputs[nodeId]));
  });

  it("does NOT mirror a node that did not succeed — the run artifact still records what happened", async () => {
    const manager = new RepositoryManager();
    const store = manager.getExecutionRepository();
    const workspaceRepository = manager.getWorkspaceRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "stage-output non-success", budgetUsd: 100 }, store, workspaceRepository);
    const run = await drive(started.runId, store, workspaceRepository);

    const unsuccessful = run.nodes.filter((state) => state.status !== "completed" && Object.prototype.hasOwnProperty.call(run.stageOutputs, state.nodeId));
    // Without this the loop below is vacuous on a run that happens to complete cleanly. A mock
    // publishing run always stops at the publish-approval gate, which writes exactly this shape:
    // a node that did NOT succeed but still wrote a stage output and an artifact.
    expect(unsuccessful.length).toBeGreaterThan(0);
    for (const state of unsuccessful) {
      expect(await workspaceRepository.getStageOutput(stageOutputMirrorId(run.runId, state.nodeId))).toBeUndefined();
      // ...while the canonical ledger still carries its artifact, which is what the Workbench reads.
      expect(run.artifacts.some((artifact) => artifact.nodeId === state.nodeId)).toBe(true);
    }
  });
});

describe("the mirror is best-effort, but never silent", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { warn.mockRestore(); });

  it("a failed stage-output write leaves the successful run successful, and names itself in a diagnostic", async () => {
    const manager = new RepositoryManager();
    const store = manager.getExecutionRepository();
    const workspaceRepository = manager.getWorkspaceRepository();
    vi.spyOn(workspaceRepository, "saveStageOutput").mockRejectedValue(new Error("workspace store unavailable"));

    const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "stage-output failure", budgetUsd: 100 }, store, workspaceRepository);
    const run = await drive(started.runId, store, workspaceRepository);

    // The tenant-facing outcome is unchanged: nodes completed, the canonical ledger holds the output.
    expect(completedNodeIds(run).length).toBeGreaterThan(2);
    expect(run.status === "completed" || run.status === "blocked").toBe(true);

    // And the secondary failure is observable rather than swallowed — named, with ids only.
    const calls = warn.mock.calls.filter((call) => call[0] === STAGE_OUTPUT_MIRROR_FAILED);
    expect(calls.length).toBeGreaterThan(0);
    const payload = JSON.parse(calls[0][1] as string) as { runId: string; nodeId: string; reason: string };
    expect(payload.runId).toBe(run.runId);
    expect(payload.reason).toContain("workspace store unavailable");
    // No output values ride along in the diagnostic.
    expect(Object.keys(payload).sort()).toEqual(["nodeId", "reason", "runId"]);
  });
});
