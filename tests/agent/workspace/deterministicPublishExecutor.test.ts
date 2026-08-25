import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBlockedPublishExecution,
  evaluatePublishExecutionGate,
  readPublishExecutionEnvelope,
  readPublishExecutorDeterministicMode,
  runDeterministicPublishExecutor,
  runEnginePublishExecution,
  type ExecutedPublishExecution
} from "../../../src/agent/workspace/publishExecution.js";
import type { CallToolFn } from "../../../src/agent/workspace/publisher.js";
import { enforcePublishExecutionEvidence } from "../../../src/agent/workspace/publishDecision.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// W2a (determinism program, 2026-08-12). publish_executor is the ONE node that can mutate a live site.
// This suite proves:
//   (1) the gate is exactly two comparisons — an explicit controller decision:"go" AND
//       run.operatorPublishDecision === "approved" — and fails closed on every other shape;
//   (2) a closed gate produces a schema-valid blocked publish_execution.v1 with ZERO client calls
//       (bit-for-bit the outcome verified live on run_1786468126136_ev9goe: controller "go", operator
//       decision absent, no side effects);
//   (3) a PASSING gate deliberately does NOT execute deterministically — it returns
//       gate_passed_execution_not_deterministic so the executor falls through to the model path;
//   (4) wired into a real run the refusal costs nothing: no model call, no usage record, no fetch.

const goDecision = () => ({ artifact: "publication_decision.v1", summary: "Ready.", decision: "go", blockers: [] });

const runWith = (decision: unknown, operatorPublishDecision?: "approved" | "withheld") => ({
  stageOutputs: decision === undefined ? {} : { publication_controller: decision },
  nodes: [],
  ...(operatorPublishDecision ? { operatorPublishDecision } : {})
});

const envelopeCarrier = () => ({
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fingerprint: "fp_sample" }
});

describe("W2a — the gate is two exact comparisons, fail-closed", () => {
  it("passes only when the controller says \"go\" AND the operator record says \"approved\"", () => {
    const gate = evaluatePublishExecutionGate(runWith(goDecision(), "approved"));
    // T2 (run_1786557897658_elj34j): operatorDecisionSource rides alongside the gate, descriptive
    // only — it names WHICH source produced the "approved" record ("explicit" here, since runWith
    // stamps no operatorDecisionSource of its own and describeOperatorDecisionSource's documented
    // fallback for that shape is "explicit"). PASS/FAIL above is unaffected by its presence.
    expect(gate).toEqual({ passed: true, controllerGo: true, operatorApproved: true, reasons: [], operatorDecisionSource: "approved (source: explicit — set via workflow.set_operator_publish_decision)" });
  });

  it("refuses when the operator record is absent, even on an explicit controller \"go\" (the live run's exact shape)", () => {
    const gate = evaluatePublishExecutionGate(runWith(goDecision()));
    expect(gate.passed).toBe(false);
    expect(gate.controllerGo).toBe(true);
    expect(gate.operatorApproved).toBe(false);
    expect(gate.reasons).toHaveLength(1);
    expect(gate.reasons[0]).toMatch(/operator_approval_absent/);
    expect(gate.reasons[0]).toMatch(/expected|not "approved"/);
  });

  it("refuses a withheld operator record and a non-go controller decision, naming both", () => {
    const gate = evaluatePublishExecutionGate(runWith({ ...goDecision(), decision: "no_go" }, "withheld"));
    expect(gate.passed).toBe(false);
    expect(gate.reasons).toHaveLength(2);
    expect(gate.reasons[0]).toMatch(/controller_decision_not_go/);
    expect(gate.reasons[1]).toMatch(/operator_approval_absent/);
  });

  it.each([
    ["no decision record at all", undefined],
    ["prose approval with no decision field", { artifact: "publication_decision.v1", summary: "Looks fine." }],
    ["a go carrying open blockers", { ...goDecision(), blockers: ["artifact_unverified"] }],
    ["a dry-run placeholder", { ...goDecision(), dryRun: true }],
    ["a wrong artifact label", { ...goDecision(), artifact: "something_else.v1" }]
  ])("refuses %s even when the operator approved", (_label, decision) => {
    const gate = evaluatePublishExecutionGate(runWith(decision, "approved"));
    expect(gate.passed).toBe(false);
    expect(gate.controllerGo).toBe(false);
    expect(gate.operatorApproved).toBe(true);
  });
});

