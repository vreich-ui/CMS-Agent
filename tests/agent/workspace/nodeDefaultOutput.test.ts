import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, overrideRunNodeOutput, pushNodeThroughWithDefault, resetRun, retryNode, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { buildNodeDefaultOutput, DEFAULTED_UPSTREAM_GATE_ID, decideDefaultOutput, outputSourceWarning, writesToLiveClient } from "../../../src/agent/workspace/defaultOutput.js";
import { publishRun } from "../../../src/agent/workspace/publisher.js";
import { buildLearningObservations, buildNodeFacts } from "../../../src/agent/workspace/learningRecord.js";
import { WorkspaceToolError } from "../../../src/agent/workspace/workspaceErrors.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// node-default-output (2026-09-15) — acceptance for W1 (store + verbs) and W2 (executor).
//
// The property under test throughout: a node can be PASSED, with an output, without being RUN — and
// the record can always say which of the two happened, so nothing supplied can be published or learned
// from. Every assertion below is either "the value reached the run" or "the run refuses to lie".

const stubNode = { id: "research", outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } }, additionalProperties: true } };

describe("W1 — storing a default", () => {
  it("validates against the node's own outputSchema and stamps schemaValidAt", () => {
    const stored = buildNodeDefaultOutput({ node: stubNode, value: { summary: "a fixture" }, note: "cheap traversal", updatedBy: "human" });
    expect(stored.value).toEqual({ summary: "a fixture" });
    expect(stored.note).toBe("cheap traversal");
    expect(stored.updatedBy).toBe("human");
    expect(typeof stored.schemaValidAt).toBe("string");
    expect(Date.parse(stored.schemaValidAt as string)).not.toBeNaN();
  });

  it("REFUSES a schema-invalid value by name rather than storing it quietly", () => {
    expect(() => buildNodeDefaultOutput({ node: stubNode, value: { notSummary: 1 }, updatedBy: "human" }))
      .toThrowError(/default_output_schema_invalid|does not satisfy/);
    try {
      buildNodeDefaultOutput({ node: stubNode, value: { notSummary: 1 }, updatedBy: "human" });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceToolError);
      expect((error as WorkspaceToolError).code).toBe("default_output_schema_invalid");
      // The issues are named, so an operator fixes the value rather than guessing.
      expect(((error as WorkspaceToolError).details.issues as string[]).length).toBeGreaterThan(0);
    }
  });

  it("stores a schema-invalid value under force, and marks it schemaValidAt: null rather than pretending", () => {
    const forced = buildNodeDefaultOutput({ node: stubNode, value: { notSummary: 1 }, force: true, updatedBy: "human" });
    expect(forced.value).toEqual({ notSummary: 1 });
    expect(forced.schemaValidAt).toBeNull();
  });

  it("round-trips through the store, and `null` CLEARS rather than writing an empty row", async () => {
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.ensureWorkspaceNodeSeeds();
    const node = (await workspace.getNode("research"))!;
    const stored = buildNodeDefaultOutput({ node, value: { summary: "fixture" }, force: true, updatedBy: "human" });

    const set = await workspace.updateNodeDefaultOutput("research", stored, { actor: "default-output-test" });
    expect(set.node.defaultOutput?.value).toEqual({ summary: "fixture" });
    expect((await workspace.getNode("research"))?.defaultOutput?.updatedBy).toBe("human");

    const cleared = await workspace.updateNodeDefaultOutput("research", null, { actor: "default-output-test" });
    expect(cleared.node.defaultOutput).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(cleared.node, "defaultOutput")).toBe(false);
    expect((await workspace.getNode("research"))?.defaultOutput).toBeUndefined();
  });

  it("refuses a default on a node that does not exist, instead of inventing a row for it", async () => {
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.ensureWorkspaceNodeSeeds();
    await expect(workspace.updateNodeDefaultOutput("no_such_node", null, { actor: "default-output-test" }))
      .rejects.toThrowError(/Unknown node/);
  });
});

