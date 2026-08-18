import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { WorkspaceRepository } from "../../../src/agent/repository/interfaces/WorkspaceRepository.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { resolveEffectiveToolsForNode, resolvePolicySubjects } from "../../../src/agent/tools/toolResolver.js";
import { findCanonicalNodeById, resolveNodeForExecution } from "../../../src/agent/workspace/nodeResolution.js";
import { executeNode, getEffectivePrompt, prepareNodeExecution } from "../../../src/agent/workspace/nodeRuntime.js";
import { CAPTURE_AI_NODE_IDS, listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
// Imported for the registrations executor.ts performs (publishing_conductor + capture_conductor),
// exactly as every run-driving plane does.
import "../../../src/agent/workspace/executor.js";

// T12.15 — THE LIVE SYMPTOM this file exists to keep dead.
//
// T12.6's acceptance run (2026-08-18) halted with:
//
//     tool_error: Unknown node: block_classifier
//
// out of workflow.run_all. capture_conductor's three AI nodes — block_classifier, copy_regenerator,
// gap_adjudicator — are code-defined (captureConductorNodes.ts), registered through the §2.23 registry
// (captureConductorWorkflow.ts), and deliberately NOT seeded into the workspace store. Every per-node
// lookup on the execution path went straight to workspaceRepository.getNode(id) and threw on the miss:
// OpenAINodeRunner's resolveEffectiveToolsForNode (the throw the acceptance run actually hit, since it
// runs for any node with a non-empty allowedTools), toolExecutor's resolvePolicySubjects, and
// nodeRuntime's getEffectivePrompt / prepareNodeExecution / executeNode.
//
// The deterministic capture stages (metadata.captureStageDeterministic) were unaffected — the executor
// completes them before any of the above runs — and MockNodeRunner resolves no tools, which is why the
// T12.9 mock harness and every mock-mode test passed over the defect.
//
// The fix is a canonical FALLBACK (nodeResolution.ts), not a store seed: seeding is the "Workspace fix ≠
// fixed" trap scripts/seedNodesFromWorkspace.ts's header names, and resolveConductorNodes pins topology
// to the canonical definitions on purpose. A store record still WINS wherever one exists.

const storeStub = (nodes: WorkspaceNode[]): WorkspaceRepository => ({
  getNode: async (id: string) => nodes.find((node) => node.id === id)
} as unknown as WorkspaceRepository);

const captureNode = (id: string): WorkspaceNode => listCaptureConductorNodes().find((node) => node.id === id)!;

describe("T12.15 — capture_conductor's AI nodes resolve for execution without being seeded into the store", () => {
  it("premise: none of the three AI nodes is in the workspace store (this is intended, not a gap to seed)", async () => {
    const workspace = repositoryManager.getWorkspaceRepository();
    for (const nodeId of CAPTURE_AI_NODE_IDS) expect(await workspace.getNode(nodeId), nodeId).toBeUndefined();
  });

  // THE regression. Before the fix every one of these threw `Unknown node: <id>`.
  it.each([...CAPTURE_AI_NODE_IDS])("resolves %s from the registered workflow instead of throwing Unknown node", async (nodeId) => {
    const canonical = captureNode(nodeId);

    // The exact call OpenAINodeRunner makes for a node with a non-empty allowedTools — the live break.
    const tools = await resolveEffectiveToolsForNode(nodeId, { workflowId: "capture_conductor" });
    expect(tools.length).toBeGreaterThan(0);
    for (const grant of canonical.allowedTools) expect(tools.some((tool) => tool.toolId === grant), `${nodeId} grant ${grant}`).toBe(true);

    // ...and the three nodeRuntime entry points (node.get_effective_prompt / .prepare_execution / .execute).
    expect((await getEffectivePrompt(nodeId)).nodePrompt).toBe(canonical.prompt);
    const prepared = await prepareNodeExecution({ nodeId, input: {}, dependencyOutputs: Object.fromEntries(canonical.dependsOn.map((dependency) => [dependency, { artifact: `${dependency}.v1`, summary: "stub" }])) });
    expect((prepared.resolvedNode as WorkspaceNode).id).toBe(nodeId);
    expect(prepared.readinessStatus).toBe("ready");

    expect(await resolveNodeForExecution(nodeId, undefined, "capture_conductor")).toEqual(canonical);
  });

  it("executes block_classifier end to end through node.execute — the run that reported `Unknown node: block_classifier`", async () => {
    const repos = { workspaceRepository: repositoryManager.getWorkspaceRepository(), executionRepository: new RepositoryManager().getExecutionRepository() };
    const result = await executeNode({ nodeId: "block_classifier", input: {}, executionMode: "mock", dependencyOutputs: { capture_map: { artifact: "capture_map.v1", summary: "stub mapping" } } }, repos);
    const state = result.execution.nodes.find((node: { nodeId: string }) => node.nodeId === "block_classifier");
    expect(state?.status).toBe("completed");
    expect((state?.output as { artifact?: string })?.artifact).toBe("block_classification.v1");
  });

  it("restores the node's own allowedTools gate for tool calls (resolvePolicySubjects returned no node, silently disabling it)", async () => {
    const { node } = await resolvePolicySubjects("gap_adjudicator", undefined, "capture_conductor");
    expect(node?.id).toBe("gap_adjudicator");
    expect(node?.allowedTools).toEqual(captureNode("gap_adjudicator").allowedTools);
    // A tool the node does NOT grant is denied by name, which cannot happen while node is undefined.
    const tools = await resolveEffectiveToolsForNode("gap_adjudicator", { workflowId: "capture_conductor" });
    expect(tools.find((tool) => tool.toolId === "capture.emit")?.denialReasons).toContain("node_tool_not_allowed");
  });

  it("does not invent nodes: an id in neither the store nor any registered workflow still throws Unknown node", async () => {
    expect(findCanonicalNodeById("no_such_node_anywhere")).toBeUndefined();
    expect(await resolveNodeForExecution("no_such_node_anywhere")).toBeUndefined();
    expect(await resolveNodeForExecution("no_such_node_anywhere", undefined, "capture_conductor")).toBeUndefined();
    await expect(resolveEffectiveToolsForNode("no_such_node_anywhere")).rejects.toThrow("Unknown node: no_such_node_anywhere");
    await expect(getEffectivePrompt("no_such_node_anywhere")).rejects.toThrow("Unknown node: no_such_node_anywhere");
    await expect(prepareNodeExecution({ nodeId: "no_such_node_anywhere" })).rejects.toThrow("Unknown node: no_such_node_anywhere");
    await expect(executeNode({ nodeId: "no_such_node_anywhere" })).rejects.toThrow("Unknown node: no_such_node_anywhere");
  });

  it("is a FALLBACK, not a replacement: a store definition still overrides the canonical one for the same id", async () => {
    const stored: WorkspaceNode = { ...captureNode("block_classifier"), prompt: "STORE OVERLAY PROMPT", allowedTools: ["stage.get_output"] };
    const workspace = storeStub([stored]);

    expect(await resolveNodeForExecution("block_classifier", workspace, "capture_conductor")).toEqual(stored);
    expect((await getEffectivePrompt("block_classifier", workspace)).nodePrompt).toBe("STORE OVERLAY PROMPT");
    // The canonical definition is untouched by the overlay — it is still what an empty store resolves to.
    expect(await resolveNodeForExecution("block_classifier", storeStub([]), "capture_conductor")).toEqual(captureNode("block_classifier"));
  });

  it("keys the fallback on the run's workflowId: a registered workflow is searched alone", () => {
    // capture_conductor's nodes are not reachable through publishing_conductor's registry entry...
    expect(findCanonicalNodeById("block_classifier", "publishing_conductor")).toBeUndefined();
    expect(findCanonicalNodeById("block_classifier", "capture_conductor")?.id).toBe("block_classifier");
    // ...and an unregistered stamp searches every registered workflow, matching resolveConductorNodes'
    // rule that an unknown workflowId still resolves against the publishing_conductor canonical set.
    expect(findCanonicalNodeById("draft_writer", "some_legacy_stamp")?.id).toBe("draft_writer");
    expect(findCanonicalNodeById("block_classifier")?.id).toBe("block_classifier");
  });
});

describe("T12.15 — publishing_conductor resolution is unchanged", () => {
  it("resolves every publishing_conductor node from the STORE, byte-identically to the pre-change store-only lookup", async () => {
    const workspace = repositoryManager.getWorkspaceRepository();
    for (const canonical of listWorkspaceNodes()) {
      const storeRecord = await workspace.getNode(canonical.id);
      // The premise of "unchanged": every publishing node IS in the store, so the fallback never fires.
      expect(storeRecord, canonical.id).toBeDefined();
      expect(await resolveNodeForExecution(canonical.id), canonical.id).toEqual(storeRecord);
      expect(await resolveNodeForExecution(canonical.id, workspace, "publishing_conductor"), canonical.id).toEqual(storeRecord);
    }
  });

  it("keeps the store record winning even where it differs from the canonical definition", async () => {
    const canonical = listWorkspaceNodes()[0];
    const stored: WorkspaceNode = { ...canonical, prompt: "STORE WINS" };
    expect((await resolveNodeForExecution(canonical.id, storeStub([stored])))?.prompt).toBe("STORE WINS");
  });

  it("resolves a publishing_conductor node's effective tools and prompt exactly as the store defines them", async () => {
    const stored = (await repositoryManager.getWorkspaceRepository().getNode("draft_writer"))!;
    const { node } = await resolvePolicySubjects("draft_writer", undefined, "publishing_conductor");
    expect(node).toEqual(stored);
    expect((await getEffectivePrompt("draft_writer")).nodePrompt).toBe(stored.prompt);
    const tools = await resolveEffectiveToolsForNode("draft_writer", { workflowId: "publishing_conductor" });
    expect(tools).toEqual(await resolveEffectiveToolsForNode("draft_writer", {}, stored));
  });
});
