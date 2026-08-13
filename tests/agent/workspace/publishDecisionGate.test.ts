import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { publishRun, publishEnabledEnvVar } from "../../../src/agent/workspace/publisher.js";
import { enforcePublishExecutionEvidence, findPublicationDecision, readPublicationDecision } from "../../../src/agent/workspace/publishDecision.js";
import { evaluatePublishExecutionGate } from "../../../src/agent/workspace/publishExecution.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { CallToolResult } from "../../../src/agent/projects/projectMcpAdapter.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// P0 acceptance (§4 definition of done):
//   (a) a controller output of {"artifact":"publication_decision.v1","summary":"Looks fine."} blocks;
//   (b) an explicit affirmative decision (decision: "go") allows publish with the other gates met;
//   (c) status "executed" cannot be emitted without deployStatus "ready" AND productionConfirmed true;
//   (d) the operator veto (run.operatorPublishDecision: "withheld") blocks; veto absent + approval
//       present allows.

const envelope = (body: unknown) => ({
  artifact: "client_object.v1",
  summary: "Reader-facing body assembled for the publish decision gate tests.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "get_content_schema", fetchedAt: "2026-08-10T00:00:00.000Z" },
  body
});
const textBody = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "Live Title", body: "Reader-facing body." } }] });
const REQUEST_ID = "req_publish_decision_20260810_01";
const ENABLED_ENV = { [publishEnabledEnvVar(drLurieProjectConfig)]: "true" } as NodeJS.ProcessEnv;
const READY = {
  taxonomy: { tags: ["science", "longevity"] },
  approval: { pinned: true, approvedBy: "editor@dr-lurie" },
  releaseBehavior: "publish_now",
  hardConstraints: { contentPath: "client_object.v1", artifactProtocol: "pdf_tool_dr_lurie_blob.v1", legacyFallbacksUsed: false }
};
const GO_DECISION = { artifact: "publication_decision.v1", summary: "Controller explicitly authorizes this publish.", decision: "go", blockers: [] };
const PROSE_ONLY_DECISION = { artifact: "publication_decision.v1", summary: "Looks fine." };

const fakeCallTool = () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fn = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    calls.push({ tool, args });
    if (tool === "object_create") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { structuredContent: { object_id: REQUEST_ID } } };
    if (tool === "object_checkout") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { structuredContent: { lock_token: "lock_123", record_version: 2 } } };
    if (tool === "object_validate") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { structuredContent: { valid: true, issues: [] } } };
    if (tool === "object_publish") return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { ok: true, statusCode: 201 } };
    return { ok: true, projectId: "dr-lurie", connection: {} as any, tool, result: { ok: true } };
  };
  return { fn, calls };
};

const seedRun = async (decision?: unknown) => {
  const manager = new RepositoryManager();
  const executionRepository = manager.getExecutionRepository();
  const projectRepository = manager.getProjectRepository();
  const learningRepository = manager.getLearningRepository();
  const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "publish", entrypoint: { nodeId: "article_body", output: textBody } }, executionRepository);
  if (decision !== undefined) {
    const record = (await executionRepository.getRun(run.runId))!;
    record.stageOutputs.publication_controller = decision;
    await executionRepository.saveRun(record);
  }
  return { runId: run.runId, executionRepository, projectRepository, learningRepository };
};

