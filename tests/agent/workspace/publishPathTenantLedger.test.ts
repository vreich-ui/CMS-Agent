import { beforeEach, describe, expect, it } from "vitest";
import { executeObjectPublish } from "../../../src/agent/workspace/objectPublishExecution.js";
import { runDeterministicReleaseExecutor } from "../../../src/agent/workspace/releaseExecution.js";
import { tenantCallToolFor } from "../../../src/agent/tools/tenantInvoke.js";
import { PROJECT_VERB_AUTHORIZED_NODE_IDS } from "../../../src/agent/tools/forbiddenProjectVerbs.js";
import { __test__ } from "../../../src/agent/workspace/executor.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import type { McpTransport } from "../../../src/agent/projects/mcpClient.js";
import type { ObjectPublishPlan } from "../../../src/agent/workspace/objectPublishExecution.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// ACCEPTANCE — W3.2.2 (2026-09-09). The publish path, through the choke point.
//
// This is the commit the whole wave was ordered around: the publish path went last, on its own,
// because it is the one path where getting the migration wrong means a tenant publishes something it
// should not — or fails to publish something it should.
//
// The acceptance the brief set is exact: a fixture publish run must show `object_publish`,
// `release_to_production` and `deploy_status` in `tool.list_executions` with `caller: "engine"`.
// Before this wave, `tool.list_executions` COULD NOT show any of the three at any time, for any run,
// because none of them passed through the tool executor at all — that is the hole, stated as a test.

const config: ProjectConnectionConfig = {
  projectId: "dr-lurie",
  name: "Dr Lurie",
  mcpEndpointEnvVar: "DRLURIE_MCP_ENDPOINT",
  tokenEnvVar: "DRLURIE_MCP_TOKEN",
  allowedTools: [],
  defaultToolPolicy: "allowed",
  status: "active"
} as unknown as ProjectConnectionConfig;

const env = { DRLURIE_MCP_ENDPOINT: "https://drlurie.example/mcp", DRLURIE_MCP_TOKEN: "t" } as unknown as NodeJS.ProcessEnv;

// One stub tenant. It answers every verb the publish path speaks, in the shape each reader expects:
// a lock token for checkout, a commit sha for publish, a ready deploy for the release poll.
const transport: McpTransport = async (_endpoint, init) => {
  const request = JSON.parse(init.body as string) as { id: number; params?: { name?: string } };
  const name = request.params?.name;
  const structuredContent =
    name === "object_checkout" ? { lock_token: "lock_1" }
    : name === "object_publish" ? { published: true, object_id: "obj_1", published_time: "2026-09-09T00:00:00.000Z", receipt: { commit_sha: "abc1234" } }
    : name === "release_to_production" ? { released: true, release_id: "rel_1", commit: "abc1234", deployed_sha: "abc1234" }
    : name === "deploy_status" ? { status: "ready", deploy_id: "dep_1", commit: "abc1234", published_at: "2026-09-09T00:00:00.000Z" }
    : {};
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent } }), { status: 200, headers: { "content-type": "application/json" } });
};

const RUN_ID = "run_publish_ledger_1";

const plan: ObjectPublishPlan = {
  schemaVersion: "object_publish_plan.v1",
  target: "dr-lurie",
  publish: [{ objectId: "obj_1", objectType: "article", phase: "draft" }],
  withheld: [],
  release: true,
  forbiddenVerbs: []
};

const committedRun = (): Pick<WorkflowExecutionRecord, "runId" | "stageOutputs" | "operatorPublishDecision" | "publishingPolicySnapshot" | "releaseLedger"> => ({
  runId: RUN_ID,
  stageOutputs: {
    publish_executor: {
      artifact: "publish_execution.v1",
      status: "published_pending_release",
      publishCommitted: true,
      receipts: { requestId: "req_publish_ledger_1", commitSha: "abc1234", objectId: "obj_1" }
    }
  },
  operatorPublishDecision: "approved",
  publishingPolicySnapshot: { autonomyMode: "operator-gated", publishEnabled: true }
});

beforeEach(() => {
  resetRepositoryManager();
});

