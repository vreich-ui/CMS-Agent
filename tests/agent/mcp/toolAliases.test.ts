import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { handleMcpJsonRpc, DEPRECATED_TOOL_ALIASES } from "../../../src/agent/mcp/workspace/server.js";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const rpc = async (method: string, params?: Record<string, unknown>) =>
  (await handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method, params })) as { result?: any; error?: { code: number } };

describe("deprecated tool aliases", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => delete process.env.MCP_EXPOSED_TOOL_PREFIXES);

  it("does not advertise alias names in tools/list", async () => {
    const names: string[] = (await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name);
    for (const alias of Object.keys(DEPRECATED_TOOL_ALIASES)) {
      expect(names).not.toContain(alias);
      expect(names).not.toContain(alias.replace(/\./g, "_"));
    }
    // Canonical targets stay listed.
    expect(names).toContain("workspace_get_nodes");
    expect(names).toContain("node_list_executions");
    expect(names).toContain("workspace_update_node_output_schema");
  });

  it("resolves every alias on tools/call under both spellings", async () => {
    const dotted = await rpc("tools/call", { name: "node.list", arguments: {} });
    const underscore = await rpc("tools/call", { name: "node_list", arguments: {} });
    expect(dotted.result.structuredContent.data.nodes.length).toBeGreaterThan(0);
    expect(underscore.result.structuredContent.data.nodes.length).toBeGreaterThan(0);

    const executions = await rpc("tools/call", { name: "node.get_execution", arguments: {} });
    expect(executions.result.structuredContent.ok).toBe(true);
  });

  it("routes the legacy schema tool through the canonical, validating implementation", async () => {
    const updated = await rpc("tools/call", { name: "workspace.update_node_schema", arguments: { id: "input_triage", schema: { type: "object" } } });
    expect(updated.result.structuredContent.ok).toBe(true);
    // The canonical implementation validates JSON Schema; garbage is now rejected via the alias too.
    const invalid = await rpc("tools/call", { name: "workspace.update_node_schema", arguments: { id: "input_triage", schema: { type: "not-a-type" } } });
    expect(invalid.error?.code).toBe(-32603);
  });

  it("scopes alias callability by the alias name's namespace", async () => {
    process.env.MCP_EXPOSED_TOOL_PREFIXES = "node";
    // node.list is callable (alias namespace "node" exposed) even though its target lives in workspace.*.
    const allowed = await rpc("tools/call", { name: "node.list", arguments: {} });
    expect(allowed.result.structuredContent.ok).toBe(true);
    // workspace.update_node_schema alias is not exposed under "node".
    const blocked = await rpc("tools/call", { name: "workspace.update_node_schema", arguments: { id: "input_triage", schema: {} } });
    expect(blocked.error?.code).toBe(-32602);
  });
});

describe("workflow.run_node nodeId targeting", () => {
  beforeEach(() => resetRepositoryManager());

  it("advances the run until the named node completes instead of ignoring nodeId", async () => {
    const started = await rpc("tools/call", { name: "workflow.start_dry_run", arguments: { projectId: "project-a", input: { topic: "t" } } });
    const runId = started.result.structuredContent.data.run.runId;

    const result = await rpc("tools/call", { name: "workflow.run_node", arguments: { runId, nodeId: "reader_insight" } });
    const run = result.result.structuredContent.data.run;
    const target = run.nodes.find((node: { nodeId: string }) => node.nodeId === "reader_insight");
    expect(target.status).toBe("completed");
    // It stopped at the target rather than running the whole graph.
    expect(run.status).not.toBe("completed");
  });

  it("still runs exactly the next ready node when nodeId is omitted", async () => {
    const started = await rpc("tools/call", { name: "workflow.start_dry_run", arguments: { projectId: "project-a", input: { topic: "t" } } });
    const runId = started.result.structuredContent.data.run.runId;
    const result = await rpc("tools/call", { name: "workflow.run_node", arguments: { runId } });
    const completed = result.result.structuredContent.data.run.nodes.filter((node: { status: string }) => node.status === "completed");
    expect(completed).toHaveLength(1);
  });
});