describe("P0 §2.1 — refuse-by-default publication decision (publishRun)", () => {
  it("(a) a prose-only controller record — {\"artifact\":\"publication_decision.v1\",\"summary\":\"Looks fine.\"} — blocks the publish with zero external calls", async () => {
    const ctx = await seedRun(PROSE_ONLY_DECISION);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(result.published).toBe(false);
    expect(result.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(0);
    if (result.mode === "dry_run") {
      const gate = result.gates.gates.find((candidate) => candidate.name === "controller_decision_go");
      expect(gate?.passed).toBe(false);
      expect(gate?.reason).toContain("controller_decision_absent");
      expect(result.reason).toContain("publication_decision_not_affirmative");
    }
  });

  it("an absent controller record blocks — silence never authorizes", async () => {
    const ctx = await seedRun();
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.published).toBe(false);
    expect(result.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(0);
    if (result.mode === "dry_run") expect(result.gates.gates.find((candidate) => candidate.name === "controller_decision_go")?.passed).toBe(false);
  });

  it("(b) an explicit affirmative decision (decision: \"go\") publishes when every other gate is met", async () => {
    const ctx = await seedRun(GO_DECISION);
    const adapter = fakeCallTool();
    const result = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(result.published).toBe(true);
    expect(result.mode).toBe("live");
    expect(adapter.calls.map((call) => call.tool)).toEqual(["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"]);
  });

  it("reads the decision refuse-by-default: only an unambiguous go authorizes", () => {
    expect(readPublicationDecision(GO_DECISION)).toEqual({ authorized: true, decision: "go" });
    // Every one of these refuses with a named code — none may resolve to publish.
    const refusals: Array<[unknown, string]> = [
      [undefined, "controller_decision_missing"],
      [null, "controller_decision_missing"],
      ["not json {", "controller_decision_unparseable"],
      [42, "controller_decision_unparseable"],
      [PROSE_ONLY_DECISION, "controller_decision_absent"],
      [{ ...GO_DECISION, artifact: "something_else.v1" }, "controller_decision_wrong_artifact"],
      [{ ...GO_DECISION, decision: "no_go" }, "controller_decision_not_go"],
      [{ ...GO_DECISION, decision: "maybe" }, "controller_decision_not_go"],
      [{ ...GO_DECISION, decision: true }, "controller_decision_absent"],
      [{ ...GO_DECISION, blockers: ["client validation stale"] }, "controller_decision_blockers_present"],
      [{ ...GO_DECISION, blockers: "none" }, "controller_decision_blockers_malformed"],
      [{ ...GO_DECISION, dryRun: true }, "controller_decision_placeholder"]
    ];
    for (const [record, code] of refusals) {
      const read = readPublicationDecision(record);
      expect(read.authorized, `${JSON.stringify(record)} must refuse`).toBe(false);
      if (!read.authorized) expect(read.code).toBe(code);
    }
  });
});

describe("P0 §2.1 — the publish_executor node cannot dispatch without an explicit go (executor guard)", () => {
  const savedKey = process.env.OPENAI_API_KEY;
  beforeEach(() => { delete process.env.OPENAI_API_KEY; });
  afterEach(() => { if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; });

  // Craft a LIVE-mode run parked directly in front of publish_executor with a chosen controller
  // record, so the pre-dispatch guard is exercised without any model call: a refusal blocks BEFORE
  // the runner, and a pass reaches the runner (which then fails loudly on the missing API key —
  // proof the guard let it through).
  const parkBeforeExecutor = async (decision: unknown) => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "live publish" }, store);
    const record = (await store.getRun(run.runId))!;
    for (const node of record.nodes) {
      if (node.nodeId === "publish_executor") continue;
      node.status = "completed";
      node.startedAt = record.startedAt;
      node.completedAt = record.startedAt;
    }
    record.stageOutputs.publication_controller = decision;
    record.status = "queued";
    record.currentNodeId = "publish_executor";
    await store.saveRun(record);
    return { runId: run.runId, store };
  };

  it("blocks publish_executor before any dispatch when the controller decision is not an explicit go, even with approved:true", async () => {
    const { runId, store } = await parkBeforeExecutor(PROSE_ONLY_DECISION);
    const result = await runNextNode(runId, { executionRepository: store, approved: true });

    expect(result.status).toBe("blocked");
    const state = result.nodes.find((node) => node.nodeId === "publish_executor")!;
    expect(state.status).toBe("blocked");
    expect(state.warnings).toContain("publication_decision_not_affirmative");
    expect(state.warnings).toContain("no_publication_performed");
    expect((state.output as { reason: string }).reason).toContain("controller_decision_absent");
  });

  it("lets publish_executor reach its runner when the decision is an explicit go (the guard, not the runner, is what refused above)", async () => {
    const { runId, store } = await parkBeforeExecutor(GO_DECISION);
    const result = await runNextNode(runId, { executionRepository: store, approved: true });

    // Past the guard: the node was DISPATCHED and failed in the runner on the missing API key —
    // an invalid_node_configuration failure, not a publication_decision block.
    const state = result.nodes.find((node) => node.nodeId === "publish_executor")!;
    expect(state.status).toBe("failed");
    expect(state.errors?.[0]).toBe("invalid_node_configuration");
    expect(state.warnings ?? []).not.toContain("publication_decision_not_affirmative");
  });

  it("locates the decision record where downstream nodes consume it (stage output, node output fallback)", async () => {
    const fromStage = { stageOutputs: { publication_controller: GO_DECISION }, nodes: [] } as unknown as WorkflowExecutionRecord;
    expect(findPublicationDecision(fromStage)).toBe(GO_DECISION);
    const fromNode = { stageOutputs: {}, nodes: [{ nodeId: "publication_controller", status: "completed", output: GO_DECISION }] } as unknown as WorkflowExecutionRecord;
    expect(findPublicationDecision(fromNode)).toBe(GO_DECISION);
  });
});

