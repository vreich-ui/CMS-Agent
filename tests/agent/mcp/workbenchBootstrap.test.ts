import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { listRegisteredWorkflowIds } from "../../../src/agent/workspace/workflowRegistry.js";

// W3 acceptance, server half. The load budget is "<= 2 verb calls and <= 40 KB before the rail is
// interactive", and `project_list` is the other one — so everything else a cold paint used to ask
// fifteen questions for has to fit in this one answer, inside its share of that budget.

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

describe("workbench.bootstrap", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("answers the whole first paint in one call, inside the budget", async () => {
    const result = await data("workbench.bootstrap", { workflowId: "publishing_conductor" });

    expect(result.registeredWorkflowIds).toEqual(listRegisteredWorkflowIds());
    expect(result.graph.workflowId).toBe("publishing_conductor");
    expect(result.graph.detail).toBe("summary");
    expect(result.graph.nodes.length).toBeGreaterThan(10);
    expect(result.graph.edges.length).toBeGreaterThan(10);
    expect(typeof result.workspaceVersion).toBe("number");
    expect(Object.keys(result.attentionCounts).sort()).toEqual(["blocked", "failed", "paused", "running"]);

    // The budget. 40 KB is the whole first paint; project_list is the other call, so this must
    // leave room for it.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(32 * 1024);
  });

  it("carries no prompt, schema, tool or skill anywhere in the payload", async () => {
    // The inspector fetches the ONE node a user opened. If any of these leak back into the
    // bootstrap the 310 KB comes with them.
    const result = await data("workbench.bootstrap", { workflowId: "publishing_conductor" });
    for (const node of result.graph.nodes) {
      for (const omitted of ["prompt", "inputSchema", "outputSchema", "schema", "allowedTools", "assignedSkills", "metadata", "modelConfig", "defaultOutput"]) {
        expect(node).not.toHaveProperty(omitted);
      }
    }
  });

  it("names every registered workflow, not just the ones a client's catalog knows", async () => {
    const result = await data("workbench.bootstrap", {});
    // The client's own catalog (workbench/src/api/workflowCatalog.ts) lists three. The registry
    // has more, and a workflow missing from the Workbench because a presentation constant was
    // never updated is precisely the defect this field closes.
    expect(result.registeredWorkflowIds.length).toBeGreaterThanOrEqual(6);
    expect(result.registeredWorkflowIds).toContain("publishing_conductor");
    expect(result.graph).toBeNull();
  });

  it("reports an unregistered workflowId instead of substituting a different workflow", async () => {
    const result = await data("workbench.bootstrap", { workflowId: "no_such_conductor" });
    expect(result.unknownWorkflowId).toBe("no_such_conductor");
    expect(result.graph).toBeNull();
    // ...and still hands back the registry, so a client with a stale catalog can recover.
    expect(result.registeredWorkflowIds).toContain("publishing_conductor");
  });

  it("returns recent runs as summary rows with their modes interned", async () => {
    await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {} });
    const result = await data("workbench.bootstrap", { workflowId: "publishing_conductor" });

    expect(result.recentRuns.length).toBeGreaterThanOrEqual(1);
    const [row] = result.recentRuns;
    expect(row).not.toHaveProperty("nodes");
    expect(row).not.toHaveProperty("mode");
    expect(result.modes[row.modeRef]).toMatchObject({ executionMode: "mock" });
    expect(result.attentionCounts.running + result.attentionCounts.paused + result.attentionCounts.blocked + result.attentionCounts.failed).toBeGreaterThanOrEqual(0);
  });
});
