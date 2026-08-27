// Pass 2 / Track B4 + B2 regression coverage.
//
// B4 — live capture against the production Cloud Run workspace found that node.list_executions
// (with nodeId), node.get_latest_output (with nodeId), and constellation.get_attention (every
// call) all fail at the JSON-RPC transport layer with a proxy-level "-32600 Invalid content from
// server" error. Root cause: three unguarded reads of always-declared-but-not-always-present
// WorkflowExecutionRecord array fields —
//   - nodeRuntime.ts's old listNodeExecutions did `run.nodes.some(...)` whenever a `nodeId` filter
//     was supplied (the predicate's `!filters.nodeId ||` short-circuit meant a runId-only call
//     never touched `.nodes` at all, which is exactly why "runId alone" was the one shape that
//     worked live) — a run record without a populated `.nodes` array throws a bare TypeError.
//   - constellationMetrics.ts's buildAttentionItems did `run.errors.map(...)` /
//     `run.approvalsRequired.filter(...)` UNCONDITIONALLY for every run in the workspace on every
//     call (no filter can skip it), which is exactly why get_attention failed 100% of the time
//     regardless of args.
// Both crash sites are demonstrated below by seeding a legacy-shaped run record directly through
// the repository (bypassing the type-checked construction helpers, exactly the way a record
// written before a field existed — or partially written by a migration — would look at runtime).
// The fix makes every one of these reads `?? []`-defensive so a single malformed record can never
// take down a workspace-wide read tool; the three-verb envelope stays well-formed (a `content`
// array of valid text blocks plus a `structuredContent: {ok, data}` mirror) whether or not any
// runs, executions, or attention items exist.
//
// B2 — node.list_executions used to hand back `{executions: [<the whole run record>]}` (identical
// shape to workflow_get_run's `data.run`), not a per-node execution list. It now returns one
// compact entry per node-execution, joined from data that already exists (run.nodes[]'s own
// startedAt/completedAt/durationMs, plus persisted usage records for cost/tokens) — never invented.
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

// Asserts the exact well-formed MCP CallToolResult envelope shape: a `content` array whose blocks
// are all valid text blocks (a real string `text`, never a dropped/undefined key), plus a
// `structuredContent: {ok, data}` mirror that round-trips through the stringified text.
const expectWellFormedEnvelope = (response: any) => {
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  expect(Array.isArray(response.result.content)).toBe(true);
  expect(response.result.content.length).toBeGreaterThan(0);
  for (const block of response.result.content) {
    expect(block.type).toBe("text");
    expect(typeof block.text).toBe("string");
  }
  expect(response.result.structuredContent).toBeTypeOf("object");
  expect(response.result.structuredContent.ok).toBe(true);
  expect(response.result.structuredContent.data).toBeTypeOf("object");
  // The text block must be exactly the stringified structuredContent, not a stale/partial mirror.
  expect(JSON.parse(response.result.content[0].text)).toEqual(response.result.structuredContent);
};

// A run record shaped the way a pre-schema-evolution or partially-written record could be: the
// fields WorkflowExecutionRecord declares as always-present (`nodes`, `errors`,
// `approvalsRequired`) are simply absent. `as unknown as WorkflowExecutionRecord` mirrors how this
// arrives at runtime — through untyped JSON off the store, never validated against the type.
const malformedRun = (runId: string): WorkflowExecutionRecord =>
  ({
    runId,
    workflowId: "publishing_conductor",
    projectId: "dr-lurie",
    status: "failed",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [],
    stageOutputs: {},
    dryRun: true
    // nodes, errors, approvalsRequired: deliberately omitted.
  }) as unknown as WorkflowExecutionRecord;

