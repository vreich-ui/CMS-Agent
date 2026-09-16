import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, incompleteAncestorsOf, pushNodeThroughWithDefault, resolveConductorNodes, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { buildNodeDefaultOutput } from "../../../src/agent/workspace/defaultOutput.js";
import { WorkspaceToolError } from "../../../src/agent/workspace/workspaceErrors.js";

// W4 — pushing through a node the run has not reached yet.
//
// Before this, a push-through on such a node wrote its output anyway and then advanced the run,
// which picked an UPSTREAM node next: coherent, but it reads as the run going backwards, and the
// operator's actual intention ("get me to this node") was never expressed. It is now the chain or
// an honest refusal that names the first node in the way.

const startRun = async (overrides: Record<string, unknown> = {}) => {
  const store = new RepositoryManager().getExecutionRepository();
  const workspace = new RepositoryManager().getWorkspaceRepository();
  await workspace.ensureWorkspaceNodeSeeds();
  const run = await startDryRun({ projectId: "platform", input: "w4 upstream chain", executionMode: "mock", budgetUsd: 100, ...overrides } as never, store, workspace);
  return { store, workspace, run };
};

const setDefault = async (workspace: Awaited<ReturnType<typeof startRun>>["workspace"], nodeId: string, value: unknown) => {
  const node = (await workspace.getNode(nodeId))!;
  await workspace.updateNodeDefaultOutput(nodeId, buildNodeDefaultOutput({ node, value, force: true, updatedBy: "human" }), { actor: "w4-test" });
};

/** A node with at least two incomplete ancestors, so the chain under test is a chain. */
const deepTarget = async (workspace: Awaited<ReturnType<typeof startRun>>["workspace"], runId: string, store: Awaited<ReturnType<typeof startRun>>["store"]) => {
  const record = (await getRun(runId, store))!;
  const nodes = await resolveConductorNodes(workspace, record.workflowId);
  for (const node of nodes) {
    const ancestors = incompleteAncestorsOf(record, nodes, node.id);
    if (ancestors.length >= 2 && ancestors.every((ancestor) => ancestor.riskLevel !== "publish" && ancestor.riskLevel !== "admin") && node.riskLevel !== "publish") {
      return { record, nodes, node, ancestors };
    }
  }
  throw new Error("no node in publishing_conductor has two non-publish incomplete ancestors");
};

