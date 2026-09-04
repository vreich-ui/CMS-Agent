import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { RUN_INPUT_FORWARDED_KEYS, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { registerWorkflow } from "../../../src/agent/workspace/workflowRegistry.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// D2 — imageStyle never reached brief_architect (or any other node with dependsOn) because
// state.input's `initialInput` field was threaded only to nodes with NO dependsOn (executor.ts,
// buildRunInput's call site). These tests exercise the real dispatch path — startDryRun + runNextNode
// — against a small, purpose-built 3-node DAG so the assertions do not ride on the shape of the real
// production workflow: node_a has no dependsOn, node_b depends on node_a, and node_c (the "third
// node") depends on node_b, matching the task's minimal repro shape.
//
// Registered once at module load, exactly like the production workflows in
// captureConductorWorkflow.ts/cloneConductorWorkflow.ts — registerWorkflow throws on a duplicate id,
// so this must not run inside beforeEach.
const WORKFLOW_ID = "d2_run_input_forwarding_test_workflow";

const baseNode = (overrides: Partial<WorkspaceNode>): WorkspaceNode => ({
  id: "unset",
  name: "unset",
  kind: "generic",
  description: "Test-only node for D2 run-input forwarding coverage.",
  prompt: "Do the thing.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  allowedTools: [],
  requiredInputs: [],
  produces: [],
  riskLevel: "read",
  dependsOn: [],
  status: "active",
  position: { x: 0, y: 0 },
  updatedAt: "2026-09-04T00:00:00.000Z",
  ...overrides
});

const NODES: WorkspaceNode[] = [
  baseNode({ id: "node_a", name: "Node A", dependsOn: [] }),
  baseNode({ id: "node_b", name: "Node B", dependsOn: ["node_a"] }),
  baseNode({ id: "node_c", name: "Node C", dependsOn: ["node_b"] })
];

registerWorkflow({ workflowId: WORKFLOW_ID, canonicalNodes: () => NODES.map((node) => ({ ...node })) });

describe("D2 — run-level input forwarding to dependent nodes", () => {
  it("forwards the whitelisted imageStyle to a dependent node while hiding a non-whitelisted field, and leaves the no-dependsOn node's initialInput untouched", async () => {
    // Sanity check on the whitelist itself, since the tests below only prove it operationally.
    expect(RUN_INPUT_FORWARDED_KEYS).toEqual(["imageStyle", "instructions"]);

    const store = new RepositoryManager().getExecutionRepository();
    const input = { imageStyle: "editorial-bw", instructions: "keep it tight", secretOperatorField: "do-not-leak" };
    const started = await startDryRun({ workflowId: WORKFLOW_ID, executionMode: "mock", projectId: "d2-test", input }, store);

    // node_a: no dependsOn. Requirement 2 — behaviour unchanged, it still gets the FULL initialInput
    // (including the non-whitelisted field) and no top-level forwarded copies.
    const afterA = await runNextNode(started.runId, { executionRepository: store });
    const nodeAState = afterA.nodes.find((node) => node.nodeId === "node_a")!;
    expect(nodeAState.status).toBe("completed");
    const nodeAInput = nodeAState.input as Record<string, unknown>;
    expect(nodeAInput.initialInput).toEqual(input);
    expect(nodeAInput.imageStyle).toBeUndefined();
    expect(nodeAInput.instructions).toBeUndefined();

    // node_b: depends on node_a.
    await runNextNode(started.runId, { executionRepository: store });

    // node_c: the "third node", depends on node_b — the exact shape D2 named as broken.
    const afterC = await runNextNode(started.runId, { executionRepository: store });
    const nodeCState = afterC.nodes.find((node) => node.nodeId === "node_c")!;
    expect(nodeCState.status).toBe("completed");
    const nodeCInput = nodeCState.input as Record<string, unknown>;

    // A dependent node gets no `initialInput` (unchanged executor behaviour) ...
    expect(nodeCInput.initialInput).toBeUndefined();
    // ... but DOES see the whitelisted imageStyle/instructions AT THE TOP LEVEL, which is where
    // brief_architect's own inputSchema declares them and where its prompt tells the model to look.
    // A nested wrapper would satisfy the executor and still leave the node reading a missing key.
    expect(nodeCInput.imageStyle).toBe("editorial-bw");
    expect(nodeCInput.instructions).toBe("keep it tight");
    // The whitelist is bounded, not a passthrough: the operator-only field never reaches the node.
    expect(nodeCInput).not.toHaveProperty("secretOperatorField");
    expect(JSON.stringify(nodeCInput)).not.toContain("do-not-leak");
  });

  it("forwards nothing for a dependent node when no whitelisted key is present in initialInput", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ workflowId: WORKFLOW_ID, executionMode: "mock", projectId: "d2-test", input: { secretOperatorField: "irrelevant" } }, store);

    await runNextNode(started.runId, { executionRepository: store });
    await runNextNode(started.runId, { executionRepository: store });
    const afterC = await runNextNode(started.runId, { executionRepository: store });
    const nodeCState = afterC.nodes.find((node) => node.nodeId === "node_c")!;
    const nodeCInput = nodeCState.input as Record<string, unknown>;

    // No `undefined` placeholders: the keys are absent altogether.
    expect(Object.prototype.hasOwnProperty.call(nodeCInput, "imageStyle")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nodeCInput, "instructions")).toBe(false);
    expect(JSON.stringify(nodeCInput)).not.toContain("irrelevant");
  });

  it("never lets the run envelope clobber a value the node's own input already carries", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    // The conductor owns `clientProjectId`; a run whose initialInput tried to forward a whitelisted
    // key must not be able to displace a conductor-owned field, and the forwarded keys are spread
    // FIRST precisely so the envelope's own values win.
    const started = await startDryRun({ workflowId: WORKFLOW_ID, executionMode: "mock", projectId: "d2-test", input: { imageStyle: "editorial-bw", clientProjectId: "someone-else" } }, store);
    await runNextNode(started.runId, { executionRepository: store });
    await runNextNode(started.runId, { executionRepository: store });
    const afterC = await runNextNode(started.runId, { executionRepository: store });
    const nodeCInput = afterC.nodes.find((node) => node.nodeId === "node_c")!.input as Record<string, unknown>;
    expect(nodeCInput.clientProjectId).toBe("d2-test");
    expect(nodeCInput.imageStyle).toBe("editorial-bw");
  });

  it("forwards nothing for a null, array, primitive, or explicitly-undefined initialInput", async () => {
    for (const input of [null, ["imageStyle"], "imageStyle", { imageStyle: undefined }] as unknown[]) {
      const store = new RepositoryManager().getExecutionRepository();
      const started = await startDryRun({ workflowId: WORKFLOW_ID, executionMode: "mock", projectId: "d2-test", input } as never, store);
      await runNextNode(started.runId, { executionRepository: store });
      await runNextNode(started.runId, { executionRepository: store });
      const afterC = await runNextNode(started.runId, { executionRepository: store });
      const nodeCInput = afterC.nodes.find((node) => node.nodeId === "node_c")!.input as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(nodeCInput, "imageStyle"), JSON.stringify(input)).toBe(false);
    }
  });
});
