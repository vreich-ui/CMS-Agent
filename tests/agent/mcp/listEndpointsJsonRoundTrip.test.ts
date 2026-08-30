// W1.4 (list-serialization P0).
//
// Wolf's brief reported "Invalid content from server" (a proxy-level JSON-RPC failure, not a tool
// error) on workflow_list_runs and project_list. Live reproduction against the real Cloud Run
// store (this session, 2026-08-29) found those two calls in fact round-trip fine once scoped by
// projectId — the failure that reproduces 100% of the time, on every runId, including ones with
// clean well-formed records, is node.list_executions / node.get_latest_output / node.list_outputs.
//
// Root cause: nodeRuntime.ts's listNodeExecutions/listNodeOutputs called
// executionRepository.listRuns({}) — EVERY run blob in the entire workspace, across every
// project, fetched and JSON-parsed in full via Promise.all — even when the caller supplied a
// runId that narrows the answer to exactly one run. Against the live store (54+ runs across
// dr-lurie/zilberman alone, individual runs 100KB-1.2MB per workflow_get_run's own documented
// size) that is tens of MB of unnecessary fetch+parse work on every single call, which is what
// starves the response before the MCP round trip completes. The eventual JSON this code produces
// is small and well-formed (proven by the round-trip assertions below); the defect was in what it
// paid to construct it, not in how it was serialized once built.
//
// This file has two jobs:
//   1. Prove every list endpoint's wire response is valid, round-trippable JSON — content[0].text
//      parses back to exactly structuredContent, for both a populated and an empty store.
//   2. Prove the fix: a runId-scoped node query now reaches the repository through getRun (one
//      targeted blob read), never through the unscoped listRuns({}) fan-out.
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { listNodeExecutions, listNodeOutputs } from "../../../src/agent/workspace/nodeRuntime.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  // The assertion that matters: the raw HTTP body is valid JSON at all. A truncated-mid-string
  // body (the surrogate-pair-slice class of bug, or any other transport-level corruption) throws
  // here, not downstream — this is what "Invalid content from server" looks like from the inside.
  expect(() => JSON.parse(response.body)).not.toThrow();
  return JSON.parse(response.body);
};

// Every list endpoint's `content[0].text` must be independently valid JSON that parses back to
// exactly `structuredContent` — this is the literal client-side operation ("Invalid content from
// server") that a truncated or ill-formed body fails.
const expectJsonRoundTrip = (response: any) => {
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  const block = response.result.content[0];
  expect(block.type).toBe("text");
  let reparsed: unknown;
  expect(() => { reparsed = JSON.parse(block.text); }).not.toThrow();
  expect(reparsed).toEqual(response.result.structuredContent);
  return response.result.structuredContent.data;
};

const bigRun = (runId: string, nodeId: string): WorkflowExecutionRecord => ({
  runId, workflowId: "publishing_conductor", projectId: "dr-lurie", status: "completed",
  startedAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:01:00.000Z", completedAt: "2026-08-27T00:01:00.000Z",
  // A realistically large node (real runs run 100KB-1.2MB per workflow_get_run's own docs) so a
  // regression that reintroduces the unscoped fan-out is visible in this suite too, not just live.
  nodes: [{ nodeId, status: "completed", input: "x".repeat(50_000), output: "y".repeat(50_000) } as any],
  artifacts: [{ id: `artifact_${runId}`, nodeId, type: "triage", value: "z".repeat(50_000), createdAt: "2026-08-27T00:01:00.000Z" } as any],
  errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai"
});