describe("W2 — which nodes a run passes through", () => {
  const withDefault = { defaultOutput: { value: { summary: "s" }, updatedAt: "2026-09-15T00:00:00.000Z", updatedBy: "human" as const } };
  const without = {};

  it("live mode never uses a default, even when one is set", () => {
    expect(decideDefaultOutput({ node: withDefault, outputMode: "live" }).action).toBe("dispatch");
  });

  it("defaults_where_set passes through what has a default and dispatches what does not", () => {
    expect(decideDefaultOutput({ node: withDefault, outputMode: "defaults_where_set" }).action).toBe("apply");
    expect(decideDefaultOutput({ node: without, outputMode: "defaults_where_set" }).action).toBe("dispatch");
  });

  it("defaults_only names the gaps instead of quietly running them live", () => {
    expect(decideDefaultOutput({ node: withDefault, outputMode: "defaults_only" }).action).toBe("apply");
    expect(decideDefaultOutput({ node: without, outputMode: "defaults_only" })).toEqual({ action: "refuse", reason: "missing" });
  });

  it("an explicit push-through refuses when there is no default — it never silently dispatches", () => {
    expect(decideDefaultOutput({ node: without, outputMode: "live", explicit: true })).toEqual({ action: "refuse", reason: "missing" });
    expect(decideDefaultOutput({ node: withDefault, outputMode: "live", explicit: true }).action).toBe("apply");
  });
});

// The end-to-end half. A mock run is used throughout: these assertions are about the ENGINE's
// bookkeeping (was a node passed, at what cost, with what provenance), and a mock run exercises every
// one of those paths without a provider call — which is also the state the guardrail deliberately lets
// through, so (c) below has to use a live-mode run to see the refusal at all.
const startMockRun = async (overrides: Parameters<typeof startDryRun>[0] extends infer T ? Partial<T> : never = {}) => {
  const store = new RepositoryManager().getExecutionRepository();
  const workspace = new RepositoryManager().getWorkspaceRepository();
  await workspace.ensureWorkspaceNodeSeeds();
  const run = await startDryRun({ projectId: "platform", input: "default output acceptance", executionMode: "mock", budgetUsd: 100, ...overrides }, store, workspace);
  return { store, workspace, run };
};

const setDefault = async (workspace: Awaited<ReturnType<typeof startMockRun>>["workspace"], nodeId: string, value: unknown) => {
  const node = (await workspace.getNode(nodeId))!;
  await workspace.updateNodeDefaultOutput(nodeId, buildNodeDefaultOutput({ node, value, force: true, updatedBy: "human", note: `fixture for ${nodeId}` }), { actor: "default-output-test" });
};