describe("P0 §2.3/§2.27 — status \"executed\" requires go-live evidence and a matched operator approval", () => {
  const executorSchema = () => getWorkspaceNode("publish_executor")!.outputSchema;
  const base = {
    artifact: "publish_execution.v1",
    summary: "Publish executed.",
    clientProjectId: "dr-lurie",
    clientObjectType: "content_item",
    contractSource: { tool: "object_contract" },
    publishPolicyChecked: true,
    blockers: [] as unknown[]
  };
  const executedNoEvidence = { ...base, status: "executed", approvalMatched: true };
  const executedWithEvidence = { ...base, status: "executed", approvalMatched: true, result: { ok: true, commit: "abc123" }, verification: { deployAware: true, deployStatus: "ready", productionConfirmed: true, goLiveConfirmed: true } };

  it("(c) the output schema structurally rejects \"executed\" without deployStatus \"ready\" + productionConfirmed true", () => {
    expect(validateOutput(executedNoEvidence, executorSchema()).ok).toBe(false);
    expect(validateOutput({ ...executedWithEvidence, verification: { deployStatus: "queued", productionConfirmed: true } }, executorSchema()).ok).toBe(false);
    expect(validateOutput({ ...executedWithEvidence, verification: { deployStatus: "ready", productionConfirmed: false } }, executorSchema()).ok).toBe(false);
    expect(validateOutput({ ...executedWithEvidence, approvalMatched: false }, executorSchema()).ok).toBe(false);
    // Full evidence validates; and blocked/skipped need no evidence at all.
    expect(validateOutput(executedWithEvidence, executorSchema()).ok).toBe(true);
    expect(validateOutput({ ...base, status: "blocked", approvalMatched: false }, executorSchema()).ok).toBe(true);
    expect(validateOutput({ ...base, status: "skipped", approvalMatched: false }, executorSchema()).ok).toBe(true);
    // Both persisted copies of the schema carry the conditional.
    const node = getWorkspaceNode("publish_executor")!;
    expect(JSON.stringify(node.schema)).toContain("productionConfirmed");
    expect(JSON.stringify(node.outputSchema)).toContain("productionConfirmed");
  });

  it("deterministically downgrades an unevidenced \"executed\" claim to blocked even if schema validation were bypassed", () => {
    const enforced = enforcePublishExecutionEvidence(executedNoEvidence, { operatorPublishDecision: "approved" });
    expect(enforced.downgraded).toBe(true);
    expect((enforced.output as { status: string }).status).toBe("blocked");
    expect((enforced.output as { blockers: string[] }).blockers.join(" ")).toContain("executed_without_go_live_evidence");
  });

  it("verifies approvalMatched against the operator's durable decision (run.operatorPublishDecision)", () => {
    // approvalMatched: true with no matching operator record is a false claim — downgraded.
    const noRecord = enforcePublishExecutionEvidence(executedWithEvidence, {});
    expect(noRecord.downgraded).toBe(true);
    expect((noRecord.output as { blockers: string[] }).blockers.join(" ")).toContain("approval_matched_without_operator_record");
    // A matching operator approval plus full evidence passes untouched.
    const matched = enforcePublishExecutionEvidence(executedWithEvidence, { operatorPublishDecision: "approved" });
    expect(matched.downgraded).toBe(false);
    expect(matched.output).toBe(executedWithEvidence);
    // Non-executed statuses are never touched.
    expect(enforcePublishExecutionEvidence({ ...base, status: "blocked", approvalMatched: false }, {}).downgraded).toBe(false);
  });
});