describe("W3.2.2 — a publish run's tenant verbs are in the ledger", () => {
  it("records object_publish, release_to_production and deploy_status with caller:\"engine\"", async () => {
    // The publish half, exactly as captureConductorRoutes / cloneConductorRoutes build it: the plan's
    // objects through the choke point, attributed to publish_executor.
    const publishResult = await executeObjectPublish({
      plan,
      callTool: tenantCallToolFor({
        projectId: config.projectId, project: config, adapterDeps: { env, transport },
        caller: "engine", runId: RUN_ID, nodeId: "publish_executor"
      })
    });
    expect(publishResult.published.map((entry) => entry.objectId)).toEqual(["obj_1"]);

    // The release half, exactly as executor.ts builds it.
    const released = await runDeterministicReleaseExecutor({
      run: committedRun(),
      requestId: "req_publish_ledger_1",
      deps: {
        callTool: tenantCallToolFor({
          projectId: config.projectId, project: config, adapterDeps: { env, transport },
          caller: "engine", runId: RUN_ID, nodeId: "release_executor", routeId: "release_executor"
        })
      }
    });
    expect(released.ok).toBe(true);

    const ledger = await repositoryManager.getToolExecutionRepository().list({ runId: RUN_ID, caller: "engine" });
    const verbs = ledger.map((record) => record.toolId);
    expect(verbs).toContain("object_publish");
    expect(verbs).toContain("release_to_production");
    expect(verbs).toContain("deploy_status");
    // The lock verbs a publish always speaks around the publish itself are there too — the ledger
    // shows the sequence, not just its headline.
    expect(verbs).toContain("object_checkout");
    expect(ledger.every((record) => record.caller === "engine" && record.projectId === "dr-lurie")).toBe(true);

    // release_executor is the one publish-path route with a manifest, and it lists both its verbs —
    // so neither is flagged. Nothing on this path may cry wolf.
    const release = ledger.filter((record) => record.nodeId === "release_executor");
    expect(release.map((record) => record.routeId)).toEqual(release.map(() => "release_executor"));
    expect(ledger.some((record) => record.engineVerbUnlisted)).toBe(false);
  });

  it("answers the same question through tool.list_executions, which could not answer it at all before", async () => {
    await executeObjectPublish({
      plan,
      callTool: tenantCallToolFor({
        projectId: config.projectId, project: config, adapterDeps: { env, transport },
        caller: "engine", runId: RUN_ID, nodeId: "publish_executor"
      })
    });

    const tools = createWorkspaceTools();
    const listExecutions = tools.find((tool) => tool.name === "tool.list_executions");
    expect(listExecutions).toBeDefined();
    const result = await listExecutions!.execute({ runId: RUN_ID, caller: "engine" }) as { data: { executions: Array<Record<string, unknown>> } };
    const executions = result.data.executions;
    expect(executions.map((execution) => execution.toolId)).toContain("object_publish");
    expect(executions.every((execution) => execution.caller === "engine")).toBe(true);
    expect(executions.every((execution) => execution.source === "tool_execution_ledger")).toBe(true);
  });

  // THE GUARD THAT MAKES THE ABOVE SAFE TO SHIP.
  //
  // The publish path now attributes its calls to the DISPATCHED node's real id, and the forbidden-verb
  // rule exempts exactly two ids. If a workflow's publish or release node were ever named something
  // else, that publish would be refused at run time rather than mis-attributed — a failure mode worse
  // than the hole this wave closes. So the rename is caught HERE, at build time, across every
  // conductor workflow rather than the one this test happens to fixture.
  it("keeps every conductor workflow's publish and release node on an exempt id", async () => {
    const publishNodes = new Map<string, string>();
    for (const workflowId of ["publishing_conductor", "capture_conductor", "clone_conductor", "visual_identity"]) {
      for (const node of await __test__.resolveConductorNodes(undefined, workflowId)) {
        if (node.kind === "releaser" || node.riskLevel === "publish") publishNodes.set(`${workflowId}:${node.id}`, node.id);
      }
    }
    expect(publishNodes.size).toBeGreaterThan(0);
    // pdf_template_publish is the one publish-risk node that speaks NO forbidden verb — it publishes a
    // pdf-tool template through publish_pdf_template, which is not object_publish and never was (see
    // routeRegistry's clone_stage/pdf_publish). It needs no exemption, so it is named here rather than
    // silently filtered.
    const needExemption = [...publishNodes.values()].filter((nodeId) => nodeId !== "pdf_template_publish" && nodeId !== "publication_controller" && nodeId !== "publish_payload");
    for (const nodeId of needExemption) {
      expect(PROJECT_VERB_AUTHORIZED_NODE_IDS.has(nodeId), `${nodeId} speaks a publish verb from engine code but is not exempt from FORBIDDEN_PROJECT_VERBS`).toBe(true);
    }
  });

  // THE INVARIANT THIS PATH EXISTS UNDER. AGENTS.md invariant 4: in engine code
  // release_to_production is called only by release_executor and object_publish only by
  // publish_executor. The choke point now enforces exactly that, on the same rule the model path has
  // always used — so if a future route starts speaking a publish verb from a third node, the call is
  // refused here rather than reaching the tenant.
  it("refuses the same verbs from any other node", async () => {
    const fromWrongNode = tenantCallToolFor({
      projectId: config.projectId, project: config, adapterDeps: { env, transport },
      caller: "engine", runId: RUN_ID, nodeId: "publication_controller"
    });
    await expect(fromWrongNode("object_publish", { object_id: "obj_1" })).rejects.toThrow(/publish_verb_not_permitted/);
    await expect(fromWrongNode("release_to_production", {})).rejects.toThrow(/publish_verb_not_permitted/);
  });
});
