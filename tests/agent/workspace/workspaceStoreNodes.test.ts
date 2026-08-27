import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { captureConductorNodes, listCaptureConductorNodes } from "../../../src/agent/workspace/captureConductorNodes.js";
import { cloneConductorNodes, listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { workspaceStoreCanonicalIds, workspaceStoreSeedNodes } from "../../../src/agent/workspace/workspaceStoreNodes.js";
import { createDefaultWorkspaceDocument, InMemoryWorkspaceStore } from "../../../src/agent/mcp/workspace/store.js";
import { MemoryWorkspaceRepository } from "../../../src/agent/repository/memory/MemoryWorkspaceRepository.js";

// T15.16 (#195) — capture_conductor's and clone_conductor's own nodes are governance-visible through
// the workspace.* store surface, the same way publishing_conductor's are, without becoming part of
// publishing_conductor's own canonical array (nodes.ts is untouched by this file's assertions).

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const structured = (res: any) => res.result?.structuredContent;

describe("workspaceStoreSeedNodes — the store's governance-visible union", () => {
  it("unions publishing (24) + capture_conductor's own upstream (11) + clone_conductor's own upstream (13) with zero collisions", () => {
    const seed = workspaceStoreSeedNodes();
    expect(seed).toHaveLength(listWorkspaceNodes().length + captureConductorNodes.length + cloneConductorNodes.length);
    const ids = seed.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["block_classifier", "capture_crawl", "capture_report", "clone_intake", "recipe_designer", "clone_report"]));
  });

  it("never carries capture/clone's tail-composed copies — publish_payload etc. appear exactly once, in publishing's own canonical form", () => {
    const seed = workspaceStoreSeedNodes();
    const publishPayloadRows = seed.filter((node) => node.id === "publish_payload");
    expect(publishPayloadRows).toHaveLength(1);
    // Publishing's own tail form, never capture's ([capture_emit_live, capture_score]) or clone's
    // ([recipe_mint, theme_bind, layout_restamp]) rebinding.
    expect(publishPayloadRows[0].dependsOn).toEqual(["article_body", "artifact_plan"]);
  });

  it("workspaceStoreCanonicalIds matches the seed set exactly", () => {
    expect(workspaceStoreCanonicalIds()).toEqual(new Set(workspaceStoreSeedNodes().map((node) => node.id)));
  });

  it("returns fresh, independently-mutable copies on every call", () => {
    const first = workspaceStoreSeedNodes();
    first.find((node) => node.id === "block_classifier")!.dependsOn.push("mutated");
    const second = workspaceStoreSeedNodes();
    expect(second.find((node) => node.id === "block_classifier")!.dependsOn).not.toContain("mutated");
  });
});

describe("a fresh workspace document is seeded with all 48 nodes (store.ts's defaultWorkspaceNodes)", () => {
  it("createDefaultWorkspaceDocument includes capture/clone's own nodes from the start", () => {
    const document = createDefaultWorkspaceDocument();
    expect(document.nodes).toHaveLength(48);
    expect(document.nodes.some((node) => node.id === "block_classifier")).toBe(true);
    expect(document.nodes.some((node) => node.id === "clone_intake")).toBe(true);
  });
});

describe("WorkspaceStore.getNode resolves capture/clone nodes directly (governance visibility, #195's core complaint)", () => {
  it("workspace_get_node('block_classifier') returns the node with its prompt/config on a fresh store", async () => {
    const repository = new MemoryWorkspaceRepository();
    const node = await repository.getNode("block_classifier");
    expect(node).toBeDefined();
    expect(node!.prompt.length).toBeGreaterThan(0);
    expect(node!.modelConfig).toBeDefined();
  });
});