describe("W2 acceptance", () => {
  it("(a) run_node useDefaultOutput completes the node at zero cost and downstream reads the value", async () => {
    repositoryManager.getUsageRepository().clear();
    const { store, workspace, run } = await startMockRun();
    const first = run.currentNodeId!;
    await setDefault(workspace, first, { summary: "supplied, not produced", artifact: `${first}.v1` });

    const pushed = await pushNodeThroughWithDefault(run.runId, first, { executionRepository: store, workspaceRepository: workspace });
    const state = pushed.nodes.find((node) => node.nodeId === first)!;

    expect(state.status).toBe("completed");
    expect(state.durationMs).toBe(0);
    expect(state.outputProvenance).toMatchObject({ source: "default_output" });
    expect(state.warnings).toContain(outputSourceWarning("default_output"));
    // No model-execution provenance: producerContextForPublish must never mint a producer for a node
    // that did not run.
    expect(state.provenance).toBeUndefined();
    // The value is what a dependant reads.
    expect(pushed.stageOutputs[first]).toMatchObject({ summary: "supplied, not produced" });
    expect(pushed.defaultedNodeIds).toContain(first);
    expect(await repositoryManager.getUsageRepository().list({ runId: run.runId, nodeId: first })).toEqual([]);
  });

  it("(a2) refuses by name when the node has no default, rather than running it anyway", async () => {
    const { store, workspace, run } = await startMockRun();
    await expect(pushNodeThroughWithDefault(run.runId, run.currentNodeId!, { executionRepository: store, workspaceRepository: workspace }))
      .rejects.toMatchObject({ code: "default_output_missing" });
  });

  it("(b) a defaults_where_set run passes defaulted nodes through with no provider call", async () => {
    repositoryManager.getUsageRepository().clear();
    const { store, workspace, run } = await startMockRun({ outputMode: "defaults_where_set" });
    expect((await getRun(run.runId, store))!.outputMode).toBe("defaults_where_set");

    const first = run.currentNodeId!;
    await setDefault(workspace, first, { summary: "fixture", artifact: `${first}.v1` });

    const started = Date.now();
    const advanced = await runNextNode(run.runId, { executionRepository: store, workspaceRepository: workspace });
    const state = advanced.nodes.find((node) => node.nodeId === first)!;

    expect(state.status).toBe("completed");
    expect(state.durationMs).toBe(0);
    expect(state.outputProvenance?.source).toBe("default_output");
    expect(advanced.defaultedNodeIds).toEqual([first]);
    // The mode is what did it — there was no explicit push-through in this test at all.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await repositoryManager.getUsageRepository().list({ runId: run.runId, nodeId: first })).toEqual([]);
  });

  it("(b2) a defaults_only run FAILS the first node that has no default, naming the gap", async () => {
    const { store, workspace, run } = await startMockRun({ outputMode: "defaults_only" });
    const first = run.currentNodeId!;
    const advanced = await runNextNode(run.runId, { executionRepository: store, workspaceRepository: workspace });
    const state = advanced.nodes.find((node) => node.nodeId === first)!;
    expect(state.status).toBe("failed");
    expect(state.errors?.[0]).toBe("default_output_missing");
    expect(advanced.errors).toContain(`${first}:default_output_missing`);
  });

  it("(c) a LIVE run carrying a defaulted node is blocked at gate.publishing.defaulted_upstream", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.ensureWorkspaceNodeSeeds();
    const run = await startDryRun({ projectId: "platform", input: "guardrail", executionMode: "openai", budgetUsd: 100 }, store, workspace);

    // Mark an upstream node as supplied (the same stamp every supplied-output path writes) and put the
    // publishing tail in front of the dispatcher.
    const record = (await getRun(run.runId, store))!;
    const upstream = record.nodes[0].nodeId;
    await setDefault(workspace, upstream, { summary: "fixture" });
    await pushNodeThroughWithDefault(run.runId, upstream, { executionRepository: store, workspaceRepository: workspace });

    const armed = (await getRun(run.runId, store))!;
    expect(armed.defaultedNodeIds).toContain(upstream);

    // The push-through itself refuses on the tail of a live run — the strongest form of the same rule.
    await setDefault(workspace, "publication_controller", { artifact: "publication_decision.v1", summary: "go", decision: "go", blockers: [] });
    await expect(pushNodeThroughWithDefault(run.runId, "publication_controller", { executionRepository: store, workspaceRepository: workspace }))
      .rejects.toMatchObject({ code: "defaulted_upstream_blocked" });

    // And a dispatch that reaches the tail blocks there with the gate named on the node's own output.
    const ready = (await getRun(run.runId, store))!;
    for (const state of ready.nodes) {
      if (state.nodeId === "publication_controller" || state.status === "completed") continue;
      state.status = "completed";
      state.output = { seeded: true };
      ready.stageOutputs[state.nodeId] = { seeded: true };
    }
    const controller = ready.nodes.find((node) => node.nodeId === "publication_controller")!;
    controller.status = "queued";
    delete controller.output;
    ready.status = "queued";
    await store.saveRun(ready);

    const blocked = await runNextNode(run.runId, { executionRepository: store, workspaceRepository: workspace, approved: true });
    const gateState = blocked.nodes.find((node) => node.nodeId === "publication_controller")!;
    expect(gateState.status).toBe("blocked");
    expect((gateState.output as { gate?: string }).gate).toBe(DEFAULTED_UPSTREAM_GATE_ID);
    expect(gateState.warnings).toContain("defaulted_upstream_blocked");
    // NOT an approvable hold: no approval entry is raised, because no approval can clear it.
    expect(blocked.approvalsRequired.some((approval) => approval.nodeId === "publication_controller")).toBe(false);
    expect(blocked.status).toBe("blocked");
  });

  it("(c2) a MOCK run passes the tail with defaults on board — that is what a traversal is for", async () => {
    const { store, workspace, run } = await startMockRun();
    const upstream = run.currentNodeId!;
    await setDefault(workspace, upstream, { summary: "fixture" });
    await pushNodeThroughWithDefault(run.runId, upstream, { executionRepository: store, workspaceRepository: workspace });
    const record = (await getRun(run.runId, store))!;
    expect(record.defaultedNodeIds).toContain(upstream);
    expect(record.status).not.toBe("blocked");
  });

  it("(d) learning_recorder records nothing for defaulted nodes, and says so at run level", () => {
    const run = {
      runId: "run_defaulted_sample",
      status: "completed" as const,
      errors: [],
      approvalsRequired: [],
      stageOutputs: {},
      nodes: [
        { nodeId: "input_triage", status: "completed" as const, durationMs: 11 },
        { nodeId: "research", status: "completed" as const, durationMs: 0, warnings: [outputSourceWarning("default_output")], outputProvenance: { source: "default_output" as const, updatedAt: "2026-09-15T00:00:00.000Z" } },
        { nodeId: "draft_writer", status: "completed" as const, durationMs: 0, warnings: [outputSourceWarning("operator_override")], outputProvenance: { source: "operator_override" as const, updatedAt: "2026-09-15T00:00:00.000Z" } }
      ]
    } as unknown as WorkflowExecutionRecord;

    const facts = buildNodeFacts(run);
    expect(facts.map((fact) => fact.nodeId)).toEqual(["input_triage"]);

    const observations = buildLearningObservations({ run, usageError: "ledger not read in this test" });
    expect(observations.nodeFacts.map((fact) => fact.nodeId)).toEqual(["input_triage"]);
    // Excluded, but never silently: the run-level line names both nodes and both sources.
    const said = observations.observations.join(" ");
    expect(said).toContain("research [default_output]");
    expect(said).toContain("draft_writer [operator_override]");
    expect(said).toMatch(/did NOT produce their output/);
  });
});

