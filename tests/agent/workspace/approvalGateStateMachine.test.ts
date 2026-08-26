import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import {
  __test__,
  getRun,
  isApprovalGateOnlyBlock,
  isApprovalGateStub,
  runNextNode,
  setOperatorPublishDecision,
  startDryRun,
  updateRunStatus
} from "../../../src/agent/workspace/executor.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T5 state-machine fixes, both anchored on run_1786557897658_elj34j's shape:
//   1. an `approved: true` advance must re-dispatch a node whose ONLY block is the approval gate
//      (it used to need resume_run + retry_node by hand);
//   2. a run must never report "completed" while a node still holds the gate's refusal stub.

// Park a mock run exactly at the publish-risk gate: every other node completed, so the gate is the
// only thing left and the run's fate is entirely about it. The gate node is found by riskLevel (the
// isPublishRisk rule), never by a memorised id.
const parkAtTheGate = async (): Promise<{ runId: string; gateId: string; store: ExecutionRepository }> => {
  const store = new RepositoryManager().getExecutionRepository();
  const nodes = await __test__.resolveConductorNodes();
  const gateId = nodes.find(__test__.isPublishRisk)!.id;
  const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "T5 gate fixture" }, store);
  const record = (await getRun(started.runId, store))!;
  for (const node of record.nodes) {
    if (node.nodeId === gateId) continue;
    node.status = "completed";
    node.startedAt = record.startedAt;
    node.completedAt = record.startedAt;
  }
  record.status = "queued";
  await store.saveRun(record);
  return { runId: started.runId, gateId, store };
};

const blockAtTheGate = async () => {
  const parked = await parkAtTheGate();
  const blocked = await runNextNode(parked.runId, { executionRepository: parked.store });
  expect(blocked.status).toBe("blocked");
  expect(blocked.nodes.find((node) => node.nodeId === parked.gateId)!.status).toBe("blocked");
  return parked;
};

describe("T5 fix 1 — an approved advance re-enters a run held only by the approval gate", () => {
  it("re-dispatches the gate-blocked node instead of returning the blocked run untouched", async () => {
    const { runId, gateId, store } = await blockAtTheGate();

    // T15.7 (ADR-2026-08-25-publish-autonomy §7) — `approved` is deprecated as an authority input:
    // the run's own operator record (resolvePublishAuthority) is what T5 fix 1's re-entry now checks,
    // so the durable decision is what has to land, not a caller flag.
    await setOperatorPublishDecision(runId, "approved", store);
    const cleared = await runNextNode(runId, { executionRepository: store });

    const gate = cleared.nodes.find((node) => node.nodeId === gateId)!;
    expect(gate.status).toBe("completed");
    expect(cleared.status).not.toBe("blocked");
    // The refusal receipt and its approval entry are gone: the node actually ran this time.
    expect(isApprovalGateStub(gate.output)).toBe(false);
    expect(cleared.approvalsRequired.filter((approval) => approval.nodeId === gateId && approval.pending !== true)).toEqual([]);
    // And the run finishes on the next advance, in the same driver loop — no manual resume + retry.
    expect((await runNextNode(runId, { executionRepository: store })).status).toBe("completed");
  });

  it("still refuses when the operator's publish decision is withheld — approval is not authority over a veto", async () => {
    const { runId, gateId, store } = await parkAtTheGate();
    await setOperatorPublishDecision(runId, "withheld", store);
    const blocked = await runNextNode(runId, { executionRepository: store });
    expect(blocked.status).toBe("blocked");
    expect(isApprovalGateOnlyBlock(blocked)).toBe(false);

    const stillBlocked = await runNextNode(runId, { executionRepository: store, approved: true });
    expect(stillBlocked.status).toBe("blocked");
    const gate = stillBlocked.nodes.find((node) => node.nodeId === gateId)!;
    expect(gate.status).toBe("blocked");
    expect(gate.warnings).toContain("operator_publish_withheld");
    expect(gate.warnings).toContain("no_publication_performed");
  });
});

// The stub is told from a real decision by its FIELDS. These three cases are the whole rule.
describe("T5 — the approval-gate stub is identified by its fields, not by a node id", () => {
  it("recognises the gate's own refusal receipt", () => {
    expect(isApprovalGateStub({ artifact: "publication_decision.v1", dryRun: true, decision: "blocked", approvalRequired: true, reason: "Dry-run stopped before publish-risk node." })).toBe(true);
  });

  it("rejects a real deterministic publication decision — it carries state and blockers", () => {
    const real = { artifact: "publication_decision.v1", summary: "Deterministic decision", decision: "blocked", state: "blocked_for_publish_execution", blockers: ["publish_readiness: media_unverified"], waivedBlockers: [], contentClass: "client_property", checklist: [], nextAction: "Resolve before any publish.", notes: [] };
    expect(isApprovalGateStub(real)).toBe(false);
  });

  it("rejects a refusal that was not the approval gate (approvalRequired false)", () => {
    expect(isApprovalGateStub({ artifact: "publication_decision.v1", dryRun: true, decision: "blocked", approvalRequired: false, reason: "operator_publish_withheld: ..." })).toBe(false);
  });
});