describe("ensureWorkspaceNodeSeeds — additive top-up for a workspace document created before #195", () => {
  it("adds every missing capture/clone node without touching an existing (operator-edited) node", async () => {
    // A pre-#195-shaped document: only publishing's 24 nodes (defaultWorkspaceNodes() before this
    // change), with one operator-promoted prompt edit that must survive the top-up untouched.
    const preExistingDocument = createDefaultWorkspaceDocument();
    preExistingDocument.nodes = listWorkspaceNodes().map((node) => (node.id === "input_triage" ? { ...node, prompt: "OPERATOR-PROMOTED PROMPT TEXT" } : node));
    const store = new InMemoryWorkspaceStore(preExistingDocument);

    const before = await store.getNodes();
    expect(before).toHaveLength(24);
    expect(before.find((node) => node.id === "input_triage")?.prompt).toBe("OPERATOR-PROMOTED PROMPT TEXT");

    const topped = await store.ensureWorkspaceNodeSeeds();
    expect(topped).toHaveLength(48);
    expect(topped.find((node) => node.id === "input_triage")?.prompt).toBe("OPERATOR-PROMOTED PROMPT TEXT");
    expect(topped.some((node) => node.id === "block_classifier")).toBe(true);

    // Idempotent: a second call is a genuine no-op (no workspaceVersion bump).
    const versionAfterFirst = await store.getWorkspaceVersion();
    await store.ensureWorkspaceNodeSeeds();
    expect(await store.getWorkspaceVersion()).toBe(versionAfterFirst);
  });
});