describe("W3 — the operator override is the same write, from the other direction", () => {
  it("writes run.stageOutputs, stamps operator_override, and arms the publish guardrail", async () => {
    const { store, workspace, run } = await startMockRun();
    const nodeId = run.currentNodeId!;
    const result = await overrideRunNodeOutput(run.runId, nodeId, { summary: "the variant I prefer" }, { executionRepository: store, workspaceRepository: workspace, note: "pasted by hand" });

    const state = result.run.nodes.find((node) => node.nodeId === nodeId)!;
    expect(state.status).toBe("completed");
    expect(state.durationMs).toBe(0);
    expect(state.outputProvenance).toMatchObject({ source: "operator_override", note: "pasted by hand" });
    expect(result.run.stageOutputs[nodeId]).toEqual({ summary: "the variant I prefer" });
    expect(result.run.defaultedNodeIds).toContain(nodeId);
  });
});

// Adversarial review of the squashed diff, 2026-09-15. Each of these is a hole the first pass left
// open; the test is here so the fix cannot quietly regress.
describe("review findings — the ways a fixture could have reached a client", () => {
  it("workflow.publish_run refuses a run carrying a supplied output, not only the engine path", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.ensureWorkspaceNodeSeeds();
    const run = await startDryRun({ projectId: "platform", input: "publish_run bypass", executionMode: "openai", budgetUsd: 100 }, store, workspace);
    const upstream = (await getRun(run.runId, store))!.nodes[0].nodeId;
    await setDefault(workspace, upstream, { summary: "fixture" });
    await pushNodeThroughWithDefault(run.runId, upstream, { executionRepository: store, workspaceRepository: workspace });

    const result = await publishRun({ runId: run.runId, requestId: "req_dtc_fixture_20260915_01", live: true }, { executionRepository: store });
    expect(result.published).toBe(false);
    expect(result.mode).toBe("error");
    const error = (result as { error?: string }).error ?? "";
    expect(error).toContain(DEFAULTED_UPSTREAM_GATE_ID);
    expect(error).toContain(upstream);
  });

  it("the guard is semantic, not a tail id list: emission and publish/admin nodes are covered too", async () => {
    // capture_conductor's live emitter and clone_conductor's minters are kind "emission" and run
    // UPSTREAM of the publishing tail — a tail-only guard would refuse the publish long after the
    // pages existed on the client.
    expect(writesToLiveClient({ riskLevel: "write", kind: "emission" })).toBe(true);
    expect(writesToLiveClient({ riskLevel: "publish", kind: "gate" })).toBe(true);
    expect(writesToLiveClient({ riskLevel: "admin", kind: "materializer" })).toBe(true);
    expect(writesToLiveClient({ riskLevel: "write", kind: "publisher" })).toBe(true);
    expect(writesToLiveClient({ riskLevel: "write", kind: "releaser" })).toBe(true);
    expect(writesToLiveClient({ riskLevel: "write", kind: "writer" })).toBe(false);
    expect(writesToLiveClient({ riskLevel: "read", kind: "researcher" })).toBe(false);
  });

  it("an operator override cannot write publication_controller's own decision on a live run", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.ensureWorkspaceNodeSeeds();
    const run = await startDryRun({ projectId: "platform", input: "override the gate", executionMode: "openai", budgetUsd: 100 }, store, workspace);
    await expect(overrideRunNodeOutput(run.runId, "publication_controller", { artifact: "publication_decision.v1", decision: "go", blockers: [] }, { executionRepository: store, workspaceRepository: workspace }))
      .rejects.toMatchObject({ code: "defaulted_publish_node_refused" });
  });

  it("a supplied output DELETES the model-execution provenance it replaces", async () => {
    const { store, workspace, run } = await startMockRun();
    const nodeId = run.currentNodeId!;
    const record = (await getRun(run.runId, store))!;
    const state = record.nodes.find((node) => node.nodeId === nodeId)!;
    // A real turn happened first, and its identity is what producerContextForPublish would stamp on a
    // published object.
    state.provenance = { promptVersion: "prompt_sha256:deadbeef", model: "gpt-5.5", capturedAt: "2026-09-15T00:00:00.000Z" };
    state.status = "completed";
    await store.saveRun(record);

    const overridden = await overrideRunNodeOutput(run.runId, nodeId, { summary: "different text entirely" }, { executionRepository: store, workspaceRepository: workspace });
    expect(overridden.run.nodes.find((node) => node.nodeId === nodeId)!.provenance).toBeUndefined();
  });

  it("a plain retry on a defaults-mode run forces a live dispatch instead of re-applying the default", async () => {
    const { store, workspace, run } = await startMockRun({ outputMode: "defaults_where_set" });
    const nodeId = run.currentNodeId!;
    await setDefault(workspace, nodeId, { summary: "fixture" });

    const defaulted = await runNextNode(run.runId, { executionRepository: store, workspaceRepository: workspace });
    expect(defaulted.nodes.find((node) => node.nodeId === nodeId)!.outputProvenance?.source).toBe("default_output");

    const retried = await retryNode(run.runId, nodeId, { executionRepository: store, workspaceRepository: workspace });
    const state = retried!.nodes.find((node) => node.nodeId === nodeId)!;
    // The durable override survived the retry's own reset, so the advance that followed it dispatched
    // for real rather than handing the same fixture straight back.
    expect(state.defaultOutputOverride).toBe(true);
    expect(state.outputProvenance).toBeUndefined();
    expect(retried!.defaultedNodeIds ?? []).not.toContain(nodeId);
  });

  it("applying a value that no longer satisfies the node's schema warns on the record rather than passing silently", async () => {
    const { store, workspace, run } = await startMockRun();
    const nodeId = "research";
    const node = (await workspace.getNode(nodeId))!;
    await workspace.updateNodeDefaultOutput(nodeId, buildNodeDefaultOutput({ node, value: { definitely: "not the declared shape" }, force: true, updatedBy: "human" }), { actor: "default-output-test" });
    // Give the node a schema the value cannot satisfy, as a later schema edit would.
    await workspace.updateNodeSchema(nodeId, { type: "object", required: ["summary"], properties: { summary: { type: "string" } } }, { actor: "default-output-test" });

    const pushed = await pushNodeThroughWithDefault(run.runId, nodeId, { executionRepository: store, workspaceRepository: workspace });
    const state = pushed.nodes.find((candidate) => candidate.nodeId === nodeId)!;
    expect(state.warnings?.some((warning) => warning.startsWith("supplied_output_schema_invalid:"))).toBe(true);
  });
});

