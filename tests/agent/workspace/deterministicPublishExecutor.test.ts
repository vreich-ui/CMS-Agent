import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBlockedPublishExecution,
  evaluatePublishExecutionGate,
  readPublishExecutionEnvelope,
  runDeterministicPublishExecutor
} from "../../../src/agent/workspace/publishExecution.js";
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
  const startAtExecutor = async (operatorPublishDecision?: "approved") => {
    const store = new RepositoryManager().getExecutionRepository();
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.updateNode("publish_executor", { metadata: { publishExecutorDeterministic: true } }, { actor: "w2a-test" });

    const started = await startDryRun({
      executionMode: "openai",
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
    // Still no client call: the fall-through is to the MODEL path, which has no provider in this env.
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});