describe("workspace.* MCP tools see capture/clone nodes (#195 acceptance)", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("workspace.get_node resolves block_classifier with prompt/config", async () => {
    const res = await call("workspace.get_node", { id: "block_classifier" });
    expect(structured(res).ok).toBe(true);
    expect(structured(res).data.node?.id).toBe("block_classifier");
    expect(structured(res).data.node?.prompt.length).toBeGreaterThan(0);
  });

  it("workspace.get_node_effective_config resolves model config for a capture node and a clone node", async () => {
    const capture = await call("workspace.get_node_effective_config", { id: "block_classifier" });
    expect(structured(capture).data.config?.modelConfig).toBeDefined();
    expect(structured(capture).data.config?.riskLevel).toBe("read");

    const clone = await call("workspace.get_node_effective_config", { id: "recipe_mint" });
    expect(structured(clone).data.config).toBeDefined();
    expect(structured(clone).data.config?.riskLevel).toBe("write");
  });

  it("workspace.get_nodes lists all three workflows' nodes, not publishing's alone", async () => {
    const res = await call("workspace.get_nodes");
    const ids = structured(res).data.nodes.map((node: { id: string }) => node.id);
    expect(ids).toHaveLength(48);
    expect(ids).toEqual(expect.arrayContaining(["input_triage", "block_classifier", "clone_intake"]));
  });

  // B1 (Pass 2, WP-00) — live capture found workspace.get_nodes could not filter by conductor (its
  // schema took no arguments at all). This adds the SAME optional workflowId filter workspace.get_graph
  // already implements, resolved through the identical resolveConductorNodes path — same 24/16/18
  // per-conductor topology, same fallback for an unregistered id, no client-side filtering required.
  it("workspace.get_nodes({workflowId}) scopes to one conductor's actual node set, same resolution as workspace.get_graph", async () => {
    const publishing = await call("workspace.get_nodes", { workflowId: "publishing_conductor" });
    const capture = await call("workspace.get_nodes", { workflowId: "capture_conductor" });
    const clone = await call("workspace.get_nodes", { workflowId: "clone_conductor" });
    expect(structured(publishing).data.nodes).toHaveLength(24);
    expect(structured(capture).data.nodes).toHaveLength(16);
    expect(structured(clone).data.nodes).toHaveLength(18);

    // Identical node set AND identical per-conductor rebinding to workspace.get_graph({workflowId}) —
    // not just the same count.
    const graphClone = await call("workspace.get_graph", { workflowId: "clone_conductor" });
    expect(structured(clone).data.nodes).toEqual(structured(graphClone).data.nodes);
    const publishPayload = structured(clone).data.nodes.find((node: { id: string }) => node.id === "publish_payload");
    expect(publishPayload.dependsOn).toEqual(["recipe_mint", "theme_bind", "layout_restamp"]);
  });

  it("workspace.get_nodes with no workflowId is unchanged: still the flat 48-node union", async () => {
    const res = await call("workspace.get_nodes", {});
    expect(structured(res).data.nodes).toHaveLength(48);
  });

  it("workspace.get_nodes rejects an unknown argument, same additionalProperties:false discipline as before", async () => {
    const res = await call("workspace.get_nodes", { bogus: true });
    expect(res.error).toBeDefined();
  });

  it("workspace.get_graph with no workflowId merges every registered workflow's nodes/edges", async () => {
    const res = await call("workspace.get_graph");
    const data = structured(res).data;
    expect(data.nodes).toHaveLength(48);
    expect(data.registeredWorkflowIds).toEqual(["publishing_conductor", "capture_conductor", "clone_conductor"]);
    // capture_report's own dependency on the shared tail is visible even in the flat merged view.
    expect(data.edges).toEqual(expect.arrayContaining([{ from: "publish_executor", to: "capture_report" }]));
  });

  it("workspace.get_graph with workflowId='capture_conductor' returns capture's ACTUAL composed run topology, not the flat store view", async () => {
    const res = await call("workspace.get_graph", { workflowId: "capture_conductor" });
    const data = structured(res).data;
    expect(data.workflowId).toBe("capture_conductor");
    // The flat store's publish_payload row is bound to [article_body, artifact_plan] (publishing's own
    // boundary); capture's ACTUAL run rebinds it to [capture_emit_live, capture_score] — invisible in
    // the flat merged view above, visible here.
    const publishPayload = data.nodes.find((node: { id: string }) => node.id === "publish_payload");
    expect(publishPayload.dependsOn).toEqual(["capture_emit_live", "capture_score"]);
    expect(data.edges).toEqual(expect.arrayContaining([{ from: "capture_emit_live", to: "publish_payload" }, { from: "capture_score", to: "publish_payload" }]));
  });

  it("workspace.get_graph with workflowId='clone_conductor' rebinds publish_payload to clone's own upstream", async () => {
    const res = await call("workspace.get_graph", { workflowId: "clone_conductor" });
    const publishPayload = structured(res).data.nodes.find((node: { id: string }) => node.id === "publish_payload");
    expect(publishPayload.dependsOn).toEqual(["recipe_mint", "theme_bind", "layout_restamp"]);
  });

  it("an unregistered workflowId falls back to publishing_conductor's own topology (resolveConductorNodes' documented default)", async () => {
    const res = await call("workspace.get_graph", { workflowId: "not_a_real_workflow" });
    expect(structured(res).data.nodes.map((node: { id: string }) => node.id)).toEqual(listWorkspaceNodes().map((node) => node.id));
  });

  it("workspace.update_graph refuses to delete a capture/clone node without admin approval — the same floor publishing's nodes get", async () => {
    const res = await call("workspace.update_graph", { delete: ["block_classifier"] });
    expect(structured(res)?.ok).not.toBe(true);
  });
});

describe("optimizer/playbook tooling resolves capture/clone nodes by id (#195 acceptance)", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("optimizer.analyze does not refuse block_classifier as an unknown node", async () => {
    const res = await call("optimizer.analyze", { nodeId: "block_classifier" });
    expect(structured(res)?.ok).toBe(true);
  });

  it("playbook.get does not refuse recipe_designer as an unknown node", async () => {
    const res = await call("playbook.get", { nodeId: "recipe_designer" });
    expect(structured(res)?.ok).toBe(true);
  });
});

describe("run topology is unaffected — composed workflows still validate and reproduce their documented shape", () => {
  it("capture_conductor's and clone_conductor's composed node sets are unchanged by #195's store registration", () => {
    expect(listCaptureConductorNodes().map((node) => node.id)).toEqual([
      ...captureConductorNodes.map((node) => node.id),
      "publish_payload", "publication_controller", "publish_executor", "release_executor", "learning_recorder"
    ]);
    expect(listCloneConductorNodes().map((node) => node.id)).toEqual([
      ...cloneConductorNodes.map((node) => node.id),
      "publish_payload", "publication_controller", "publish_executor", "release_executor", "learning_recorder"
    ]);
  });
});
