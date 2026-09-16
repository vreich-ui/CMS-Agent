import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { flushToolExecutionLedger } from "../../../src/agent/tools/toolExecutionLedger.js";
import { UNATTRIBUTED_NODE_ID, UNATTRIBUTED_RUN_ID } from "../../../src/agent/tools/tenantInvoke.js";

// ACCEPTANCE — W5 T3 (2026-09-16). The wire surface joins the ledger.
//
// W3.2.1 put every model-invoked and engine-invoked tenant call through one choke point.
// `project.call_tool` / `project.call_read_tool` — an operator or a script with a full bearer, calling
// the tenant by hand, outside any run — were the last callers outside it. So `tool.list_executions`
// could tell you what the engine did and what a model did, and nothing at all about what a PERSON
// did: the one category an incident review starts from.
//
// They now record under caller "operator", which is a third value rather than a relabelling of either
// of the others. The call itself is unchanged, including the publish-verb refusal that still happens
// BEFORE this line — that refusal is this surface's own, exemption-free rule (W3.2.3), and it is not
// weakened by anything here.

const tool = (name: string) => createWorkspaceTools({}).find((candidate) => candidate.name === name)!;

const readLedger = async (filters: Parameters<ReturnType<typeof repositoryManager.getToolExecutionRepository>["list"]>[0] = {}) => {
  await flushToolExecutionLedger();
  return repositoryManager.getToolExecutionRepository().list(filters);
};

beforeEach(() => {
  resetRepositoryManager();
});

describe("W5 T3 — project.call_tool is ledgered as caller \"operator\"", () => {
  it("records a wire write, and tool.list_executions {caller:\"operator\"} finds it", async () => {
    // No endpoint is configured in a test process, so the adapter fails on the connection. That is
    // the point rather than a limitation: the ledger must record a call that FAILED, or an operator
    // reviewing an incident sees only the calls that worked.
    await tool("project.call_tool").execute({ projectId: "dr-lurie", tool: "object_get", arguments: { object_id: "x" } });

    const operatorRows = await readLedger({ caller: "operator" });
    expect(operatorRows.map((row) => row.toolId)).toEqual(["object_get"]);

    const [row] = operatorRows;
    expect(row.projectId).toBe("dr-lurie");
    // A wire call belongs to no run and no node, and says so with the choke point's own sentinels
    // rather than being dropped — "we could not attribute this" is data.
    expect(row.runId).toBe(UNATTRIBUTED_RUN_ID);
    expect(row.nodeId).toBe(UNATTRIBUTED_NODE_ID);
    expect(row.routeId).toBeUndefined();
  });

  it("records a wire read the same way", async () => {
    await tool("project.call_read_tool").execute({ projectId: "dr-lurie", tool: "object_get", arguments: { object_id: "x" } });
    expect((await readLedger({ caller: "operator" })).map((row) => row.toolId)).toEqual(["object_get"]);
  });

  it("does not file a wire call under \"engine\" or \"model\"", async () => {
    await tool("project.call_tool").execute({ projectId: "dr-lurie", tool: "object_get", arguments: {} });
    expect(await readLedger({ caller: "engine" })).toEqual([]);
    expect(await readLedger({ caller: "model" })).toEqual([]);
  });

  it("still refuses a publish verb before the ledger, unchanged by this wave", async () => {
    const result = await tool("project.call_tool").execute({ projectId: "dr-lurie", tool: "release_to_production", arguments: {} }) as { data: { call: { ok: boolean; error?: string } } };
    expect(result.data.call.ok).toBe(false);
    expect(result.data.call.error).toContain("publish_verb_not_permitted");
    // Refused before any transport AND before the choke point, so there is nothing to record: the
    // wire denylist is a different, stronger rule than the one the ledger is about.
    expect(await readLedger({ caller: "operator" })).toEqual([]);
  });
});

describe("W5 T3 — the filter advertises the value it can now return", () => {
  it("accepts caller \"operator\" on tool.list_executions", async () => {
    const result = await tool("tool.list_executions").execute({ caller: "operator" }) as { data: { executions: unknown[] } };
    expect(Array.isArray(result.data.executions)).toBe(true);
  });

  it("advertises all three callers in its JSON Schema, so a client is never rejected for sending one", () => {
    const schema = tool("tool.list_executions").inputSchema as { properties?: { caller?: { enum?: string[] } } };
    expect(schema.properties?.caller?.enum).toEqual(["model", "engine", "operator"]);
  });
});
