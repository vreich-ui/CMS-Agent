import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import type { WorkspaceRepository } from "../../src/agent/repository/interfaces/WorkspaceRepository.js";
import type { WorkspaceNode } from "../../src/agent/workspace/nodeTypes.js";
import { listWorkspaceNodes } from "../../src/agent/workspace/nodes.js";
import { getRun, resolveConductorNodes, runNextNode, startDryRun, __test__ } from "../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../src/agent/runtime/repositories.js";

// Phase 5 (docs/platform/DIRECTION.md §5): the conductor resolves node definitions from the workspace
// store so optimizer-promoted prompts reach full conductor runs. These tests pin the default (static)
// behavior, prove promotions flow through in store mode, and prove the canonical-node guard keeps the
// conductor topology and publish-risk gates unchanged regardless of what the store holds.

// A minimal stub standing in for a WorkspaceRepository — resolveConductorNodes only calls getNodes().
const stubRepo = (getNodes: () => Promise<WorkspaceNode[]>): WorkspaceRepository => ({ getNodes } as unknown as WorkspaceRepository);

describe("WORKSPACE_NODES_SOURCE flag (nodeSource)", () => {
  afterEach(() => { delete process.env.WORKSPACE_NODES_SOURCE; });

  it("defaults to static and treats only 'store' (case/space-insensitive) as store", () => {
    delete process.env.WORKSPACE_NODES_SOURCE;
    expect(__test__.nodeSource()).toBe("static");
    process.env.WORKSPACE_NODES_SOURCE = "store"; expect(__test__.nodeSource()).toBe("store");
    process.env.WORKSPACE_NODES_SOURCE = "  STORE  "; expect(__test__.nodeSource()).toBe("store");
    process.env.WORKSPACE_NODES_SOURCE = "static"; expect(__test__.nodeSource()).toBe("static");
    process.env.WORKSPACE_NODES_SOURCE = "anything-else"; expect(__test__.nodeSource()).toBe("static");
  });
});

describe("resolveConductorNodes", () => {
  afterEach(() => { delete process.env.WORKSPACE_NODES_SOURCE; });

  it("returns the static definitions unchanged in the default (static) mode and never reads the store", async () => {
    delete process.env.WORKSPACE_NODES_SOURCE;
    let read = false;
    const resolved = await resolveConductorNodes(stubRepo(async () => { read = true; throw new Error("store must not be read in static mode"); }));
    expect(read).toBe(false);
    expect(resolved).toEqual(listWorkspaceNodes());
  });

  it("overlays store-owned execution fields (prompt/name/schemas/model config) in store mode", async () => {
    process.env.WORKSPACE_NODES_SOURCE = "store";
    const [first] = listWorkspaceNodes();
    const promoted: WorkspaceNode = { ...first, prompt: "PROMOTED PROMPT", name: "Promoted Name", modelConfig: { provider: "google", model: "gemini-3.1-flash-lite" } };
    const resolved = await resolveConductorNodes(stubRepo(async () => [promoted]));
    const node = resolved.find((n) => n.id === first.id)!;
    expect(node.prompt).toBe("PROMOTED PROMPT");
    expect(node.name).toBe("Promoted Name");
    expect(node.modelConfig).toEqual({ provider: "google", model: "gemini-3.1-flash-lite" });
  });

  it("pins the canonical topology and publish-risk gate even when the store node diverges (canonical guard)", async () => {
    process.env.WORKSPACE_NODES_SOURCE = "store";
    const canonical = listWorkspaceNodes();
    const dependent = canonical.find((n) => n.dependsOn.length > 0)!;
    const publishNode = canonical.find((n) => n.riskLevel === "publish" || n.riskLevel === "admin")!;
    const rogueDependent: WorkspaceNode = { ...dependent, dependsOn: ["ghost_node"], produces: ["rogue.artifact"], prompt: "P" };
    const downgradedPublish: WorkspaceNode = { ...publishNode, riskLevel: "read" };
    const resolved = await resolveConductorNodes(stubRepo(async () => [rogueDependent, downgradedPublish]));

    const d = resolved.find((n) => n.id === dependent.id)!;
    expect(d.dependsOn).toEqual(dependent.dependsOn); // topology stays canonical
    expect(d.produces).toEqual(dependent.produces);
    expect(d.prompt).toBe("P"); // ...but the prompt still overlays

    const p = resolved.find((n) => n.id === publishNode.id)!;
    expect(p.riskLevel).toBe(publishNode.riskLevel); // publish-risk gate can never be downgraded from the store
  });

  it("seeds a canonical node missing from the store from the static definition (late-stage seeding preserved)", async () => {
    process.env.WORKSPACE_NODES_SOURCE = "store";
    const resolved = await resolveConductorNodes(stubRepo(async () => []));
    expect(resolved).toEqual(listWorkspaceNodes());
  });

  it("falls back to the static definitions when the store read fails", async () => {
    process.env.WORKSPACE_NODES_SOURCE = "store";
    const resolved = await resolveConductorNodes(stubRepo(async () => { throw new Error("transient store error"); }));
    expect(resolved).toEqual(listWorkspaceNodes());
  });
});

describe("promoted prompts reach full conductor runs (store mode, integration)", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());
  afterEach(() => { delete process.env.WORKSPACE_NODES_SOURCE; });

  const triageInputTokens = async (runId: string): Promise<number> => {
    const records = await repositoryManager.getUsageRepository().list({ runId });
    return records.find((record) => record.nodeId === "input_triage")?.inputTokens ?? 0;
  };

  it("runs a promoted node prompt through the conductor in store mode, but ignores it in static mode", async () => {
    const rm = new RepositoryManager();
    const ws = rm.getWorkspaceRepository();
    const longPrompt = "PROMOTED_LESSON ".repeat(500); // ~8k chars -> clearly more input tokens than the canonical prompt
    await ws.updateNodePrompt("input_triage", longPrompt, { actor: "optimizer", reason: "phase5 promotion test" });

    // Static mode: the store promotion is NOT consulted, so the canonical (short) prompt runs.
    delete process.env.WORKSPACE_NODES_SOURCE;
    const staticStore = rm.getExecutionRepository();
    const staticRun = await startDryRun({ projectId: "dr-lurie", input: "x" }, staticStore, ws);
    await runNextNode(staticRun.runId, { executionRepository: staticStore, workspaceRepository: ws });
    const staticTokens = await triageInputTokens(staticRun.runId);

    // Store mode: the promoted prompt reaches the conductor's node execution.
    process.env.WORKSPACE_NODES_SOURCE = "store";
    const storeStore = rm.getExecutionRepository();
    const storeRun = await startDryRun({ projectId: "dr-lurie", input: "x" }, storeStore, ws);
    await runNextNode(storeRun.runId, { executionRepository: storeStore, workspaceRepository: ws });
    const storeTokens = await triageInputTokens(storeRun.runId);

    expect(storeTokens).toBeGreaterThan(1000);
    expect(staticTokens).toBeLessThan(storeTokens);
  });

  it("preserves identical run topology in store mode (guard end-to-end)", async () => {
    const rm = new RepositoryManager();
    const ws = rm.getWorkspaceRepository();
    process.env.WORKSPACE_NODES_SOURCE = "store";
    const store = rm.getExecutionRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "x" }, store, ws);
    const storeNodeIds = run.nodes.map((n) => n.nodeId);
    expect(storeNodeIds).toEqual(listWorkspaceNodes().map((n) => n.id));
    expect(run.currentNodeId).toBe("input_triage");
  });
});