describe("W2a — the fail-closed record", () => {
  it("is schema-valid against the node's own outputSchema and reports the publish as blocked", () => {
    const result = runDeterministicPublishExecutor({ run: runWith(goDecision()), clientProjectId: "platform", envelopeCarriers: [envelopeCarrier()] });
    expect(result.ok).toBe(true);
    const output = (result as { ok: true; output: Record<string, unknown> }).output;

    expect(validateOutput(output, getWorkspaceNode("publish_executor")?.outputSchema).ok).toBe(true);
    expect(output.artifact).toBe("publish_execution.v1");
    expect(output.status).toBe("blocked");
    expect(output.approvalMatched).toBe(false);
    expect(output.publishPolicyChecked).toBe(true);
    expect(output.blockers).toHaveLength(1);
    expect(String(output.summary)).toMatch(/No client tool was called/);
    // Nothing here can be mistaken for an executed publish by the evidence enforcer.
    expect(enforcePublishExecutionEvidence(output, {}).downgraded).toBe(false);
  });

  it("carries the envelope facts verbatim from upstream and never invents them", () => {
    const built = buildBlockedPublishExecution({
      clientProjectId: "platform",
      envelope: { clientObjectType: "content_item", contractSource: { fingerprint: "fp_x" } },
      gate: evaluatePublishExecutionGate(runWith(goDecision()))
    });
    expect(built.clientObjectType).toBe("content_item");
    expect(built.contractSource).toEqual({ fingerprint: "fp_x" });

    // Nearest carrier wins; a carrier missing one half contributes only the half it has.
    expect(readPublishExecutionEnvelope({ clientObjectType: "a" }, { contractSource: { fingerprint: "f" } })).toEqual({ clientObjectType: "a", contractSource: { fingerprint: "f" } });
    expect(readPublishExecutionEnvelope({ clientObjectType: "a" })).toBeUndefined();
    expect(readPublishExecutionEnvelope(undefined, "not an object")).toBeUndefined();
  });

  it("refuses to build a record when no upstream output carries the envelope facts", () => {
    const result = runDeterministicPublishExecutor({ run: runWith(goDecision()), clientProjectId: "platform", envelopeCarriers: [{ summary: "nothing useful" }] });
    expect(result).toEqual({ ok: false, code: "publish_envelope_absent", error: expect.stringContaining("clientObjectType") });
  });

  it("does NOT execute a passing gate — the approved path stays on the model path by design", () => {
    const result = runDeterministicPublishExecutor({ run: runWith(goDecision(), "approved"), clientProjectId: "platform", envelopeCarriers: [envelopeCarrier()] });
    expect(result).toEqual({ ok: false, code: "gate_passed_execution_not_deterministic", error: expect.stringContaining("not implemented deterministically") });
  });
});

