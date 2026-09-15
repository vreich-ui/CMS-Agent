import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { WorkspaceRepository } from "../../../src/agent/repository/interfaces/WorkspaceRepository.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { applyNonDispatchOutput, getRun, resolveConductorNodes, retryNode, runNextNode, startDryRun, __test__ } from "../../../src/agent/workspace/executor.js";
import { mergeNodeAdvance } from "../../../src/agent/workspace/nodeAdvanceSave.js";
import { runNodeInputForTest } from "../../../src/agent/mcp/workspace/tools.js";
import type { NodeExecutionState, WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { decideDefaultOutput, readNodeDefaultOutput, DEFAULT_OUTPUT_MISSING_CODE, DEFAULTED_UPSTREAM_GATE_ID } from "../../../src/agent/workspace/defaultOutput.js";
import { buildNodeDefaultOutput } from "../../../src/agent/mcp/workspace/defaultOutputTools.js";
import { buildNodeFacts, buildLearningObservations } from "../../../src/agent/workspace/learningRecord.js";

// W1/W2 acceptance. The claim under test is narrow and load-bearing: a node can be passed WITHOUT a
// model turn, downstream nodes read the value as if it had run, and nothing that used a fixture can
// ever publish live or be learned from.

// resolveConductorNodes only needs getNodes(); saveStageOutput is stubbed purely so the executor's
// best-effort stage-output mirror does not fill the test log with the failure it correctly tolerates.
const stubRepo = (nodes: WorkspaceNode[]): WorkspaceRepository => ({
  getNodes: async () => nodes,
  saveStageOutput: async (stage: string, value: unknown, id?: string) => ({ id: id ?? stage, stage, value, createdAt: new Date().toISOString() })
} as unknown as WorkspaceRepository);

// A store view of the canonical graph with `defaultOutput` set on the named nodes. Values are shaped
// to pass each node's own outputSchema where it has one; where it does not, any object does.
const storeWithDefaults = (defaults: Record<string, unknown>): WorkspaceRepository =>
  stubRepo(listWorkspaceNodes().map((node) =>
    Object.prototype.hasOwnProperty.call(defaults, node.id)
      ? { ...node, defaultOutput: { value: defaults[node.id], updatedAt: "2026-09-15T00:00:00.000Z", updatedBy: "human" as const, schemaValidAt: "2026-09-15T00:00:00.000Z" } }
      : node
  ));

describe("W1 — the stored default itself", () => {
  const [node] = listWorkspaceNodes();

  it("reads back a well-formed default and ignores a malformed one rather than throwing", () => {
    expect(readNodeDefaultOutput({ defaultOutput: { value: { a: 1 }, updatedAt: "2026-09-15T00:00:00.000Z", updatedBy: "human" } })?.value).toEqual({ a: 1 });
    // A row written by an older build, or hand-edited: absent, never an exception at dispatch time.
    expect(readNodeDefaultOutput({ defaultOutput: { value: 1 } })).toBeUndefined();
    expect(readNodeDefaultOutput({ defaultOutput: "nonsense" })).toBeUndefined();
    expect(readNodeDefaultOutput(undefined)).toBeUndefined();
  });

  it("treats a literal null value as a REAL default, not as a clear", () => {
    // The distinction the verb's `clear` flag exists for: a client that serializes an absent field as
    // null must not silently erase a default it meant to leave alone.
    expect(readNodeDefaultOutput({ defaultOutput: { value: null, updatedAt: "2026-09-15T00:00:00.000Z", updatedBy: "human" } })).toMatchObject({ value: null });
  });

  it("refuses a value that does not satisfy the node's output schema, and names the failing fields", () => {
    const built = buildNodeDefaultOutput(node, { definitely: "not this node's shape" }, { force: false, updatedBy: "human" });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.code).toBe("default_output_schema_invalid");
      expect(built.error.message).toMatch(/output schema/);
    }
  });

  it("stores a forced invalid value stamped schemaValidAt: null, and warns", () => {
    const built = buildNodeDefaultOutput(node, { definitely: "not this node's shape" }, { force: true, updatedBy: "human" });
    expect(built.ok).toBe(true);
    if (built.ok) {
      // null, not `false` and not a stale timestamp: the record shows it was never validated.
      expect(built.defaultOutput.schemaValidAt).toBeNull();
      expect(built.warnings[0]).toMatch(/^default_output_schema_invalid_forced/);
    }
  });

  it("is store-owned: overlayStoreNode carries it from the stored row like prompt", async () => {
    process.env.WORKSPACE_NODES_SOURCE = "store";
    const resolved = await resolveConductorNodes(storeWithDefaults({ [node.id]: { seeded: true } }));
    expect(readNodeDefaultOutput(resolved.find((candidate) => candidate.id === node.id))?.value).toEqual({ seeded: true });
    delete process.env.WORKSPACE_NODES_SOURCE;
  });
});

