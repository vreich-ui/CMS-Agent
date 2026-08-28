import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { publishRun, publishEnabledEnvVar } from "../../../src/agent/workspace/publisher.js";
import { enforcePublishExecutionEvidence, findPublicationDecision, readPublicationDecision, resolvePublishAuthority } from "../../../src/agent/workspace/publishDecision.js";
import { evaluatePublishExecutionGate } from "../../../src/agent/workspace/publishExecution.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { CallToolResult } from "../../../src/agent/projects/projectMcpAdapter.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
// S3 item 7: readiness now requires reader-visible content (article_has_content, >= 200 visible
// chars), so the fixtures carry a realistic paragraph rather than a stub.
const PAD = " This paragraph exists so the fixture reads as a real article rather than a stub: it explains the claim, names the tradeoff, and gives the reader one concrete next step to take today.".repeat(2);


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
const textBody = envelope({ schema_version: "client_object.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "Live Title", body: "Reader-facing body." + PAD } }] });
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
  const run = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "publish", entrypoint: { nodeId: "article_body", output: textBody } }, executionRepository);
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
    // T15.5 (ADR §2.4) — this project is operator-gated by default, so publishing now needs a
    // resolved publish authority; an explicit operator approval stands in for one.
    await setOperatorPublishDecision(ctx.runId, "approved", ctx.executionRepository);
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
    // T15.7 (ADR-2026-08-25-publish-autonomy §2.4, §7) — publish_executor is ALSO gated by the OUTER
    // authority gate (resolvePublishAuthority), ahead of the controller-decision guard this test means
    // to isolate; an explicit operator "approved" is what gets past that gate so the controller-decision
    // guard (and, past it, the runner) is what this test actually exercises. `approved: true` on the
    // dispatch call is inert — deprecated as an authority input.
    await setOperatorPublishDecision(runId, "approved", store);
    const result = await runNextNode(runId, { executionRepository: store });

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
    // T15.5 (ADR §8) — approvalMatched is checked against the run's resolved publish authority
    // (publishDecision.resolvePublishAuthority), not literally "operatorPublishDecision === approved"
    // any more; an absent decision on an operator-gated run (the default here) still refuses.
    expect((noRecord.output as { blockers: string[] }).blockers.join(" ")).toContain("approval_matched_without_authority");
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
    const run = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "vetoed", entrypoint: { nodeId: "article_body", output: textBody } }, store);
    await setOperatorPublishDecision(run.runId, "withheld", store);

    let current = await getRun(run.runId, store);
    for (let i = 0; current && i < 20 && !["completed", "failed", "blocked", "cancelled"].includes(current.status); i++) {
      current = await runNextNode(run.runId, { executionRepository: store, approved: true });
    }

    expect(current!.status).toBe("blocked");
    const controller = current!.nodes.find((node) => node.nodeId === "publication_controller")!;
    expect(controller.status).toBe("blocked");
    expect(controller.warnings).toContain("operator_publish_withheld");
    // T15.7: the output's own `reason` text is now resolvePublishAuthority's own message, prefixed
    // with its code ("operator_withheld", not "operator_publish_withheld" — that longer name lives on
    // in the WARNING above, unchanged); the state.warnings assertion above is what still names the
    // veto for a reader scanning warnings, and this checks the reason text says the same thing.
    expect((controller.output as { reason: string }).reason).toContain("operator_withheld");
    expect((controller.output as { reason: string }).reason).toContain("withheld");
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

      const runId = (await data("workflow.start_dry_run", { executionMode: "openai", projectId: "dr-lurie", requestId: REQUEST_ID, input: {}, entrypoint: "article_body", articleBody: textBody })).run.runId;
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