describe("wired into a real run: the refusal costs nothing", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.PLATFORM_MCP_ENDPOINT = "https://platform.example/mcp";
    process.env.PLATFORM_MCP_TOKEN = "secret-token";
    remoteFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: {} }) }) as unknown as Response);
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLATFORM_MCP_ENDPOINT;
    delete process.env.PLATFORM_MCP_TOKEN;
  });

  // Enter late-stage at publish_payload and seed the controller's decision directly, so publish_executor
  // is the only node this run dispatches. "openai" mode with no provider configured: if the deterministic
  // path did NOT fire, the model runner would attempt a real call and this test would fail.
  const startAtExecutor = async (operatorPublishDecision?: "approved", flag: unknown = true, executionMode: "openai" | "mock" = "openai") => {
    const store = new RepositoryManager().getExecutionRepository();
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.updateNode("publish_executor", { metadata: { publishExecutorDeterministic: flag } }, { actor: "w2a-test" });

    const started = await startDryRun({
      executionMode,
      projectId: "platform",
      input: "W2a e2e",
      budgetUsd: 100,
      entrypoint: {
        nodeId: "publish_payload",
        output: {
          artifact: "dry_run_publish_payload.v1",
          summary: "Candidate.",
          clientProjectId: "platform",
          clientObjectType: "content_item",
          contractSource: { tool: "object_contract", fingerprint: "fp_sample" },
          dryRun: true,
          clientObject: { slug: "s", title: "t", nodes: [] },
          blockers: []
        }
      }
    }, store, workspace);

    const run = (await getRun(started.runId, store))!;
    const controllerState = run.nodes.find((node) => node.nodeId === "publication_controller")!;
    controllerState.status = "completed";
    controllerState.output = goDecision();
    run.stageOutputs.publication_controller = goDecision();
    await store.saveRun(run);
    if (operatorPublishDecision) await setOperatorPublishDecision(started.runId, operatorPublishDecision, store);
    return { runId: started.runId, store, workspace };
  };

  it("blocks fail-closed with zero client calls, zero model calls and zero usage records when the operator has not approved", async () => {
    repositoryManager.getUsageRepository().clear();
    const { runId, store, workspace } = await startAtExecutor();

    const run = await runNextNode(runId, { executionRepository: store, workspaceRepository: workspace, approved: true });
    const state = run!.nodes.find((node) => node.nodeId === "publish_executor")!;

    expect(state.status).toBe("completed");
    const output = state.output as { artifact: string; status: string; approvalMatched: boolean; blockers: string[] };
    expect(output.artifact).toBe("publish_execution.v1");
    expect(output.status).toBe("blocked");
    expect(output.approvalMatched).toBe(false);
    expect(output.blockers[0]).toMatch(/operator_approval_absent/);
    expect(state.warnings ?? []).toContain("no_publication_performed");

    // The two facts that make this a refusal rather than a publish.
    expect(remoteFetch).not.toHaveBeenCalled();
    expect(await repositoryManager.getUsageRepository().list({ runId, nodeId: "publish_executor" })).toEqual([]);
  });

  it("falls through to the model path (and warns) once the operator HAS approved", async () => {
    const { runId, store, workspace } = await startAtExecutor("approved");

    await runNextNode(runId, { executionRepository: store, workspaceRepository: workspace, approved: true }).catch(() => undefined);
    const state = (await getRun(runId, store))!.nodes.find((node) => node.nodeId === "publish_executor")!;

    expect(state.warnings ?? []).toContainEqual(expect.stringContaining("publish_executor_deterministic_unavailable:gate_passed_execution_not_deterministic"));
    expect(state.status).not.toBe("completed");
    // T1: the fall-through is to the MODEL path, and a paid dispatch is now preceded by exactly one
    // authenticated registry_get preflight. No PUBLISH call was made — the point of this assertion.
    expect(remoteFetch).toHaveBeenCalledTimes(1);
    const preflight = JSON.parse((remoteFetch.mock.calls[0]![1] as { body: string }).body) as { params?: { name?: string } };
    expect(preflight.params?.name).toBe("registry_get");
  });

  // T4: the same refusal, on the node that opted all the way in to EXECUTION. A closed gate must cost
  // the same $0 and make the same zero calls in execute mode as it does in gate-only mode.
  it("in execute mode, a gate-blocked run still blocks with $0 model spend and no publish call at all", async () => {
    repositoryManager.getUsageRepository().clear();
    const { runId, store, workspace } = await startAtExecutor(undefined, "execute");

    const run = await runNextNode(runId, { executionRepository: store, workspaceRepository: workspace, approved: true });
    const state = run!.nodes.find((node) => node.nodeId === "publish_executor")!;
    const output = state.output as Record<string, unknown>;

    expect(state.status).toBe("completed");
    expect(output.status).toBe("blocked");
    expect(output.approvalMatched).toBe(false);
    expect(output).not.toHaveProperty("publishCommitted");
    expect(state.warnings ?? []).toContain("no_publication_performed");
    expect(remoteFetch).not.toHaveBeenCalled();
    expect(await repositoryManager.getUsageRepository().list({ runId, nodeId: "publish_executor" })).toEqual([]);
  });

  // T4 scope: LIVE runs only. A mock run keeps MockNodeRunner even with the execute flag set, so mock
  // CI traversal is untouched by anything in this change.
  it("leaves mock runs on MockNodeRunner even when the node opted into execute", async () => {
    const { runId, store, workspace } = await startAtExecutor("approved", "execute", "mock");

    const run = await runNextNode(runId, { executionRepository: store, workspaceRepository: workspace, approved: true });
    const state = run!.nodes.find((node) => node.nodeId === "publish_executor")!;
    const output = state.output as Record<string, unknown>;

    expect(state.status).toBe("completed");
    expect(output.artifact).toBe("publish_execution.v1");
    // The engine path's own fields are absent: this record came from the schema-derived mock fixture.
    expect(output).not.toHaveProperty("receipts");
    expect(output).not.toHaveProperty("publishCommitted");
    expect(state.warnings ?? []).not.toContain("publish_committed_go_live_unconfirmed");
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});