describe("undoing a supplied output", () => {
  it("a plain retry un-defaults the node, so the run can publish again", async () => {
    const { store, workspace, run } = await startMockRun();
    const nodeId = run.currentNodeId!;
    await setDefault(workspace, nodeId, { summary: "fixture" });
    await pushNodeThroughWithDefault(run.runId, nodeId, { executionRepository: store, workspaceRepository: workspace });
    expect((await getRun(run.runId, store))!.defaultedNodeIds).toContain(nodeId);

    await retryNode(run.runId, nodeId, { executionRepository: store, workspaceRepository: workspace });
    const retried = (await getRun(run.runId, store))!;
    expect(retried.defaultedNodeIds ?? []).not.toContain(nodeId);
    expect(retried.nodes.find((node) => node.nodeId === nodeId)!.outputProvenance).toBeUndefined();
  });

  it("a reset keeps the run's outputMode and drops the defaulted ledger", async () => {
    const { store, workspace, run } = await startMockRun({ outputMode: "defaults_where_set" });
    const nodeId = run.currentNodeId!;
    await setDefault(workspace, nodeId, { summary: "fixture" });
    await pushNodeThroughWithDefault(run.runId, nodeId, { executionRepository: store, workspaceRepository: workspace });

    const reset = await resetRun(run.runId, store);
    expect(reset.outputMode).toBe("defaults_where_set");
    expect(reset.defaultedNodeIds ?? []).toEqual([]);
  });
});