// T15.5 (ADR-2026-08-25-publish-autonomy §2.4) — the operator publish gate now resolves through a
// single reader, resolvePublishAuthority, against a project's publishingPolicy.autonomyMode. This
// SUBSUMES the old operatorDefault field: autonomyMode never stamps run.operatorPublishDecision at
// run creation (invariant 4 — nothing but workflow.set_operator_publish_decision writes that field).
// Instead, run creation captures a run.publishingPolicySnapshot, and the resolver reads ONLY that
// snapshot plus the run's own operatorPublishDecision — so two runs of the same project resolve
// identically, and editing the project's policy after a run starts can never change that run's
// resolution (invariant 7, determinism). An explicit "withheld" always wins, in every mode
// (invariant 2).
describe("T15.5 — project publishingPolicy.autonomyMode resolves publish authority via the run's snapshot", () => {
  const policyProject = (autonomyMode?: "autonomous" | "operator-gated"): ProjectConnectionConfig => ({
    projectId: "t2-policy-project",
    name: "T2 Policy Project",
    mcpEndpointEnvVar: "T2_POLICY_MCP_ENDPOINT",
    authMode: "bearer_env",
    tokenEnvVar: "T2_POLICY_MCP_TOKEN",
    allowedTools: [],
    contentContract: { contentContract: "content_source.v1" },
    publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "T2 test fixture.", ...(autonomyMode !== undefined ? { autonomyMode } : {}) },
    status: "active"
  });

  it("autonomyMode \"autonomous\" is captured into the new run's publishingPolicySnapshot, WITHOUT stamping operatorPublishDecision", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    await projectRepository.save(policyProject("autonomous"));

    const run = await startDryRun({ executionMode: "openai", projectId: "t2-policy-project", input: "policy default" }, executionRepository, undefined, projectRepository);
    expect(run.publishingPolicySnapshot?.autonomyMode).toBe("autonomous");
    // Invariant 4: an autonomy policy is never fabricated into an operator's own decision field.
    expect(run.operatorPublishDecision).toBeUndefined();
    expect(run.operatorDecisionSource).toBeUndefined();
  });

  it("an absent operatorPublishDecision resolves authorized (source policy_autonomous) under an autonomous snapshot, and unauthorized under an operator-gated one", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    await projectRepository.save(policyProject("autonomous"));

    const autonomous = await startDryRun({ executionMode: "openai", projectId: "t2-policy-project", input: "autonomous" }, executionRepository, undefined, projectRepository);
    // Note: .passed also requires the controller's "go", which these fixtures never stage — these
    // assertions check the AUTHORITY half of the gate (.operatorApproved / .authoritySource) in
    // isolation, which is exactly what autonomyMode governs.
    const autonomousGate = evaluatePublishExecutionGate(autonomous);
    expect(autonomousGate.operatorApproved).toBe(true);
    expect(autonomousGate.authoritySource).toBe("policy_autonomous");

    await projectRepository.save(policyProject("operator-gated"));
    const gated = await startDryRun({ executionMode: "openai", projectId: "t2-policy-project", input: "gated" }, executionRepository, undefined, projectRepository);
    expect(gated.publishingPolicySnapshot?.autonomyMode).toBe("operator-gated");
    const gatedGate = evaluatePublishExecutionGate(gated);
    expect(gatedGate.operatorApproved).toBe(false);
    expect(gatedGate.reasons.join(" ")).toContain("operator_approval_absent");

    // Absent policy (no autonomyMode declared) behaves exactly like "operator-gated" — the safe default.
    const unregistered = await startDryRun({ executionMode: "openai", projectId: "t2-unregistered-project", input: "none" }, executionRepository, undefined, projectRepository);
    expect(unregistered.publishingPolicySnapshot?.autonomyMode).toBe("operator-gated");
    expect(evaluatePublishExecutionGate(unregistered).operatorApproved).toBe(false);
  });

  it("an explicit \"approved\" via workflow.set_operator_publish_decision authorizes publish under BOTH autonomyMode policies", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();

    await projectRepository.save(policyProject("autonomous"));
    const autonomous = await startDryRun({ executionMode: "openai", projectId: "t2-policy-project", input: "explicit under autonomous" }, executionRepository, undefined, projectRepository);
    const approvedAutonomous = await setOperatorPublishDecision(autonomous.runId, "approved", executionRepository);
    expect(approvedAutonomous?.operatorDecisionSource).toBe("explicit");
    const approvedAutonomousGate = evaluatePublishExecutionGate(approvedAutonomous!);
    expect(approvedAutonomousGate.operatorApproved).toBe(true);
    expect(approvedAutonomousGate.authoritySource).toBe("operator_explicit");

    await projectRepository.save(policyProject("operator-gated"));
    const gated = await startDryRun({ executionMode: "openai", projectId: "t2-policy-project", input: "explicit under gated" }, executionRepository, undefined, projectRepository);
    const approvedGated = await setOperatorPublishDecision(gated.runId, "approved", executionRepository);
    const approvedGatedGate = evaluatePublishExecutionGate(approvedGated!);
    expect(approvedGatedGate.operatorApproved).toBe(true);
    expect(approvedGatedGate.authoritySource).toBe("operator_explicit");
  });

  it("an explicit \"withheld\" ALWAYS wins over an autonomous policy and still blocks (invariant 2)", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    await projectRepository.save(policyProject("autonomous"));

    const run = await startDryRun({ executionMode: "openai", projectId: "t2-policy-project", input: "veto" }, executionRepository, undefined, projectRepository);
    expect(evaluatePublishExecutionGate(run).operatorApproved).toBe(true);

    const vetoed = await setOperatorPublishDecision(run.runId, "withheld", executionRepository);
    expect(vetoed?.operatorPublishDecision).toBe("withheld");
    expect(vetoed?.operatorDecisionSource).toBe("explicit");

    const gate = evaluatePublishExecutionGate(vetoed!);
    expect(gate.passed).toBe(false);
    expect(gate.operatorDecisionSource).toContain("explicit");

    const authority = resolvePublishAuthority(vetoed!);
    expect(authority).toEqual({ authorized: false, code: "operator_withheld", reason: expect.any(String) });
  });

  it("a mid-run policy change does not alter an already-started run's resolution (invariant 7, determinism)", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const projectRepository = manager.getProjectRepository();
    await projectRepository.save(policyProject("autonomous"));

    const run = await startDryRun({ executionMode: "openai", projectId: "t2-policy-project", input: "snapshot pinned" }, executionRepository, undefined, projectRepository);
    expect(run.publishingPolicySnapshot?.autonomyMode).toBe("autonomous");
    const before = evaluatePublishExecutionGate(run);
    expect(before.operatorApproved).toBe(true);
    expect(before.authoritySource).toBe("policy_autonomous");

    // The project's policy is flipped to operator-gated AFTER the run was created. The run's own
    // record is untouched — evaluatePublishExecutionGate reads only the run (and its already-captured
    // snapshot), never the live project config, so re-evaluating the SAME run object must produce the
    // exact same result as before the policy edit.
    await projectRepository.save(policyProject("operator-gated"));

    const reloaded = await getRun(run.runId, executionRepository);
    expect(reloaded?.publishingPolicySnapshot?.autonomyMode).toBe("autonomous");
    const after = evaluatePublishExecutionGate(reloaded!);
    expect(after.operatorApproved).toBe(true);
    expect(after.authoritySource).toBe("policy_autonomous");
    expect(after).toEqual(before);
  });
});