// T4 (Wave 2a, 2026-08-13) — the ENGINE-EXECUTED half. On run_1786557897658_elj34j a PASSED gate fell
// through to a model that re-derived the publish sequence (and twice got the run's own facts wrong).
// The engine now drives publisher.ts publishRun directly. These tests exercise that path against a
// STUBBED project adapter (deps.callTool), which is the same seam publishRun's own suite uses — no
// live site is reachable from here, and the assertions are about the CALLS as much as the record.

const articleBodyEnvelope = () => ({
  artifact: "client_object.v1",
  summary: "Body for the engine publish path.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fingerprint: "fp_sample" },
  body: { slug: "engine-publish", title: "Engine publish", nodes: [{ id: "n1", public: { text: "hello. This paragraph exists so the fixture reads as a real article rather than a stub: it explains the claim, names the tradeoff, and gives the reader one concrete next step to take today. It is long enough to clear the readiness content floor." } }] }
});

const enginePublishPayload = () => ({
  artifact: "dry_run_publish_payload.v1",
  summary: "Candidate.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fingerprint: "fp_sample" },
  dryRun: true,
  clientObject: { slug: "engine-publish", title: "Engine publish", nodes: [] },
  requestId: "req_w2a_engine_20260813_01",
  // The digest set the receipts must carry THROUGH (never recompute).
  artifactReferences: [{ key: "images/req_w2a_engine_20260813_01/a.png", digest: "sha256:abc123" }],
  blockers: []
});

const FULL_SEQUENCE = ["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"];

// The client's own answers, in the shapes the object dialect's tolerant readers expect.
const CLIENT_RESULTS: Record<string, unknown> = {
  object_create: { object_id: "obj_platform_9912" },
  object_checkout: { lock_token: "lock_t4", record_version: 7 },
  object_validate: { valid: true, issues: [] },
  object_patch: { record_version: 8 },
  object_publish: { status: "published", commit_sha: "9f2c1ab4", content_revision: 4 },
  object_checkin: { released: true }
};

// One stubbed project adapter. `calls` is the ordered record of what actually reached the client —
// the assertion that matters most on a failure path is what did NOT get called after it.
const stubClient = (failures: Record<string, string> = {}) => {
  const calls: string[] = [];
  const callTool = vi.fn(async (tool: string) => {
    calls.push(tool);
    return failures[tool]
      ? { ok: false, projectId: "platform", tool, error: failures[tool] }
      : { ok: true, projectId: "platform", tool, result: CLIENT_RESULTS[tool] ?? {} };
  });
  return { callTool: callTool as unknown as CallToolFn, calls };
};

const seedEngineRun = async (operatorPublishDecision?: "approved") => {
  const store = new RepositoryManager().getExecutionRepository();
  const started = await startDryRun({
    executionMode: "openai",
    projectId: "platform",
    input: "T4 engine publish",
    budgetUsd: 100,
    entrypoint: { nodeId: "article_body", output: articleBodyEnvelope() }
  }, store);
  const seeded = (await getRun(started.runId, store))!;
  seeded.stageOutputs.publish_payload = enginePublishPayload();
  seeded.stageOutputs.publication_controller = goDecision();
  await store.saveRun(seeded);
  if (operatorPublishDecision) await setOperatorPublishDecision(started.runId, operatorPublishDecision, store);
  return { store, run: (await getRun(started.runId, store))! };
};

const runEngine = async (run: Awaited<ReturnType<typeof seedEngineRun>>["run"], store: Awaited<ReturnType<typeof seedEngineRun>>["store"], client: ReturnType<typeof stubClient>) =>
  runEnginePublishExecution({
    run,
    clientProjectId: "platform",
    envelopeCarriers: [run.stageOutputs.publication_controller, run.stageOutputs.publish_payload, run.stageOutputs.article_body],
    deps: { executionRepository: store, callTool: client.callTool }
  });

const executedOutput = (result: Awaited<ReturnType<typeof runEnginePublishExecution>>): ExecutedPublishExecution =>
  (result as { ok: true; output: ExecutedPublishExecution }).output;

describe("T4 — the opt-in flag distinguishes gate-only from gate+execute", () => {
  it.each([
    ["absent", undefined, "off"],
    ["false", false, "off"],
    ["a typo'd value", "exec", "off"],
    ["true (today's gate-only opt-in)", true, "gate"],
    ["\"execute\"", "execute", "execute"]
  ])("reads %s as %s", (_label, flag, expected) => {
    expect(readPublishExecutorDeterministicMode(flag === undefined ? {} : { publishExecutorDeterministic: flag })).toBe(expected);
  });

  it("treats missing metadata as off — a node that opted into nothing keeps the model path", () => {
    expect(readPublishExecutorDeterministicMode(undefined)).toBe("off");
  });
});