describe("W1 — decideDefaultOutput, the one place the three paths agree", () => {
  const withDefault = { defaultOutput: { value: { x: 1 }, updatedAt: "2026-09-15T00:00:00.000Z", updatedBy: "human" as const } };

  it("an explicit push-through applies a default even on a live-mode run", () => {
    expect(decideDefaultOutput(withDefault, { explicit: true, outputMode: "live" })).toMatchObject({ use: true, reason: "explicit" });
  });

  it("an explicit push-through on a node with NO default REFUSES — it never falls back to a dispatch", () => {
    // The whole point: asking to push a node through must never quietly cost a model turn.
    expect(decideDefaultOutput({}, { explicit: true, outputMode: "live" })).toMatchObject({ use: false, missing: true, reason: "explicit" });
  });

  it("defaults_where_set passes what is seeded and lets the rest run live", () => {
    expect(decideDefaultOutput(withDefault, { outputMode: "defaults_where_set" })).toMatchObject({ use: true, reason: "output_mode" });
    expect(decideDefaultOutput({}, { outputMode: "defaults_where_set" })).toEqual({ use: false });
  });

  it("defaults_only FAILS an unseeded node rather than running it live", () => {
    expect(decideDefaultOutput({}, { outputMode: "defaults_only" })).toMatchObject({ use: false, missing: true, reason: "output_mode" });
  });

  it("live mode touches nothing without an explicit flag", () => {
    expect(decideDefaultOutput(withDefault, { outputMode: "live" })).toEqual({ use: false });
    expect(decideDefaultOutput(withDefault, {})).toEqual({ use: false });
  });
});

