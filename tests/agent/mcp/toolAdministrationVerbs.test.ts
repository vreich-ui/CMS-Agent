import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// ACCEPTANCE — W4.1 (2026-09-09). The tool-administration hole, answerable from the MCP surface.
//
// W3.1 made the two-kinds-of-"tool" gap knowable in a data model. W3.2 made every call pass one door
// and land in one ledger. This is the wave where an operator can ASK the questions those two made
// answerable, without reading a brief or a source file:
//
//   tool.list                 which grants can actually fire, and which are grants on nodes that
//                             never reach a model runner (dead by construction, not by policy).
//   node.get_effective_tools  a node's grants AND the tenant verbs its route calls regardless of
//                             them — the half no grant list has ever shown.
//   tool.list_executions      caller / routeId filters: "what did engine code call on this run".
//   project.get.usedBy        who has actually reached this tenant, from the ledger rather than
//                             from intent.

const tools = () => createWorkspaceTools({});
const call = async <T>(name: string, input: unknown): Promise<T> => {
  const tool = tools().find((candidate) => candidate.name === name);
  expect(tool, `${name} must exist on the workspace surface`).toBeDefined();
  return (await tool!.execute(input)) as T;
};

beforeEach(() => {
  resetRepositoryManager();
});

describe("W4.1 — tool.list reports reachability, not just registration", () => {
  it("separates who was granted a tool from who can actually call it", async () => {
    const result = await call<{ data: { tools: Array<{ toolId: string; reachability: { grantedBy: string[]; reachableFrom: string[]; dead: boolean } }> } }>("tool.list", {});
    const byId = new Map(result.data.tools.map((tool) => [tool.toolId, tool]));

    // Every tool reports the shape, so a reader never has to guess whether an absent field means
    // "unreachable" or "not computed".
    for (const tool of result.data.tools) {
      expect(Array.isArray(tool.reachability.grantedBy)).toBe(true);
      expect(Array.isArray(tool.reachability.reachableFrom)).toBe(true);
      // reachableFrom is always a subset of grantedBy — it is the model-dispatched half of it.
      for (const nodeId of tool.reachability.reachableFrom) expect(tool.reachability.grantedBy).toContain(nodeId);
    }

    // THE FINDING THIS VERB EXISTS FOR, as a live assertion rather than a number in a brief: the
    // capture and clone stage tools are granted to nodes that terminate in a deterministic route, so
    // the grant can never fire. `dead` says exactly that, and says it only when there IS a grant —
    // a tool nobody grants is not dead, it is reachable from other surfaces and from tool.test.
    const dead = result.data.tools.filter((tool) => tool.reachability.dead).map((tool) => tool.toolId);
    expect(dead.length).toBeGreaterThan(0);
    for (const toolId of dead) {
      expect(byId.get(toolId)!.reachability.grantedBy.length).toBeGreaterThan(0);
      expect(byId.get(toolId)!.reachability.reachableFrom).toEqual([]);
    }
  });
});

describe("W4.1 — node.get_effective_tools reports the engine half", () => {
  it("names the tenant verbs a deterministic node's route calls, which no grant list shows", async () => {
    const result = await call<{ data: { engine: Array<{ verb: string; risk: string }> } }>("node.get_effective_tools", { nodeId: "visual_standard_materializer" });
    // The sharpest case in the W3.1 audit: riskLevel admin, allowedTools [], six tenant verbs.
    expect(result.data.engine.map((tool) => tool.verb)).toContain("site_apply_brand_imagery");
    expect(result.data.engine.find((tool) => tool.verb === "site_apply_brand_imagery")!.risk).toBe("admin");
  });

  it("reports an empty engine list for a model node, which reaches a tenant only through a grant", async () => {
    const result = await call<{ data: { engine: unknown[]; resolvedAgainst: string } }>("node.get_effective_tools", { nodeId: "article_body" });
    expect(result.data.engine).toEqual([]);
    expect(result.data.resolvedAgainst).toBe("node_declaration");
  });
});