describe("node/constellation MCP envelope hardening (Pass 2 Track B4)", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("node.list_executions({nodeId}) does not crash on a run record missing .nodes", async () => {
    await repositoryManager.getExecutionRepository().createRun(malformedRun("run_malformed_a"));
    const response = await call("node.list_executions", { nodeId: "draft_writer" });
    expectWellFormedEnvelope(response);
    expect(response.result.structuredContent.data.executions).toEqual([]);
  });

  it("node.get_latest_output({nodeId}) does not crash on a run record missing .nodes/.artifacts", async () => {
    await repositoryManager.getExecutionRepository().createRun(malformedRun("run_malformed_b"));
    const response = await call("node.get_latest_output", { nodeId: "draft_writer" });
    expectWellFormedEnvelope(response);
    expect(response.result.structuredContent.data.output).toBeNull();
  });

  it("constellation.get_attention({}) does not crash on a run record missing .errors/.approvalsRequired", async () => {
    await repositoryManager.getExecutionRepository().createRun(malformedRun("run_malformed_c"));
    const response = await call("constellation.get_attention", {});
    expectWellFormedEnvelope(response);
    expect(Array.isArray(response.result.structuredContent.data.items)).toBe(true);
  });

  it("constellation.get_attention still reports a real failed-run item once the malformed record is skipped", async () => {
    // The defensive `?? []` degrades ONLY the one record that can't support it — a legitimate,
    // fully-shaped failed run alongside it must still be reported.
    await repositoryManager.getExecutionRepository().createRun(malformedRun("run_malformed_d"));
    await repositoryManager.getExecutionRepository().createRun({
      runId: "run_real_failed",
      workflowId: "publishing_conductor",
      projectId: "dr-lurie",
      status: "failed",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [],
      artifacts: [],
      errors: ["draft_writer:model_error"],
      approvalsRequired: [],
      stageOutputs: {},
      dryRun: true
    });
    const items = (await data("constellation.get_attention")).items;
    expect(items.some((item: { id: string }) => item.id === "attn_run_failed_run_real_failed")).toBe(true);
  });

  describe("empty-result envelope shape (no runs/executions/attention items exist)", () => {
    it("node.list_executions returns a well-formed envelope with executions: []", async () => {
      const response = await call("node.list_executions", { nodeId: "no_such_node" });
      expectWellFormedEnvelope(response);
      expect(response.result.structuredContent.data).toEqual({ executions: [] });
    });

    it("node.get_latest_output returns a well-formed envelope with output: null", async () => {
      const response = await call("node.get_latest_output", { nodeId: "no_such_node" });
      expectWellFormedEnvelope(response);
      expect(response.result.structuredContent.data).toEqual({ output: null });
    });

    it("constellation.get_attention returns a well-formed envelope with items: []", async () => {
      // No runs, no relationships, no unconfigured active projects (env vars unset in this test
      // process would otherwise mint attn_project_unconfigured_* items) — clear those env vars so
      // this specifically exercises the true-empty path.
      for (const key of Object.keys(process.env)) if (key.endsWith("_MCP_ENDPOINT") || key.endsWith("_MCP_TOKEN")) delete process.env[key];
      const response = await call("constellation.get_attention", {});
      expectWellFormedEnvelope(response);
      expect(Array.isArray(response.result.structuredContent.data.items)).toBe(true);
    });
  });
});

describe("node.list_executions returns real per-node executions (Pass 2 Track B2)", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("returns compact per-node entries, not the whole run record", async () => {
    const executed = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    const runId = executed.execution.runId;

    const byRunId = (await data("node.list_executions", { runId })).executions;
    expect(byRunId).toHaveLength(1);
    const entry = byRunId[0];
    expect(entry.runId).toBe(runId);
    expect(entry.nodeId).toBe("input_triage");
    expect(entry.status).toBe("completed");
    expect(typeof entry.startedAt).toBe("string");
    expect(typeof entry.completedAt).toBe("string");
    expect(typeof entry.durationMs).toBe("number");
    // The old bug returned the whole run record under this key — assert the new shape does NOT
    // carry run-level fields like `nodes`/`artifacts`/`stageOutputs`.
    expect(entry.nodes).toBeUndefined();
    expect(entry.artifacts).toBeUndefined();
    expect(entry.stageOutputs).toBeUndefined();

    const byNodeId = (await data("node.list_executions", { nodeId: "input_triage" })).executions;
    expect(byNodeId.some((e: { runId: string }) => e.runId === runId)).toBe(true);

    const byBoth = (await data("node.list_executions", { nodeId: "input_triage", runId })).executions;
    expect(byBoth).toEqual(byRunId);
  });

  it("nodeId alone spans every run that touched that node, and never matches a run that didn't", async () => {
    const first = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    const second = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    const executions = (await data("node.list_executions", { nodeId: "input_triage" })).executions;
    const runIds = executions.map((e: { runId: string }) => e.runId);
    expect(runIds).toContain(first.execution.runId);
    expect(runIds).toContain(second.execution.runId);
    expect(executions.every((e: { nodeId: string }) => e.nodeId === "input_triage")).toBe(true);
  });

  it("both nodeId and runId narrows to that node in that run, empty when the node never ran there", async () => {
    const executed = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    const narrowed = (await data("node.list_executions", { nodeId: "topic_opportunity", runId: executed.execution.runId })).executions;
    expect(narrowed).toEqual([]);
  });

  it("joins cost/token figures from usage records already persisted for that run+node", async () => {
    const executed = await data("node.execute", { nodeId: "input_triage", input: {}, executionMode: "mock" });
    const runId = executed.execution.runId;
    const usageRecords = (await data("usage.list_records", { runId })).records;
    expect(usageRecords.length).toBeGreaterThan(0);

    const entry = (await data("node.list_executions", { runId })).executions[0];
    const expectedCost = usageRecords.reduce((sum: number, r: { costUsdEstimate: number }) => sum + r.costUsdEstimate, 0);
    const expectedIn = usageRecords.reduce((sum: number, r: { inputTokens: number }) => sum + r.inputTokens, 0);
    const expectedOut = usageRecords.reduce((sum: number, r: { outputTokens: number }) => sum + r.outputTokens, 0);
    expect(entry.costUsd).toBeCloseTo(expectedCost, 6);
    expect(entry.tokensIn).toBe(expectedIn);
    expect(entry.tokensOut).toBe(expectedOut);
  });
});