describe("W2 — application paths through a real run", () => {
  let store: ExecutionRepository;
  beforeEach(() => {
    store = new RepositoryManager().getExecutionRepository();
    repositoryManager.getUsageRepository().clear();
    process.env.WORKSPACE_NODES_SOURCE = "store";
  });
  afterEach(() => { delete process.env.WORKSPACE_NODES_SOURCE; });

  // (a) run_node useDefaultOutput completes the node with 0 cost and downstream reads the value.
  it("(a) pushes a node through with zero duration, no usage record, and a readable value downstream", async () => {
    const seeded = { artifact: "input_triage.v1", pushedThrough: true };
    const workspaceRepository = storeWithDefaults({ input_triage: seeded });
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store, workspaceRepository);

    // PINNED to the node. An unpinned flag would apply to whatever this advance dispatches — which is
    // up to CONCURRENT_DISPATCH_LIMIT nodes, not one; the MCP layer refuses the unpinned shape outright.
    const advanced = await runNextNode(run.runId, { executionRepository: store, workspaceRepository, useDefaultOutput: true, useDefaultOutputNodeId: "input_triage" });
    const state = advanced.nodes.find((node) => node.nodeId === "input_triage")!;

    expect(state.status).toBe("completed");
    expect(state.durationMs).toBe(0);
    expect(state.outputProvenance).toMatchObject({ source: "default_output" });
    expect(state.warnings).toContain("output_source:default_output");
    // The value downstream nodes will actually read — the assertion that makes this a pass, not a skip.
    expect(advanced.stageOutputs.input_triage).toEqual(seeded);
    expect(advanced.defaultedNodeIds).toEqual(["input_triage"]);
    // No model was called, so the usage ledger has nothing for this run.
    const usage = repositoryManager.getUsageRepository();
    expect((await usage.list({ runId: run.runId })).length).toBe(0);
  });

  it("(a2) refuses by name when the node has no default, instead of dispatching it", async () => {
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store, storeWithDefaults({}));
    const advanced = await runNextNode(run.runId, { executionRepository: store, workspaceRepository: storeWithDefaults({}), useDefaultOutput: true, useDefaultOutputNodeId: "input_triage" });
    const state = advanced.nodes.find((node) => node.nodeId === "input_triage")!;

    expect(state.status).toBe("failed");
    expect(state.errors?.[0]).toBe(DEFAULT_OUTPUT_MISSING_CODE);
    expect(advanced.stageOutputs.input_triage).toBeUndefined();
    expect(advanced.defaultedNodeIds ?? []).toEqual([]);
  });

  // (b) defaults_only over the whole conductor completes fast with no provider call.
  it("(b) runs the whole publishing conductor on defaults in seconds with no provider call", async () => {
    const nodes = listWorkspaceNodes();
    const defaults = Object.fromEntries(nodes.map((node) => [node.id, { artifact: node.produces[0] ?? `${node.id}.v1`, seeded: true }]));
    const workspaceRepository = storeWithDefaults(defaults);
    const started = Date.now();
    let run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this", outputMode: "defaults_only" }, store, workspaceRepository);
    expect(run.outputMode).toBe("defaults_only");

    for (let i = 0; i < nodes.length + 5 && !["completed", "failed", "blocked"].includes(run.status); i++) {
      run = await runNextNode(run.runId, { executionRepository: store, workspaceRepository });
    }

    expect(Date.now() - started).toBeLessThan(5_000);
    // Every node that ran did so from its default — no dispatch anywhere in the run.
    const completed = run.nodes.filter((node) => node.status === "completed");
    expect(completed.length).toBeGreaterThan(0);
    for (const node of completed) expect(node.outputProvenance?.source).toBe("default_output");
    expect((await repositoryManager.getUsageRepository().list({ runId: run.runId })).length).toBe(0);
  });

  it("(b2) defaults_only fails the first unseeded node rather than silently running it live", async () => {
    // input_triage seeded, placement_resolver deliberately not.
    const workspaceRepository = storeWithDefaults({ input_triage: { artifact: "input_triage.v1", seeded: true } });
    let run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this", outputMode: "defaults_only" }, store, workspaceRepository);
    run = await runNextNode(run.runId, { executionRepository: store, workspaceRepository });
    run = await runNextNode(run.runId, { executionRepository: store, workspaceRepository });

    expect(run.status).toBe("failed");
    expect(run.errors.some((error) => error.endsWith(`:${DEFAULT_OUTPUT_MISSING_CODE}`))).toBe(true);
  });

  // (c) a live-publish run with a defaulted upstream blocks at the gate.
  it("(c) blocks a LIVE run at gate.publishing.defaulted_upstream when anything upstream was defaulted", async () => {
    const nodes = listWorkspaceNodes();
    const publishRisk = nodes.find((node) => node.riskLevel === "publish" || node.riskLevel === "admin")!;
    const workspaceRepository = storeWithDefaults(Object.fromEntries(nodes.map((node) => [node.id, { artifact: node.produces[0] ?? `${node.id}.v1`, seeded: true }])));
    // executionMode "openai" is what makes a run live — run.dryRun is `true` on every record and names
    // the workflow family, not the mode.
    let run = await startDryRun({ executionMode: "openai", projectId: "project-a", input: "Draft this", outputMode: "defaults_where_set" }, store, workspaceRepository);

    for (let i = 0; i < nodes.length + 5 && !["completed", "failed", "blocked"].includes(run.status); i++) {
      run = await runNextNode(run.runId, { executionRepository: store, workspaceRepository });
    }

    expect(run.status).toBe("blocked");
    const blockedAtGate = run.nodes.find((node) => (node.warnings ?? []).includes(`gate_blocked:${DEFAULTED_UPSTREAM_GATE_ID}`));
    expect(blockedAtGate).toBeDefined();
    expect((blockedAtGate!.output as Record<string, unknown>).gateId).toBe(DEFAULTED_UPSTREAM_GATE_ID);
    // Nothing was published, and the gate names the fixtures that caused it.
    expect(blockedAtGate!.warnings).toContain("no_publication_performed");
    expect(publishRisk).toBeDefined();
  });

  it("(c2) the same run in DRY RUN mode is not gated — exercising the pipeline on fixtures is the point", async () => {
    const nodes = listWorkspaceNodes();
    const workspaceRepository = storeWithDefaults(Object.fromEntries(nodes.map((node) => [node.id, { artifact: node.produces[0] ?? `${node.id}.v1`, seeded: true }])));
    let run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this", outputMode: "defaults_only" }, store, workspaceRepository);
    for (let i = 0; i < nodes.length + 5 && !["completed", "failed", "blocked"].includes(run.status); i++) {
      run = await runNextNode(run.runId, { executionRepository: store, workspaceRepository });
    }
    expect(run.nodes.some((node) => (node.warnings ?? []).includes(`gate_blocked:${DEFAULTED_UPSTREAM_GATE_ID}`))).toBe(false);
  });

  // (d) the learning recorder writes nothing for defaulted nodes, and says so.
  it("(d) excludes defaulted nodes from the learning record and discloses the omission", () => {
    const run = {
      runId: "run_test",
      status: "completed" as const,
      nodes: [
        { nodeId: "input_triage", status: "completed" as const, durationMs: 0 },
        { nodeId: "brief_architect", status: "completed" as const, durationMs: 1200 }
      ],
      stageOutputs: {},
      approvalsRequired: [],
      errors: [],
      defaultedNodeIds: ["input_triage"]
    };

    const facts = buildNodeFacts(run);
    expect(facts.map((fact) => fact.nodeId)).toEqual(["brief_architect"]);

    const record = buildLearningObservations({ run });
    expect(record.defaultedNodeIds).toEqual(["input_triage"]);
    // The omission is STATED — a reader must never have to infer it from a short nodeFacts array.
    expect(record.observations[0]).toMatch(/completed from a stored default output or an operator override/);
    expect(record.observations[0]).toContain("input_triage");
  });

  it("(d2) a run with no defaults produces a byte-identical record shape to before the feature", () => {
    const run = { runId: "run_test", status: "completed" as const, nodes: [{ nodeId: "brief_architect", status: "completed" as const }], stageOutputs: {}, approvalsRequired: [], errors: [] };
    const record = buildLearningObservations({ run });
    expect(record).not.toHaveProperty("defaultedNodeIds");
  });

  it("retrying a defaulted node un-marks it, so the publish gate can actually be cleared", async () => {
    const workspaceRepository = storeWithDefaults({ input_triage: { artifact: "input_triage.v1", seeded: true } });
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store, workspaceRepository);
    let advanced = await runNextNode(run.runId, { executionRepository: store, workspaceRepository, useDefaultOutput: true, useDefaultOutputNodeId: "input_triage" });
    expect(advanced.defaultedNodeIds).toEqual(["input_triage"]);

    // A plain retry re-dispatches the node for real; the fixture no longer contributed anything, so the
    // mark goes with it. A gate that could never be cleared would not be a gate.
    advanced = (await retryNode(run.runId, "input_triage", { executionRepository: store, workspaceRepository }))!;
    expect(advanced.defaultedNodeIds ?? []).toEqual([]);
    expect(advanced.nodes.find((node) => node.nodeId === "input_triage")?.outputProvenance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// REVIEW FIXES — each of these covers a hole an adversarial read of the first cut found, where the
// fixture content was kept and the MARK that makes it safe was not. They are the tests that would
// have failed before those fixes, so they are worth more than the happy paths above.
// ---------------------------------------------------------------------------------------------

describe("W2 — the mark survives every save path", () => {
  it("an unpinned push-through is refused at the MCP layer, not silently applied to a whole batch", () => {
    // An advance dispatches up to CONCURRENT_DISPATCH_LIMIT nodes, and nodeId is optional on both
    // run_node and retry_node, so an unpinned flag defaulted every batch member with a default AND
    // hard-failed every member without one — on nodes nobody named.
    const parsed = runNodeInputForTest.safeParse({ runId: "run_x", useDefaultOutput: true });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/useDefaultOutput requires nodeId/);
    expect(runNodeInputForTest.safeParse({ runId: "run_x", nodeId: "research", useDefaultOutput: true }).success).toBe(true);
    // The flag is optional, so every existing caller is untouched.
    expect(runNodeInputForTest.safeParse({ runId: "run_x" }).success).toBe(true);
  });

  it("the executor applies a default ONLY to the pinned node, never to an unpinned advance", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const workspaceRepository = storeWithDefaults({ input_triage: { artifact: "input_triage.v1", seeded: true } });
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store, workspaceRepository);
    // Flag set, nothing pinned: the node runs for real rather than being satisfied from its default.
    const advanced = await runNextNode(run.runId, { executionRepository: store, workspaceRepository, useDefaultOutput: true });
    expect(advanced.nodes.find((node) => node.nodeId === "input_triage")?.outputProvenance).toBeUndefined();
    expect(advanced.defaultedNodeIds ?? []).toEqual([]);
  });

  it("mergeNodeAdvance UNIONS the ledger rather than letting either side erase it", () => {
    // The CAS merge listed its fields explicitly and did not list this one, so a conflicting write
    // restored the stored (older) ledger while keeping the advance's fixture stageOutputs — fixture
    // content with an empty mark, the exact state the publish gate reads to refuse.
    const base = { nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {} } as unknown as WorkflowExecutionRecord;
    const stored = { ...base, defaultedNodeIds: ["a"] } as WorkflowExecutionRecord;
    const advanced = { ...base, defaultedNodeIds: ["b"] } as WorkflowExecutionRecord;
    expect(mergeNodeAdvance(stored, advanced, []).defaultedNodeIds).toEqual(["a", "b"]);
    // Absent on both sides stays absent — an ordinary run's record is byte-for-byte unchanged.
    expect(mergeNodeAdvance(base, base, [])).not.toHaveProperty("defaultedNodeIds");
  });

  it("a node about to be defaulted is excluded from the concurrent batch", async () => {
    // Run-level writes do not survive the batch reconciler's clone-and-copy-back; this is the same
    // exclusion wouldSkipBeforeDispatch already gets, for the same reason.
    process.env.WORKSPACE_NODES_SOURCE = "store";
    const nodes = listWorkspaceNodes();
    const reviewers = ["human_texture", "trust_factual", "emotional_resonance", "reader_simulation"];
    const withDefaults = nodes.map((node) =>
      reviewers.includes(node.id)
        ? { ...node, defaultOutput: { value: { artifact: node.produces[0] ?? `${node.id}.v1` }, updatedAt: "2026-09-15T00:00:00.000Z", updatedBy: "human" as const } }
        : node
    );
    // A real enough record: the eligibility predicate also consults the skip predicates, which read
    // initialInput/stageOutputs/economicDecision.
    const run = { outputMode: "defaults_where_set", initialInput: {}, stageOutputs: {}, nodes: [], errors: [], artifacts: [], approvalsRequired: [] } as unknown as WorkflowExecutionRecord;
    for (const id of reviewers) {
      expect(__test__.isConcurrentDispatchEligible(run, withDefaults.find((node) => node.id === id)!)).toBe(false);
    }
    // A node with no default in the same mode is still eligible — the exclusion is about the default,
    // not about the mode.
    expect(__test__.isConcurrentDispatchEligible(run, withDefaults.find((node) => node.id === "research")!)).toBe(true);
    delete process.env.WORKSPACE_NODES_SOURCE;
  });

  it("overriding an already-completed node supersedes its artifact instead of leaving two", () => {
    const node = listWorkspaceNodes()[0];
    const run = {
      runId: "run_x", stageOutputs: {}, errors: [], approvalsRequired: [],
      artifacts: [{ id: "artifact_old", nodeId: node.id, type: "x", value: { real: true }, createdAt: "2026-09-15T00:00:00.000Z" }],
      nodes: []
    } as unknown as WorkflowExecutionRecord;
    const state = { nodeId: node.id, status: "completed" } as NodeExecutionState;
    applyNonDispatchOutput(run, node, state, { fixture: true }, { source: "operator_override", updatedAt: "2026-09-15T00:00:00.000Z" });
    // One artifact per completed node — the contract every downstream reader of run.artifacts relies
    // on, and the one a stale real output sitting beside its replacement would break.
    expect(run.artifacts.filter((artifact) => artifact.nodeId === node.id)).toHaveLength(1);
    expect(run.artifacts[0].value).toEqual({ fixture: true });
  });
});
