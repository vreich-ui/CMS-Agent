import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { CANONICAL_OWNED_FIELDS } from "../../../src/agent/workspace/executor.js";
import { CANONICAL_OWNED_WRITE_EXEMPT_FIELDS, CANONICAL_OWNED_WRITE_REFUSED_FIELDS } from "../../../src/agent/mcp/workspace/canonicalNodeFieldGuard.js";

// T5 (docs/plan/two-plane-reconciliation-plan.md §B) — a store write to a field overlayStoreNode pins
// to canonical is refused BY NAME at the MCP surface, on a node canonical defines. The same write to a
// store-authored node canonical does not know still succeeds: there is no canonical row to pin from,
// and adding such a node is a supported act.

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;
const failure = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await call(name, args);
  expect(response.error, `expected ${name} to be refused`).toBeTruthy();
  return response.error.data.error as { code?: string; message: string; fields?: string[] };
};

const STORE_ONLY_NODE = {
  id: "store_only_probe",
  name: "Store only probe",
  kind: "custom",
  description: "",
  prompt: "probe",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  allowedTools: [],
  assignedSkills: [],
  requiredInputs: [],
  produces: [],
  dependsOn: [],
  riskLevel: "read",
  status: "draft",
  position: { x: 0, y: 0 },
  updatedAt: new Date().toISOString()
};

describe("canonical-owned field writes at the MCP surface", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("derives the refused set from CANONICAL_OWNED_FIELDS, exempting position and nothing else", () => {
    expect([...CANONICAL_OWNED_WRITE_REFUSED_FIELDS, ...CANONICAL_OWNED_WRITE_EXEMPT_FIELDS].sort()).toEqual([...CANONICAL_OWNED_FIELDS].sort());
    expect(CANONICAL_OWNED_WRITE_EXEMPT_FIELDS).toEqual(["position"]);
  });

  it("refuses workspace.update_node_dependencies on a canonical node, naming overlayStoreNode and nodes:update", async () => {
    const error = await failure("workspace.update_node_dependencies", { id: "artifact_plan", patch: { dependsOn: ["input_triage"] } });
    expect(error.code).toBe("canonical_owned_field_write");
    expect(error.message).toContain("overlayStoreNode");
    expect(error.message).toContain("nodes:update");
    expect(error.message).toContain("artifact_plan");
    expect(error.message).toContain("dependsOn");
    expect(error.fields).toEqual(["dependsOn"]);
  });

  it("leaves the stored row untouched when it refuses", async () => {
    const before = (await data("workspace.get_node", { id: "artifact_plan" })).node;
    await failure("workspace.update_node_dependencies", { id: "artifact_plan", patch: { dependsOn: [] } });
    const after = (await data("workspace.get_node", { id: "artifact_plan" })).node;
    expect(after.dependsOn).toEqual(before.dependsOn);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("refuses a workspace.update_node patch that carries canonical-owned fields, naming every one at once", async () => {
    const error = await failure("workspace.update_node", { id: "research", patch: { prompt: "new", dependsOn: [], riskLevel: "write" } });
    expect(error.code).toBe("canonical_owned_field_write");
    expect(error.fields).toEqual(["dependsOn", "riskLevel"]);
  });

  it("still accepts a store-owned patch on the same canonical node", async () => {
    const result = await data("workspace.update_node", { id: "research", patch: { prompt: "A store-owned edit is unaffected." } });
    expect(result.node.prompt).toBe("A store-owned edit is unaffected.");
  });

  it("refuses the same fields through workspace.update_graph, in both its shapes", async () => {
    const viaDependencies = await failure("workspace.update_graph", { dependencies: { artifact_plan: ["input_triage"] } });
    expect(viaDependencies.code).toBe("canonical_owned_field_write");
    const viaUpdate = await failure("workspace.update_graph", { update: [{ id: "artifact_plan", riskLevel: "write" }] });
    expect(viaUpdate.fields).toEqual(["riskLevel"]);
  });

  it("still accepts a canonical node's position — the one deliberate exemption the design canvas needs", async () => {
    const result = await data("workspace.update_graph", { positions: { artifact_plan: { x: 12, y: 34 } } });
    expect(result.nodes.find((node: { id: string }) => node.id === "artifact_plan").position).toEqual({ x: 12, y: 34 });
  });

  it("refuses a delete+create in one update_graph — the bypass that re-creates a canonical row with new topology", async () => {
    // updateGraph applies `delete` before `create` inside one mutate(), and assertGraphValid's
    // canonical-presence rule only runs at the end, so this pair used to pass every check.
    const error = await failure("workspace.update_graph", {
      delete: ["artifact_plan"],
      create: [{ ...STORE_ONLY_NODE, id: "artifact_plan", dependsOn: ["input_triage"] }],
      allowCanonicalNodeRemoval: true,
      adminApproved: true
    });
    expect(error.code).toBe("canonical_owned_field_write");
    expect((await data("workspace.get_node", { id: "artifact_plan" })).node.dependsOn).not.toEqual(["input_triage"]);
  });

  it("refuses workspace.create_node addressed to an id canonical defines — the two-call form of the same bypass", async () => {
    const error = await failure("workspace.create_node", { node: { ...STORE_ONLY_NODE, id: "artifact_plan" } });
    expect(error.code).toBe("canonical_owned_field_write");
  });

  it("covers a registered workflow canonical id the store's seed union does not carry", async () => {
    // workspaceStoreCanonicalIds() deliberately excludes pdfTemplateStudioNodes.ts, but
    // resolveConductorNodes pins that workflow's nodes from canonical just as hard, so a write here is
    // discarded at dispatch exactly like any other. The guard unions the registered workflows for this.
    const error = await failure("workspace.update_node_dependencies", { id: "pdf_template_library_deposit", patch: { dependsOn: ["input_triage"] } });
    expect(error.code).toBe("canonical_owned_field_write");
  });

  it("lets a store-authored node keep its own topology, through every guarded tool", async () => {
    await data("workspace.create_node", { node: STORE_ONLY_NODE });
    expect((await data("workspace.update_node_dependencies", { id: "store_only_probe", patch: { dependsOn: ["input_triage"] } })).node.dependsOn).toEqual(["input_triage"]);
    expect((await data("workspace.update_node", { id: "store_only_probe", patch: { riskLevel: "write" } })).node.riskLevel).toBe("write");
    await data("workspace.update_graph", { dependencies: { store_only_probe: [] } });
    expect((await data("workspace.get_node", { id: "store_only_probe" })).node.dependsOn).toEqual([]);
  });
});
