import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const call = async (name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => (await call(name, args, headers)).result.structuredContent.data;

describe("changes.* MCP tools", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("advertises the change-history and relationship tools", async () => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = JSON.parse(response.body ?? "{}").result.tools.map((tool: { name: string }) => tool.name);
    for (const name of ["changes_list", "changes_get", "changes_compare", "changes_restore", "workspace_update_relationships"]) expect(names).toContain(name);
  });

  it("records an attributed change event for a mutation and honors baseRevisionId conflicts", async () => {
    const first = await data("workspace.update_node_prompt", { id: "input_triage", prompt: "First version.", actor: { kind: "agent", id: "optimizer-1" }, reason: "test change" });
    expect(first.node.prompt).toBe("First version.");

    const page = await data("changes.list", { limit: 1 });
    const event = page.events[0];
    expect(event.type).toBe("node.prompt_updated");
    expect(event.actor).toEqual({ kind: "agent", id: "optimizer-1" });
    expect(event.source).toBe("mcp");
    expect(event.reason).toBe("test change");
    expect(event.correlation.requestId).toMatch(/^req_/);
    expect((await data("changes.get", { eventId: event.eventId })).event.eventId).toBe(event.eventId);

    // Stale base revision → typed conflict via the standard tool_error envelope.
    await data("workspace.update_node_prompt", { id: "input_triage", prompt: "Second version.", baseRevisionId: event.resultingRevisionId });
    const conflict = await call("workspace.update_node_prompt", { id: "input_triage", prompt: "Third version.", baseRevisionId: event.resultingRevisionId });
    expect(conflict.error.code).toBe(-32603);
    expect(conflict.error.data.error.message).toContain("revision_conflict: expected");
  });

  it("stamps actor and source from proxy headers when the caller supplies none", async () => {
    await data("workspace.update_node_prompt", { id: "input_triage", prompt: "Header attributed." }, {
      "x-workspace-actor": JSON.stringify({ kind: "human", id: "vreich@kugelbrands.com" }),
      "x-workspace-source": "ui"
    });
    const event = (await data("changes.list", { limit: 1 })).events[0];
    expect(event.actor).toEqual({ kind: "human", id: "vreich@kugelbrands.com" });
    expect(event.source).toBe("ui");
  });

  it("records canvas position moves as attributed graph events with a position diff", async () => {
    // The S3 Design canvas persists drags via update_graph {positions}; layout changes are real
    // workspace history, not cosmetic state.
    await data("workspace.update_node_prompt", { id: "input_triage", prompt: "Position baseline." });
    const before = (await data("changes.list", { limit: 1 })).events[0];
    const result = await data("workspace.update_graph", { positions: { input_triage: { x: 640, y: 320 } }, source: "ui", summary: "Moved Publishing Input Triage on the canvas" });
    expect(result.nodes.find((node: { id: string }) => node.id === "input_triage").position).toEqual({ x: 640, y: 320 });

    const event = (await data("changes.list", { limit: 1 })).events[0];
    expect(event.type).toBe("graph.updated");
    expect(event.source).toBe("ui");
    expect(event.reason).toBe("Moved Publishing Input Triage on the canvas");
    expect(event.resultingRevisionId).toBeTruthy();

    const { diff } = await data("changes.compare", { fromRevisionId: before.resultingRevisionId, toRevisionId: event.resultingRevisionId });
    const changed = diff.nodes.changed.find((entry: { nodeId: string }) => entry.nodeId === "input_triage");
    expect(changed.changedFields).toContain("position");
  });

  it("compares two revisions with field-level changes", async () => {
    await data("workspace.update_node_prompt", { id: "input_triage", prompt: "Compare A." });
    const eventA = (await data("changes.list", { limit: 1 })).events[0];
    await data("workspace.update_node_prompt", { id: "input_triage", prompt: "Compare B." });
    const eventB = (await data("changes.list", { limit: 1 })).events[0];

    const { diff } = await data("changes.compare", { fromRevisionId: eventA.resultingRevisionId, toRevisionId: eventB.resultingRevisionId });
    expect(diff.nodes.added).toEqual([]);
    expect(diff.nodes.removed).toEqual([]);
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0].nodeId).toBe("input_triage");
    expect(diff.nodes.changed[0].changedFields).toContain("prompt");

    const unknown = await call("changes.compare", { fromRevisionId: "rev_missing", toRevisionId: eventB.resultingRevisionId });
    expect(unknown.error.data.error.message).toContain("unknown_revision: rev_missing");
  });

  it("restores a node from a historical revision as a new revision (history append-only)", async () => {
    await data("workspace.update_node_prompt", { id: "input_triage", prompt: "Original to restore." });
    const original = (await data("changes.list", { limit: 1 })).events[0];
    await data("workspace.update_node_prompt", { id: "input_triage", prompt: "Overwritten." });
    const countBefore = (await data("changes.list", { limit: 200 })).events.length;

    const restored = await data("changes.restore", { revisionId: original.resultingRevisionId, nodeId: "input_triage", actor: { kind: "human", id: "vreich@kugelbrands.com" } });
    expect(restored.node.prompt).toBe("Original to restore.");
    expect(restored.restoredFromRevisionId).toBe(original.resultingRevisionId);
    expect(restored.revisionId).not.toBe(original.resultingRevisionId);

    const events = (await data("changes.list", { limit: 200 })).events;
    expect(events).toHaveLength(countBefore + 1);
    expect(events[0].operation).toBe("restore");
    // The restored-from revision is still intact.
    const { diff } = await data("changes.compare", { fromRevisionId: original.resultingRevisionId, toRevisionId: restored.revisionId });
    expect(diff.nodes.changed.filter((change: { changedFields: string[] }) => change.changedFields.includes("prompt"))).toHaveLength(0);
  });

  it("never exposes sensitive metadata values through change responses", async () => {
    await data("workspace.update_node_metadata", { id: "input_triage", patch: { metadata: { apiKey: "raw-secret-value-9", note: "public note" } } });
    const serialized = JSON.stringify(await data("changes.list", { limit: 5 }));
    expect(serialized).not.toContain("raw-secret-value-9");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("public note");
  });

  it("manages typed relationships through the guarded mutation tool", async () => {
    const created = await data("workspace.update_relationships", {
      create: [{ id: "rel_review_data", kind: "data", sourceId: "draft_writer", targetId: "trust_factual", label: "draft handoff" }],
      actor: { kind: "agent", id: "architect" },
      reason: "wire review data flow"
    });
    expect(created.relationships).toHaveLength(1);
    expect(created.revisionId).toBeDefined();

    const structure = await data("constellation.get_structure");
    expect(structure.relationships.map((relationship: { id: string }) => relationship.id)).toContain("rel_review_data");

    const event = (await data("changes.list", { limit: 1 })).events[0];
    expect(event.target.type).toBe("relationship");
    expect(event.type).toBe("workspace.relationships_updated");

    const executionRejected = await call("workspace.update_relationships", { create: [{ kind: "execution", sourceId: "draft_writer", targetId: "trust_factual" }] });
    expect(executionRejected.error.data.error.message).toContain("execution_relationships_are_derived");

    const unknownEndpoint = await call("workspace.update_relationships", { create: [{ kind: "policy", sourceId: "draft_writer", targetId: "not_a_node" }] });
    expect(unknownEndpoint.error.data.error.message).toContain("unknown_relationship_endpoint: not_a_node");

    const deleted = await data("workspace.update_relationships", { delete: ["rel_review_data"] });
    expect(deleted.relationships).toHaveLength(0);
  });
});