describe("list endpoints round-trip JSON.parse (W1.4)", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("workflow.list_runs round-trips on an empty store", async () => {
    const response = await call("workflow.list_runs", {});
    const data = expectJsonRoundTrip(response);
    expect(data.runs).toEqual([]);
  });

  it("workflow.list_runs round-trips with runs seeded, scoped and unscoped by projectId", async () => {
    const repo = repositoryManager.getExecutionRepository();
    await repo.createRun(bigRun("run_a", "input_triage"));
    await repo.createRun(bigRun("run_b", "draft_writer"));
    expectJsonRoundTrip(await call("workflow.list_runs", { projectId: "dr-lurie" }));
    expectJsonRoundTrip(await call("workflow.list_runs", {}));
  });

  it("project_list round-trips", async () => {
    const response = await call("project.list", {});
    const data = expectJsonRoundTrip(response);
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it("node.list_executions round-trips for runId, nodeId, and both together, against a large record", async () => {
    await repositoryManager.getExecutionRepository().createRun(bigRun("run_large", "draft_writer"));
    expectJsonRoundTrip(await call("node.list_executions", { runId: "run_large" }));
    expectJsonRoundTrip(await call("node.list_executions", { nodeId: "draft_writer" }));
    expectJsonRoundTrip(await call("node.list_executions", { runId: "run_large", nodeId: "draft_writer" }));
  });

  it("node.get_latest_output and node.list_outputs round-trip for a runId-scoped query", async () => {
    await repositoryManager.getExecutionRepository().createRun(bigRun("run_large2", "draft_writer"));
    const latest = expectJsonRoundTrip(await call("node.get_latest_output", { runId: "run_large2" }));
    expect(latest.output).not.toBeNull();
    expectJsonRoundTrip(await call("node.list_outputs", { runId: "run_large2" }));
  });

  it("node.list_executions and node.get_latest_output round-trip when nothing matches", async () => {
    expectJsonRoundTrip(await call("node.list_executions", { runId: "run_does_not_exist" }));
    expectJsonRoundTrip(await call("node.get_latest_output", { runId: "run_does_not_exist" }));
  });
});

// A runId-scoped query must reach the repository through getRun (one targeted blob read), never
// through the unscoped listRuns({}) fan-out (every run blob in the workspace, every project) —
// that fan-out, paid on every call regardless of how narrow the filter, is the root cause
// reproduced live against run_1788011844073_ipwrnx. A spy repository proves the code path, since
// a real network timeout can't be reproduced in-process.
describe("node.list_executions / node.list_outputs use targeted getRun when runId narrows the query", () => {
  const spyRepository = (runs: WorkflowExecutionRecord[]): ExecutionRepository & { listRunsCalls: number; getRunCalls: string[] } => ({
    listRunsCalls: 0,
    getRunCalls: [],
    async createRun(run) { return run; },
    async getRun(runId) { this.getRunCalls.push(runId); return runs.find((run) => run.runId === runId); },
    async listRuns() { this.listRunsCalls += 1; return runs; },
    async listRunsPage() { this.listRunsCalls += 1; return { runs, matchedCount: runs.length, hasMore: false }; },
    async saveRun(run) { return run; },
    async resetRun(_runId, run) { return run; },
    async health() { return { ok: true, backend: "spy", version: "spy.v1" } as any; }
  });

  it("listNodeExecutions({runId}) calls getRun, not listRuns", async () => {
    const runs = [bigRun("run_x", "draft_writer")];
    const repo = spyRepository(runs);
    const usageRepository = { list: async () => [] } as any;
    const entries = await listNodeExecutions({ runId: "run_x" }, repo, usageRepository);
    expect(repo.getRunCalls).toEqual(["run_x"]);
    expect(repo.listRunsCalls).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].runId).toBe("run_x");
  });

  it("listNodeExecutions({nodeId}) with no runId still falls back to listRuns (spans runs)", async () => {
    const runs = [bigRun("run_x", "draft_writer"), bigRun("run_y", "draft_writer")];
    const repo = spyRepository(runs);
    const usageRepository = { list: async () => [] } as any;
    const entries = await listNodeExecutions({ nodeId: "draft_writer" }, repo, usageRepository);
    expect(repo.listRunsCalls).toBe(1);
    expect(repo.getRunCalls).toEqual([]);
    expect(entries).toHaveLength(2);
  });

  it("listNodeOutputs({runId}) calls getRun, not listRuns", async () => {
    const runs = [bigRun("run_z", "draft_writer")];
    const repo = spyRepository(runs);
    const outputs = await listNodeOutputs({ runId: "run_z" }, repo);
    expect(repo.getRunCalls).toEqual(["run_z"]);
    expect(repo.listRunsCalls).toBe(0);
    expect(outputs).toHaveLength(1);
  });

  it("listNodeExecutions({runId}) for a runId absent from the store calls getRun and returns empty, without falling back to listRuns", async () => {
    const repo = spyRepository([bigRun("run_other", "draft_writer")]);
    const usageRepository = { list: async () => [] } as any;
    const entries = await listNodeExecutions({ runId: "run_missing" }, repo, usageRepository);
    expect(repo.getRunCalls).toEqual(["run_missing"]);
    expect(repo.listRunsCalls).toBe(0);
    expect(entries).toEqual([]);
  });
});
