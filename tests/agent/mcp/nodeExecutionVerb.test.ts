import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// ACCEPTANCE — K-A9 / W5 T1 (2026-09-16), at the MCP surface.
//
// The unit-level claims live in tests/agent/workspace/storedNodeExecution.test.ts. This file drives
// the actual verbs, because K-A9 is not a statement about a function — it is a statement about what
// an agent holding a full bearer can and cannot do to a tail node's route.
//
// THE SCENARIO, verbatim from docs/KNOWN_ISSUES.md K-A9: one
// `workspace_update_node_metadata {id:"release_executor", patch:{metadata:{releaseExecutorDeterministic:false}}}`
// turned the release step into a model turn that could call release_to_production itself, with no
// idempotency ledger, and nothing in the repo would notice.

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;
const failure = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await call(name, args);
  expect(response.error, `expected ${name} to be refused`).toBeTruthy();
  return response.error.data.error as { code?: string; message: string };
};

describe("K-A9 — a metadata write can no longer flip a tail node off its route", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("carries the route as a stored field on the seeded node, not only in metadata", async () => {
    const { node } = await data("workspace.get_node", { id: "release_executor" });
    expect(node.executionKind).toBe("deterministic");
    expect(node.route).toEqual({ id: "releaseExecutorDeterministic" });
  });

  it("keeps executionKind deterministic after the exact K-A9 write", async () => {
    await data("workspace.update_node_metadata", { id: "release_executor", patch: { metadata: { releaseExecutorDeterministic: false } } });
    const { node } = await data("workspace.get_node", { id: "release_executor" });
    expect(node.executionKind).toBe("deterministic");
    expect(node.route).toEqual({ id: "releaseExecutorDeterministic" });
    // And the audit — which is what an operator or a CI check reads — agrees.
    const { capabilities } = await data("workspace.validate_node", { id: "release_executor" });
    expect(capabilities.executionKind).toBe("deterministic");
  });

  it("keeps it after a metadata write that simply forgets the key, which is the commoner accident", async () => {
    await data("workspace.update_node_metadata", { id: "release_executor", patch: { metadata: { approvalRequired: false } } });
    expect((await data("workspace.get_node", { id: "release_executor" })).node.executionKind).toBe("deterministic");
  });

  it("refuses a generic workspace.update_node patch that names the field, and says which verb to use", async () => {
    const error = await failure("workspace.update_node", { id: "release_executor", patch: { executionKind: "model" } });
    expect(error.message).toContain("execution_field_write_refused");
    expect(error.message).toContain("workspace.update_node_execution");
  });

  it("refuses it through workspace.update_graph too", async () => {
    const error = await failure("workspace.update_graph", { update: [{ id: "release_executor", route: { id: "somethingElse" } }] });
    expect(error.message).toContain("execution_field_write_refused");
  });
});

describe("K-A9 — workspace.update_node_execution is the one door", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("takes a node off its route deliberately, and clears the route when it does", async () => {
    const { node } = await data("workspace.update_node_execution", { id: "release_executor", executionKind: "model", reason: "acceptance test" });
    expect(node.executionKind).toBe("model");
    expect(node.route ?? null).toBeNull();
    // The explicit answer SUPPRESSES the metadata flag rather than losing to it — an operator who
    // asked for a model turn gets one, and the two cannot disagree.
    expect(node.metadata?.releaseExecutorDeterministic).toBe(true);
    expect((await data("workspace.validate_node", { id: "release_executor" })).capabilities.executionKind).toBe("model");
  });

  it("puts it back", async () => {
    await data("workspace.update_node_execution", { id: "release_executor", executionKind: "model" });
    const { node } = await data("workspace.update_node_execution", { id: "release_executor", executionKind: "deterministic", route: { id: "releaseExecutorDeterministic" } });
    expect(node.executionKind).toBe("deterministic");
    expect(node.route).toEqual({ id: "releaseExecutorDeterministic" });
  });

  it("carries a staged route's mode", async () => {
    const { node } = await data("workspace.update_node_execution", { id: "capture_crawl", executionKind: "deterministic", route: { id: "captureStageDeterministic", mode: "crawl" } });
    expect(node.route).toEqual({ id: "captureStageDeterministic", mode: "crawl" });
  });

  it("refuses \"deterministic\" with no route — the executor dispatches a named program", async () => {
    const error = await failure("workspace.update_node_execution", { id: "release_executor", executionKind: "deterministic" });
    expect(error.message).toContain("requires a route");
  });

  it("refuses an unknown node rather than creating one", async () => {
    const error = await failure("workspace.update_node_execution", { id: "no_such_node", executionKind: "model" });
    expect(error.message).toContain("Unknown node");
  });
});