describe("T5 fix 1 — a run held for anything else is left exactly where it is", () => {
  const stubbed = (extra: Partial<WorkflowExecutionRecord>): WorkflowExecutionRecord => ({
    runId: "r", workflowId: "publishing_conductor", projectId: "platform", status: "blocked",
    startedAt: "2026-08-13T11:00:00.000Z", updatedAt: "2026-08-13T11:05:00.000Z",
    nodes: [
      { nodeId: "a", status: "completed" },
      { nodeId: "publication_controller", status: "blocked", warnings: ["approval_required", "no_publication_performed"], output: { decision: "blocked", approvalRequired: true, reason: "approval" } }
    ],
    artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true,
    ...extra
  } as WorkflowExecutionRecord);

  it("clears for the approval gate alone", () => {
    expect(isApprovalGateOnlyBlock(stubbed({}))).toBe(true);
  });

  it("refuses a budget hold — the remedy there is a raised ceiling, not approval", () => {
    expect(isApprovalGateOnlyBlock(stubbed({ budgetBlock: { blockedAt: "2026-08-13T11:05:00.000Z", budgetUsd: 3, spentUsdEstimate: 3.4, reason: "ceiling reached" } }))).toBe(false);
  });

  it("refuses a run carrying a failed node", () => {
    const record = stubbed({});
    record.nodes.push({ nodeId: "b", status: "failed", errors: ["boom"] });
    expect(isApprovalGateOnlyBlock(record)).toBe(false);
  });

  it("refuses when the node's refusal was a non-affirmative controller decision as well", () => {
    const record = stubbed({});
    record.nodes[1].warnings = ["approval_required", "publication_decision_not_affirmative", "no_publication_performed"];
    expect(isApprovalGateOnlyBlock(record)).toBe(false);
  });
});

describe("T5 fix 2 — a run never reports completed while the gate's stub is a node's output", () => {
  it("re-blocks instead of completing when a resumed run finds nothing runnable but the stub is still there", async () => {
    const { runId, gateId, store } = await blockAtTheGate();
    // Exactly what workflow.resume_run does: the RUN goes back to queued, the blocked NODE does not.
    await updateRunStatus(runId, "queued", store);

    const advanced = await runNextNode(runId, { executionRepository: store });

    // The regression this locks: this used to be "completed" — a run that never published, reporting
    // the one status downstream readers trust without re-reading the nodes.
    expect(advanced.status).toBe("blocked");
    expect(advanced.completedAt).toBeUndefined();
    expect(advanced.currentNodeId).toBe(gateId);
    expect(advanced.nodes.find((node) => node.nodeId === gateId)!.status).toBe("blocked");
    // The hold is visible again, as an attempted (non-look-ahead) approval entry.
    expect(advanced.approvalsRequired.some((approval) => approval.nodeId === gateId && approval.pending !== true)).toBe(true);
    // Durable, not a response artefact.
    expect((await getRun(runId, store))!.status).toBe("blocked");
  });

  it("still completes a run whose decision node holds a REAL deterministic decision", async () => {
    const { runId, gateId, store } = await parkAtTheGate();
    const record = (await getRun(runId, store))!;
    const gate = record.nodes.find((node) => node.nodeId === gateId)!;
    gate.status = "completed";
    gate.startedAt = record.startedAt;
    gate.completedAt = record.startedAt;
    // publication_decision.v1 as publicationController emits it: decision "blocked" AND state AND
    // blockers. A deterministic no-go is a finished decision, not an unanswered approval request.
    gate.output = { artifact: "publication_decision.v1", summary: "Deterministic decision", decision: "blocked", state: "blocked_for_publish_execution", blockers: ["publish_readiness: media_unverified"], waivedBlockers: [], contentClass: "client_property", checklist: [], nextAction: "Resolve before any publish.", notes: [] };
    record.stageOutputs[gateId] = gate.output;
    record.status = "queued";
    await store.saveRun(record);

    const advanced = await runNextNode(runId, { executionRepository: store });
    expect(advanced.status).toBe("completed");
  });
});

// The operator-facing shape of fix 1: ONE workflow_run_all call carries the run through the gate.
describe("T5 fix 1 over MCP — workflow.run_all with approved:true", () => {
  const post = async (body: unknown) => JSON.parse((await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) })).body ?? "{}");
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    if (!response.result) throw new Error(`tool ${name} failed: ${JSON.stringify(response.error)}`);
    return response.result.structuredContent;
  };

  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("re-enters a run blocked at the gate instead of returning it untouched, in one call", async () => {
    const store = repositoryManager.getExecutionRepository();
    const nodes = await __test__.resolveConductorNodes();
    const gateId = nodes.find(__test__.isPublishRisk)!.id;
    const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "T5 run_all fixture" }, store);
    const record = (await getRun(started.runId, store))!;
    for (const node of record.nodes) {
      if (node.nodeId === gateId) continue;
      node.status = "completed";
      node.startedAt = record.startedAt;
      node.completedAt = record.startedAt;
    }
    record.status = "queued";
    await store.saveRun(record);

    const blocked = (await call("workflow.run_all", { runId: started.runId })).data.run;
    expect(blocked.status).toBe("blocked");

    // T15.7 (ADR-2026-08-25-publish-autonomy §7) — `approved` is deprecated as an authority input;
    // the durable operator decision is what T5 fix 1's re-entry (and the gate itself) now checks.
    await call("workflow.set_operator_publish_decision", { runId: started.runId, decision: "approved" });

    // Before T5 this returned the blocked run verbatim — the loop stopped on the halted status before
    // taking a single step, and clearing the gate took resume_run + retry_node by hand.
    const approved = (await call("workflow.run_all", { runId: started.runId })).data.run;
    expect(approved.nodes.find((node: { nodeId: string }) => node.nodeId === gateId).status).toBe("completed");
    expect(approved.status).toBe("completed");
  });
});