describe("T15.5 — resolvePublishAuthority: the six-row precedence table, in isolation", () => {
  it("row 1: withheld halts regardless of snapshot", () => {
    expect(resolvePublishAuthority({ operatorPublishDecision: "withheld", publishingPolicySnapshot: { autonomyMode: "autonomous", publishEnabled: true } })).toMatchObject({ authorized: false, code: "operator_withheld" });
  });

  it("explicit approved authorizes regardless of snapshot", () => {
    expect(resolvePublishAuthority({ operatorPublishDecision: "approved", publishingPolicySnapshot: { autonomyMode: "operator-gated", publishEnabled: true } })).toEqual({ authorized: true, source: "operator_explicit" });
  });

  it("absent decision + autonomous snapshot authorizes with source policy_autonomous", () => {
    expect(resolvePublishAuthority({ operatorPublishDecision: undefined, publishingPolicySnapshot: { autonomyMode: "autonomous", publishEnabled: true } })).toEqual({ authorized: true, source: "policy_autonomous" });
  });

  it("absent decision + operator-gated snapshot is unauthorized", () => {
    expect(resolvePublishAuthority({ operatorPublishDecision: undefined, publishingPolicySnapshot: { autonomyMode: "operator-gated", publishEnabled: true } })).toMatchObject({ authorized: false, code: "operator_approval_absent" });
  });

  it("absent decision + absent snapshot defaults to operator-gated (unauthorized) — the safe default", () => {
    expect(resolvePublishAuthority({ operatorPublishDecision: undefined, publishingPolicySnapshot: undefined })).toMatchObject({ authorized: false, code: "operator_approval_absent" });
  });
});