describe("P0 §2.2 — operator veto: one field, one setter, one reader", () => {
  it("(d) a withheld veto blocks publishRun regardless of every other gate; approved (veto absent) publishes", async () => {
    const ctx = await seedRun(GO_DECISION);
    await setOperatorPublishDecision(ctx.runId, "withheld", ctx.executionRepository);
    const adapter = fakeCallTool();
    const vetoed = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });

    expect(vetoed.published).toBe(false);
    expect(vetoed.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(0);
    if (vetoed.mode === "dry_run") {
      const gate = vetoed.gates.gates.find((candidate) => candidate.name === "operator_not_withheld");
      expect(gate?.passed).toBe(false);
      expect(gate?.reason).toContain("operator_publish_withheld");
    }

    // The operator replaces the veto with an explicit approval: the same run now publishes.
    await setOperatorPublishDecision(ctx.runId, "approved", ctx.executionRepository);
    const approved = await publishRun({ runId: ctx.runId, requestId: REQUEST_ID, approved: true, live: true, readiness: READY }, { ...ctx, env: ENABLED_ENV, callTool: adapter.fn });
    expect(approved.published).toBe(true);
    expect(approved.mode).toBe("live");
  });

  it("a withheld veto blocks every publish-risk node in the executor, even with approved:true (mock mode included)", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "vetoed", entrypoint: { nodeId: "article_body", output: textBody } }, store);
    await setOperatorPublishDecision(run.runId, "withheld", store);

    let current = await getRun(run.runId, store);
    for (let i = 0; current && i < 20 && !["completed", "failed", "blocked", "cancelled"].includes(current.status); i++) {
      current = await runNextNode(run.runId, { executionRepository: store, approved: true });
    }

    expect(current!.status).toBe("blocked");
    const controller = current!.nodes.find((node) => node.nodeId === "publication_controller")!;
    expect(controller.status).toBe("blocked");
    expect(controller.warnings).toContain("operator_publish_withheld");
    expect((controller.output as { reason: string }).reason).toContain("operator_publish_withheld");
  });

  it("the veto is durable on the run record and settable over MCP (workflow.set_operator_publish_decision)", async () => {
    process.env.MCP_API_TOKEN = "test-token";
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        return JSON.parse(response.body ?? "{}");
      };
      const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

      const runId = (await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: textBody })).run.runId;
      const withheld = (await data("workflow.set_operator_publish_decision", { runId, decision: "withheld" })).run;
      expect(withheld.operatorPublishDecision).toBe("withheld");
      // Durable: the persisted record carries the field, and list summaries surface it.
      expect((await data("workflow.get_run", { runId })).run.operatorPublishDecision).toBe("withheld");
      // The veto survives a reset — a reset retries the request, it does not un-say the veto.
      expect((await data("workflow.reset_run", { runId })).run.operatorPublishDecision).toBe("withheld");
      // And the setter is the only writer: replacing it is another explicit operator act.
      expect((await data("workflow.set_operator_publish_decision", { runId, decision: "approved" })).run.operatorPublishDecision).toBe("approved");
    } finally {
      delete process.env.MCP_API_TOKEN;
      resetRepositoryManager();
    }
  });
});