describe("T4 — the engine executes the publish, and the receipts say what happened", () => {
  it("drives the project's OWN sequence in order and records real receipts from it", async () => {
    const { store, run } = await seedEngineRun("approved");
    const client = stubClient();

    const result = await runEngine(run, store, client);
    expect(result.ok).toBe(true);
    const output = executedOutput(result);

    // The sequence is the project's, executed once, in order, by the engine — not a model's rendition.
    expect(client.calls).toEqual(FULL_SEQUENCE);
    expect((result as { nodeBlocked: boolean }).nodeBlocked).toBe(false);
    expect((result as { warnings: string[] }).warnings).toContain("publish_committed_go_live_unconfirmed");

    // Receipts: every value came out of the sequence's own results or was carried through upstream.
    expect(output.publishCommitted).toBe(true);
    expect(output.receipts.objectId).toBe("obj_platform_9912");
    expect(output.receipts.commitSha).toBe("9f2c1ab4");
    expect(output.receipts.contentRevision).toBe(4);
    expect(output.receipts.requestId).toBe("req_w2a_engine_20260813_01");
    expect(output.receipts.artifactDigests).toEqual(["sha256:abc123"]);
    expect(output.receipts.toolSequence).toEqual(FULL_SEQUENCE);
    expect(output.receipts.steps.every((step) => step.ok)).toBe(true);
    expect(output.approvedAction).toMatchObject({ clientObjectId: "obj_platform_9912", requestId: "req_w2a_engine_20260813_01" });

    // approvalMatched never travels without the source that produced the operator's decision (T2).
    expect(output.approvalMatched).toBe(true);
    expect(output.operatorDecisionSource).toMatch(/^approved \(source: explicit/);
    expect(output.clientValidation?.valid).toBe(true);
  });
});

describe("T4 — a committed publish is still not a go-live", () => {
  it("records status \"blocked\" with a named go_live_unconfirmed blocker, and the evidence enforcer leaves it alone", async () => {
    const { store, run } = await seedEngineRun("approved");
    const output = executedOutput(await runEngine(run, store, stubClient()));

    // publishRun commits the export and never releases (board B2), so "executed" — which requires
    // verification.deployStatus "ready" AND productionConfirmed true — is never claimed.
    expect(output.status).toBe("blocked");
    expect(output.blocker.code).toBe("go_live_unconfirmed");
    expect(output.blocker.step).toBe("release_and_go_live_verification");
    expect(output.verification).toEqual({ deployAware: false, goLiveConfirmed: false, requiredChecks: expect.any(Array) });
    expect(output.verification).not.toHaveProperty("deployStatus");
    expect(output.verification).not.toHaveProperty("productionConfirmed");
    expect(String(output.summary)).toMatch(/^PUBLISH COMMITTED/);

    // Schema-valid against the node's own outputSchema, and nothing here can be mistaken for a
    // confirmed go-live by the deterministic post-check.
    expect(validateOutput(output, getWorkspaceNode("publish_executor")?.outputSchema).ok).toBe(true);
    expect(enforcePublishExecutionEvidence(output, { operatorPublishDecision: "approved" }).downgraded).toBe(false);
  });
});

describe("T4 — a failure stops the sequence dead", () => {
  it("stops at the failing step, names it and the CLIENT's own error, and calls nothing after it", async () => {
    const { store, run } = await seedEngineRun("approved");
    const client = stubClient({ object_patch: "409 lock_conflict: object is checked out by another owner" });

    const result = await runEngine(run, store, client);
    const output = executedOutput(result);

    // The call record, not just the final state: nothing after the failing step was attempted, so the
    // run cannot have half-published.
    expect(client.calls).toEqual(["object_create", "object_checkout", "object_validate", "object_patch"]);
    expect(client.calls).toHaveLength(4);
    expect(client.calls).not.toContain("object_publish");

    expect((result as { nodeBlocked: boolean }).nodeBlocked).toBe(true);
    expect(output.publishCommitted).toBe(false);
    expect(output.blocker).toEqual({
      code: "publish_step_failed",
      step: "object_patch",
      message: expect.stringContaining("stopped at object_patch"),
      clientError: "409 lock_conflict: object is checked out by another owner"
    });
    expect(output.blockers[0]).toContain("publish_step_failed at object_patch");
    expect(output.blockers[0]).toContain("lock_conflict");
    expect(output.receipts.toolSequence).toEqual(["object_create", "object_checkout", "object_validate", "object_patch"]);
    expect(output.receipts.objectId).toBeUndefined();
    expect(validateOutput(output, getWorkspaceNode("publish_executor")?.outputSchema).ok).toBe(true);
    // The run-visible warnings say a partial write happened — never "no publication performed".
    expect((result as { warnings: string[] }).warnings).toEqual(["publish_execution_blocked:publish_step_failed", "publish_partial_client_writes:4"]);
  });

  it("names the phase when the sequence refuses BETWEEN calls (no failing tool to point at)", async () => {
    const { store, run } = await seedEngineRun("approved");
    // Every call succeeds, but the client answers object_create without an id — the dialect hook
    // refuses rather than guessing one, so there is no failed step, only a named phase.
    const client = stubClient();
    const output = executedOutput(await runEnginePublishExecution({
      run,
      clientProjectId: "platform",
      envelopeCarriers: [run.stageOutputs.publication_controller, run.stageOutputs.publish_payload, run.stageOutputs.article_body],
      deps: {
        executionRepository: store,
        callTool: (async (tool: string) => {
          client.calls.push(tool);
          return { ok: true, projectId: "platform", tool, result: tool === "object_create" ? {} : CLIENT_RESULTS[tool] ?? {} };
        }) as unknown as CallToolFn
      }
    }));

    expect(client.calls).toEqual(["object_create"]);
    expect(output.blocker.code).toBe("publish_sequence_error");
    expect(output.blocker.step).toBe("create_missing_object_id");
    expect(output.blocker.clientError).toContain("create_missing_object_id");
    expect(output.publishCommitted).toBe(false);
  });
});

describe("T4 — the gates the engine path may not relax", () => {
  it("makes ZERO client calls when the operator has not approved, even in execute mode", async () => {
    const { store, run } = await seedEngineRun();
    const client = stubClient();

    const result = await runEngine(run, store, client);
    const output = executedOutput(result);

    expect(client.calls).toEqual([]);
    expect(output.status).toBe("blocked");
    expect(output.approvalMatched).toBe(false);
    expect(output).not.toHaveProperty("publishCommitted");
    expect(output.blockers[0]).toMatch(/operator_approval_absent/);
    // A gate refusal COMPLETES the node exactly as the gate-only path always did.
    expect((result as { nodeBlocked: boolean }).nodeBlocked).toBe(false);
  });

  it("honours the per-project publishEnabled kill-switch and calls nothing", async () => {
    process.env.PLATFORM_PUBLISH_ENABLED = "false";
    try {
      const { store, run } = await seedEngineRun("approved");
      const client = stubClient();
      const output = executedOutput(await runEngine(run, store, client));

      expect(client.calls).toEqual([]);
      expect(output.blocker.code).toBe("publish_gate_closed");
      expect(output.blocker.step).toBe("publisher_gates");
      expect(output.blockers.some((blocker) => blocker.startsWith("operator_enabled:"))).toBe(true);
      expect(output.publishCommitted).toBe(false);
    } finally {
      delete process.env.PLATFORM_PUBLISH_ENABLED;
    }
  });
});

describe("T4 — a request id is never minted", () => {
  it("blocks with publish_request_id_absent and calls nothing when no upstream output carries one", async () => {
    const { store, run } = await seedEngineRun("approved");
    const client = stubClient();
    const payload = { ...enginePublishPayload() } as Record<string, unknown>;
    delete payload.requestId;

    const result = await runEnginePublishExecution({
      run,
      clientProjectId: "platform",
      envelopeCarriers: [run.stageOutputs.publication_controller, payload, run.stageOutputs.article_body],
      deps: { executionRepository: store, callTool: client.callTool }
    });
    const output = executedOutput(result);

    expect(client.calls).toEqual([]);
    expect(output.blocker.code).toBe("publish_request_id_absent");
    expect(output.receipts.requestId).toBeUndefined();
    expect((result as { nodeBlocked: boolean }).nodeBlocked).toBe(true);
    expect(validateOutput(output, getWorkspaceNode("publish_executor")?.outputSchema).ok).toBe(true);
  });
});