// 2026-08-28, run_1787919896283_yybhg0 — a decision that outlived the body it judged.
//
// The gate reads the recorded publication_decision.v1, not the readiness it was computed from. So
// after an upstream fix rebuilt the article body, the run carried a decision made hours earlier
// against a body with no hero image: readiness said "go" with zero blockers, and the gate went on
// refusing with `controller_decision_not_go`. That reason sent the operator to a checklist that was
// entirely green, and no surface — admin chat included — offered the one action that would have
// cleared it, re-running the controller.
//
// A stale decision is therefore neither an approval nor a refusal of the current body. It is reported
// as its own condition, and the executor re-decides instead of blocking.
describe("stale publication decision — the executor re-decides instead of blocking", () => {
  const savedKey2 = process.env.OPENAI_API_KEY;
  beforeEach(() => { delete process.env.OPENAI_API_KEY; });
  afterEach(() => { if (savedKey2 !== undefined) process.env.OPENAI_API_KEY = savedKey2; });

  // Park a live run in front of publish_executor holding a body AND a controller decision that names
  // a different body — exactly the shape run_1787919896283_yybhg0 was in after its upstream fix.
  const parkWithStaleDecision = async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "openai", projectId: "dr-lurie", input: "live publish", entrypoint: { nodeId: "article_body", output: textBody } }, store);
    const record = (await store.getRun(run.runId))!;
    for (const node of record.nodes) {
      if (node.nodeId === "publish_executor") continue;
      node.status = "completed";
      node.startedAt = record.startedAt;
      node.completedAt = record.startedAt;
    }
    record.stageOutputs.article_body = textBody;
    record.stageOutputs.publication_controller = { artifact: "publication_decision.v1", decision: "no_go", blockers: ["publish_readiness: media_requested_vs_delivered"], decidedFor: { bodyFingerprint: "0000000000000000" } };
    record.operatorPublishDecision = "approved";
    record.operatorDecisionSource = "explicit";
    record.status = "queued";
    record.currentNodeId = "publish_executor";
    await store.saveRun(record);
    return { runId: run.runId, store };
  };

  it("requeues publication_controller and leaves the run running, rather than blocking on an answer about another body", async () => {
    const { runId, store } = await parkWithStaleDecision();
    const after = await runNextNode(runId, { executionRepository: store });

    const controller = after.nodes.find((node) => node.nodeId === "publication_controller")!;
    expect(controller.status, "the controller must be asked again").toBe("queued");
    expect(controller.warnings ?? []).toContain("decision_stale_requeued");
    // The out-of-date answer must be GONE, not left for the next reader to trip over.
    expect(after.stageOutputs.publication_controller).toBeUndefined();
    // And the run must not be parked as blocked — a blocked run is what needed a human to notice.
    expect(after.status).toBe("running");
    const executor = after.nodes.find((node) => node.nodeId === "publish_executor")!;
    expect(executor.warnings ?? []).not.toContain("publication_decision_not_affirmative");
  });

  // The bound, stated as a test because an unbounded version of this rule burns the continuation tick
  // forever on a run that can never move.
  it("re-decides at most once per run, then blocks with the reason named", async () => {
    const { runId, store } = await parkWithStaleDecision();
    const first = await runNextNode(runId, { executionRepository: store });
    expect(first.nodes.find((node) => node.nodeId === "publication_controller")!.status).toBe("queued");

    // Simulate a re-decision that is STILL stale (a fingerprint that does not match) — the shape that
    // would loop without the bound.
    const record = (await store.getRun(runId))!;
    const controller = record.nodes.find((node) => node.nodeId === "publication_controller")!;
    controller.status = "completed";
    record.stageOutputs.publication_controller = { artifact: "publication_decision.v1", decision: "go", blockers: [], decidedFor: { bodyFingerprint: "1111111111111111" } };
    record.currentNodeId = "publish_executor";
    record.status = "queued";
    await store.saveRun(record);

    const second = await runNextNode(runId, { executionRepository: store });
    expect(second.nodes.find((node) => node.nodeId === "publication_controller")!.status, "must not requeue twice").toBe("completed");
  });

  // The guard must not turn into a re-decide loop: a decision about THIS body is enforced as written.
  it("still blocks on a current no_go, and does not requeue the controller", async () => {
    const { runId, store } = await parkWithStaleDecision();
    const record = (await store.getRun(runId))!;
    const { articleBodyFingerprint } = await import("../../../src/agent/workspace/publishDecision.js");
    record.stageOutputs.publication_controller = { artifact: "publication_decision.v1", decision: "no_go", blockers: ["publish_readiness: media_requested_vs_delivered"], decidedFor: { bodyFingerprint: articleBodyFingerprint(textBody)! } };
    await store.saveRun(record);

    const after = await runNextNode(runId, { executionRepository: store });
    expect(after.nodes.find((node) => node.nodeId === "publication_controller")!.status).toBe("completed");
    expect(after.nodes.find((node) => node.nodeId === "publish_executor")!.warnings ?? []).toContain("publication_decision_not_affirmative");
    expect(after.status).toBe("blocked");
  });
});