// T2 (2026-08-13, run_1786557897658_elj34j) — the operator publish gate becomes a per-project policy.
// A project's publishingPolicy.operatorDefault can now pre-seed a NEW run's operatorPublishDecision to
// "approved" at creation, tagged with WHICH source wrote it (operatorDecisionSource), so a receipt can
// never be misread as an operator's own explicit act. None of this changes the §2.2 gates themselves
// — an explicit "withheld" always wins, and absent policy is byte-identical to today.
describe("T2 — project publishingPolicy.operatorDefault applies at run creation", () => {
  const policyProject = (operatorDefault?: "approved" | "require_explicit"): ProjectConnectionConfig => ({
    projectId: "t2-policy-project",
    name: "T2 Policy Project",
    mcpEndpointEnvVar: "T2_POLICY_MCP_ENDPOINT",
    authMode: "bearer_env",
    tokenEnvVar: "T2_POLICY_MCP_TOKEN",
    allowedTools: [],
    contentContract: { contentContract: "content_source.v1" },
    publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "T2 test fixture.", ...(operatorDefault !== undefined ? { operatorDefault } : {}) },
    status: "active"
  });

  it("operatorDefault \"approved\" pre-seeds a new run's operatorPublishDecision, sourced project_policy_default", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    await projectRepository.save(policyProject("approved"));

    const run = await startDryRun({ executionMode: "mock", projectId: "t2-policy-project", input: "policy default" }, executionRepository, undefined, projectRepository);
    expect(run.operatorPublishDecision).toBe("approved");
    expect(run.operatorDecisionSource).toBe("project_policy_default");
  });

  it("an explicit workflow.set_operator_publish_decision call records source \"explicit\", overwriting a policy default's source", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    await projectRepository.save(policyProject("approved"));

    const run = await startDryRun({ executionMode: "mock", projectId: "t2-policy-project", input: "explicit" }, executionRepository, undefined, projectRepository);
    expect(run.operatorDecisionSource).toBe("project_policy_default");

    const reaffirmed = await setOperatorPublishDecision(run.runId, "approved", executionRepository);
    expect(reaffirmed?.operatorPublishDecision).toBe("approved");
    expect(reaffirmed?.operatorDecisionSource).toBe("explicit");
  });

  it("an explicit \"withheld\" ALWAYS wins over an \"approved\" policy default and still blocks", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    await projectRepository.save(policyProject("approved"));

    const run = await startDryRun({ executionMode: "mock", projectId: "t2-policy-project", input: "veto" }, executionRepository, undefined, projectRepository);
    expect(run.operatorPublishDecision).toBe("approved");

    const vetoed = await setOperatorPublishDecision(run.runId, "withheld", executionRepository);
    expect(vetoed?.operatorPublishDecision).toBe("withheld");
    expect(vetoed?.operatorDecisionSource).toBe("explicit");

    // The veto still blocks the deterministic publish_executor gate exactly as §2.2 requires —
    // unaffected by the prior policy default, and gate.operatorDecisionSource (T2) names the veto's
    // own source ("explicit"), never the earlier default's.
    const gate = evaluatePublishExecutionGate(vetoed!);
    expect(gate.passed).toBe(false);
    expect(gate.operatorDecisionSource).toContain("explicit");
  });

  it("absent policy — or an explicit operatorDefault \"require_explicit\" — leaves a new run's operatorPublishDecision unset (today's behavior, unchanged)", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();

    // No project registered at all for this id: applyOperatorPublishPolicyDefault treats an unknown
    // project the same as "no policy" — run creation itself never fails on it.
    const unregistered = await startDryRun({ executionMode: "mock", projectId: "t2-unregistered-project", input: "none" }, executionRepository, undefined, projectRepository);
    expect(unregistered.operatorPublishDecision).toBeUndefined();
    expect(unregistered.operatorDecisionSource).toBeUndefined();

    // A registered project that explicitly declares "require_explicit" behaves identically.
    await projectRepository.save(policyProject("require_explicit"));
    const explicitPolicy = await startDryRun({ executionMode: "mock", projectId: "t2-policy-project", input: "explicit policy" }, executionRepository, undefined, projectRepository);
    expect(explicitPolicy.operatorPublishDecision).toBeUndefined();
    expect(explicitPolicy.operatorDecisionSource).toBeUndefined();
  });
});