describe("W4 — push-through over an incomplete upstream chain", () => {
  it("leaves the single-node push-through alone — it has always worked over incomplete upstream, and several gates are tested through it", async () => {
    const { store, workspace, run } = await startRun();
    const { node } = await deepTarget(workspace, run.runId, store);
    await setDefault(workspace, node.id, { pushed: node.id });

    // No `defaultUpstream`: this writes THIS node and lets the run advance through the upstream it
    // still owes, exactly as before W4. The new refusal is about the other intention, below.
    const after = await pushNodeThroughWithDefault(run.runId, node.id, { executionRepository: store, workspaceRepository: workspace });
    expect(after.nodes.find((state) => state.nodeId === node.id)?.outputProvenance?.source).toBe("default_output");
  });

  it("naming the FIRST node in the way rather than the whole list, when the chain is asked for and refused", async () => {
    const { store, workspace, run } = await startRun();
    const { node, ancestors } = await deepTarget(workspace, run.runId, store);
    await setDefault(workspace, node.id, { pushed: node.id });

    try {
      await pushNodeThroughWithDefault(run.runId, node.id, { executionRepository: store, workspaceRepository: workspace, defaultUpstream: true });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as WorkspaceToolError).code).toBe("upstream_incomplete");
      expect((error as WorkspaceToolError).details.blockingNodeId).toBe(ancestors[0].id);
      // The whole list is there for a client that wants to offer "default them all", but the
      // MESSAGE names one node, because one node is what the operator has to act on.
      expect((error as WorkspaceToolError).details.incompleteNodeIds).toContain(ancestors[0].id);
    }

    // Nothing was written: a refusal that half-applied would be worse than the behaviour it replaced.
    const after = (await getRun(run.runId, store))!;
    expect(after.nodes.find((state) => state.nodeId === node.id)?.status).toBe("queued");
  });

  it("refuses a chain on a run whose outputMode does not allow supplied outputs, even when asked", async () => {
    const { store, workspace, run } = await startRun();
    const { node } = await deepTarget(workspace, run.runId, store);
    await setDefault(workspace, node.id, { pushed: node.id });

    // `live` is the default mode. Asking for the chain does not make it permitted.
    await expect(pushNodeThroughWithDefault(run.runId, node.id, { executionRepository: store, workspaceRepository: workspace, defaultUpstream: true }))
      .rejects.toThrowError(/does not allow supplied outputs/);
  });

  it("defaults the whole chain, in dependency order, when the run's mode allows it", async () => {
    const { store, workspace, run } = await startRun({ outputMode: "defaults_where_set" });
    const { node, ancestors } = await deepTarget(workspace, run.runId, store);
    for (const ancestor of ancestors) await setDefault(workspace, ancestor.id, { pushed: ancestor.id });
    await setDefault(workspace, node.id, { pushed: node.id });

    await pushNodeThroughWithDefault(run.runId, node.id, { executionRepository: store, workspaceRepository: workspace, defaultUpstream: true });

    const after = (await getRun(run.runId, store))!;
    for (const ancestor of ancestors) {
      const state = after.nodes.find((entry) => entry.nodeId === ancestor.id);
      expect(state?.status, `${ancestor.id} should have been defaulted`).toBe("completed");
      expect(state?.outputProvenance?.source).toBe("default_output");
    }
    expect(after.nodes.find((entry) => entry.nodeId === node.id)?.status).toBe("completed");
    // Supplied, never produced — which is what keeps this run away from a live publish.
    expect(after.defaultedNodeIds).toEqual(expect.arrayContaining([node.id, ...ancestors.map((a) => a.id)]));
  });

  it("names the first node in the chain that has NO default, and writes nothing", async () => {
    const { store, workspace, run } = await startRun({ outputMode: "defaults_where_set" });
    const { node, ancestors } = await deepTarget(workspace, run.runId, store);
    // Every ancestor but the first gets one, so the refusal has to name the first.
    for (const ancestor of ancestors.slice(1)) await setDefault(workspace, ancestor.id, { pushed: ancestor.id });
    await setDefault(workspace, node.id, { pushed: node.id });

    try {
      await pushNodeThroughWithDefault(run.runId, node.id, { executionRepository: store, workspaceRepository: workspace, defaultUpstream: true });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as WorkspaceToolError).code).toBe("default_output_missing");
      expect((error as WorkspaceToolError).details.nodeId).toBe(ancestors[0].id);
    }

    const after = (await getRun(run.runId, store))!;
    for (const ancestor of ancestors) {
      expect(after.nodes.find((entry) => entry.nodeId === ancestor.id)?.status, `${ancestor.id} must not have been written`).toBe("queued");
    }
  });

  it("still pushes a node whose upstream IS complete, exactly as before", async () => {
    const { store, workspace, run } = await startRun();
    const record = (await getRun(run.runId, store))!;
    const first = record.nodes[0].nodeId;
    await setDefault(workspace, first, { pushed: first });
    const after = await pushNodeThroughWithDefault(run.runId, first, { executionRepository: store, workspaceRepository: workspace });
    expect(after.nodes.find((entry) => entry.nodeId === first)?.outputProvenance?.source).toBe("default_output");
  });
});

describe("W4 — a per-call output mode", () => {
  it("supplies defaults for THIS advance without ever persisting the mode onto the run", async () => {
    const { store, workspace, run } = await startRun();
    const record = (await getRun(run.runId, store))!;
    const first = record.nodes[0].nodeId;
    await setDefault(workspace, first, { pushed: first });

    const advanced = await runNextNode(run.runId, { executionRepository: store, workspaceRepository: workspace, outputMode: "defaults_where_set" });
    expect(advanced.nodes.find((entry) => entry.nodeId === first)?.outputProvenance?.source).toBe("default_output");
    // The RUN's own mode is untouched: a crash mid-drive must not leave a run permanently in a mode
    // nobody chose, and a concurrent driver must not inherit one.
    expect(advanced.outputMode ?? "live").toBe("live");
  });

  it("leaves the next advance alone once the override is gone", async () => {
    const { store, workspace, run } = await startRun();
    const record = (await getRun(run.runId, store))!;
    const [first, second] = record.nodes.map((entry) => entry.nodeId);
    await setDefault(workspace, first, { pushed: first });
    await setDefault(workspace, second, { pushed: second });

    await runNextNode(run.runId, { executionRepository: store, workspaceRepository: workspace, outputMode: "defaults_where_set" });
    const plain = await runNextNode(run.runId, { executionRepository: store, workspaceRepository: workspace });
    const secondState = plain.nodes.find((entry) => entry.nodeId === second);
    // Dispatched for real (mock mode), not supplied: the override did not outlive its call.
    expect(secondState?.outputProvenance).toBeUndefined();
  });
});