describe("stale publication decision (run_1787919896283_yybhg0)", () => {
  const decision = (fingerprint?: string, verdict: string = "go") => ({
    artifact: "publication_decision.v1",
    decision: verdict,
    blockers: [],
    ...(fingerprint ? { decidedFor: { bodyFingerprint: fingerprint } } : {})
  });

  it("reads as stale — not as a verdict — when the fingerprints differ", () => {
    const read = readPublicationDecision(decision("aaaaaaaaaaaaaaaa"), { bodyFingerprint: "bbbbbbbbbbbbbbbb" });
    expect(read.authorized).toBe(false);
    expect(read.authorized === false && read.code).toBe("controller_decision_stale");
    expect(read.authorized === false && read.stale).toBe(true);
    expect(read.authorized === false && read.reason).toContain("aaaaaaaaaaaaaaaa");
    expect(read.authorized === false && read.reason).toContain("bbbbbbbbbbbbbbbb");
  });

  // The case that actually bit: a stale NO_GO must not keep reporting itself as a refusal of a body
  // it never saw. This is the assertion that would have caught the original defect.
  it("reports a stale no_go as stale, never as controller_decision_not_go", () => {
    const read = readPublicationDecision(decision("aaaaaaaaaaaaaaaa", "no_go"), { bodyFingerprint: "bbbbbbbbbbbbbbbb" });
    expect(read.authorized === false && read.code).toBe("controller_decision_stale");
  });

  it("authorizes normally when the fingerprints match", () => {
    expect(readPublicationDecision(decision("aaaaaaaaaaaaaaaa"), { bodyFingerprint: "aaaaaaaaaaaaaaaa" }).authorized).toBe(true);
  });

  // Backward compatibility, in both directions: a decision recorded before decidedFor existed, and a
  // caller that supplies no expectation, are both read exactly as they always were. Nothing already in
  // flight starts refusing on a field it never had.
  it("reads a decision with no recorded fingerprint exactly as before", () => {
    expect(readPublicationDecision(decision(undefined), { bodyFingerprint: "bbbbbbbbbbbbbbbb" }).authorized).toBe(true);
    expect(readPublicationDecision(decision("aaaaaaaaaaaaaaaa")).authorized).toBe(true);
  });

  // Only a MISMATCH is stale, never a missing fingerprint. Treating "unknown" as stale would force a
  // re-decision on every run already in flight — including seeded and late-entry runs — which is churn
  // in exchange for nothing the mismatch rule does not already catch.
  it("never calls an unfingerprinted decision stale", () => {
    expect(readPublicationDecision(decision(undefined), { bodyFingerprint: "bbbbbbbbbbbbbbbb" }).authorized).toBe(true);
  });

  // The fingerprint must track what a READER sees, and nothing else: article_body re-emits
  // clientValidation, notes and assumptions on every run, and if those moved the fingerprint every
  // decision would look stale forever — the opposite failure, and a louder one.
  it("fingerprints the client object only, and is stable across key order", async () => {
    const { articleBodyFingerprint } = await import("../../../src/agent/workspace/publishDecision.js");
    const body = { slug: "a", title: "T", nodes: [{ id: "n_001", public: { body: "x" } }] };
    const base = articleBodyFingerprint({ artifact: "client_object.v1", body });
    expect(base).toBeDefined();
    expect(articleBodyFingerprint({ artifact: "client_object.v1", body, clientValidation: { valid: true }, notes: ["anything"] })).toBe(base);
    expect(articleBodyFingerprint({ body: { title: "T", nodes: body.nodes, slug: "a" } })).toBe(base);
    expect(articleBodyFingerprint({ body: { ...body, title: "CHANGED" } })).not.toBe(base);
    // No body to fingerprint is undefined — never a hash of `undefined`, which would compare equal
    // across two different absent bodies and read as "still fresh".
    expect(articleBodyFingerprint({ artifact: "client_object.v1" })).toBeUndefined();
    expect(articleBodyFingerprint(undefined)).toBeUndefined();
  });
});