describe("W4.1 — the ledger's own filters", () => {
  const record = (over: Record<string, unknown>) => repositoryManager.getToolExecutionRepository().record({
    toolExecutionId: `tex_${Math.random().toString(36).slice(2, 8)}`,
    runId: "run_w41", nodeId: "release_executor", toolId: "release_to_production",
    startedAt: new Date().toISOString(), status: "success", inputSummary: {},
    riskLevel: "publish", approvalStatus: "not_required",
    caller: "engine", routeId: "release_executor", projectId: "dr-lurie",
    ...over
  } as never);

  it("filters by caller and routeId, and skips the stub fallback when it does", async () => {
    await record({});
    await record({ nodeId: "article_body", toolId: "object_get", caller: "model", routeId: undefined });

    const engine = await call<{ data: { executions: Array<{ toolId: string; source?: string }> } }>("tool.list_executions", { runId: "run_w41", caller: "engine" });
    expect(engine.data.executions.map((execution) => execution.toolId)).toEqual(["release_to_production"]);
    // A caller/routeId query is a question only the ledger can answer, so no run-record stub is mixed
    // in — a stub carries no caller and could never satisfy the filter it was returned for.
    expect(engine.data.executions.every((execution) => execution.source === "tool_execution_ledger")).toBe(true);

    const byRoute = await call<{ data: { executions: unknown[] } }>("tool.list_executions", { runId: "run_w41", routeId: "release_executor" });
    expect(byRoute.data.executions).toHaveLength(1);
  });

  it("finds one record by id when the run is named, and falls back honestly when it is not", async () => {
    await repositoryManager.getToolExecutionRepository().record({
      toolExecutionId: "tex_known", runId: "run_w41b", nodeId: "publish_executor", toolId: "object_publish",
      startedAt: new Date().toISOString(), status: "success", inputSummary: {}, riskLevel: "publish",
      approvalStatus: "not_required", caller: "engine", projectId: "dr-lurie"
    } as never);
    const found = await call<{ data: { execution: { toolId?: string } | null; source?: string } }>("tool.get_execution", { toolExecutionId: "tex_known", runId: "run_w41b" });
    expect(found.data.execution?.toolId).toBe("object_publish");
  });
});

describe("W4.1 — project.get.usedBy", () => {
  it("reports who has actually reached the tenant, per node, with callers and verbs", async () => {
    await repositoryManager.getToolExecutionRepository().record({
      toolExecutionId: "tex_used_1", runId: "run_used", nodeId: "publish_executor", toolId: "object_publish",
      startedAt: "2026-09-09T10:00:00.000Z", status: "success", inputSummary: {}, riskLevel: "publish",
      approvalStatus: "not_required", caller: "engine", projectId: "dr-lurie"
    } as never);
    await repositoryManager.getToolExecutionRepository().record({
      toolExecutionId: "tex_used_2", runId: "run_used", nodeId: "publish_executor", toolId: "object_checkout",
      startedAt: "2026-09-09T10:00:01.000Z", status: "success", inputSummary: {}, riskLevel: "write",
      approvalStatus: "not_required", caller: "engine", projectId: "dr-lurie"
    } as never);

    const result = await call<{ data: { usedBy: { sampledCalls: number; nodes: Array<{ nodeId: string; calls: number; callers: string[]; verbs: string[] }> } } }>("project.get", { projectId: "dr-lurie" });
    expect(result.data.usedBy.sampledCalls).toBe(2);
    const [entry] = result.data.usedBy.nodes;
    expect(entry.nodeId).toBe("publish_executor");
    expect(entry.calls).toBe(2);
    expect(entry.callers).toEqual(["engine"]);
    expect(entry.verbs).toEqual(["object_checkout", "object_publish"]);
  });

  it("says nothing rather than something for a tenant nothing has called", async () => {
    const result = await call<{ data: { usedBy: { sampledCalls: number; nodes: unknown[] } } }>("project.get", { projectId: "dr-lurie" });
    expect(result.data.usedBy.sampledCalls).toBe(0);
    expect(result.data.usedBy.nodes).toEqual([]);
  });
});
