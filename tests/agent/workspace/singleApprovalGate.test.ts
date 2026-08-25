import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { __test__, getRun, runNextNode, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";

// T5 (autonomous-publish) — ONE APPROVAL, NOT TWO.
//
// Publishing was gated twice, by two mechanisms that did not know about each other:
//   - the DURABLE gate, run.operatorPublishDecision — recorded by a real operator via
//     workflow.set_operator_publish_decision, or standing from the project's
//     publishingPolicy.operatorDefault, and the thing publish evidence is matched against;
//   - the DRIVER gate, a per-call `approved: true` flag on run_all / retry_node, which no scheduled
//     driver has any way to supply — the continuation tick and the Cloud Run conductor job simply
//     advance runs.
//
// So an already-approved run sat at the publish gate indefinitely: the only drivers that could have
// advanced it were structurally incapable of re-asserting an approval that had already been given,
// and a human had to re-approve what they had already approved. That is the approval click this
// workstream exists to delete.

// Park a mock run exactly at the publish-risk gate — every other node completed, so the gate is the
// only thing left and the run's fate is entirely about it. The gate node is found by riskLevel (the
// isPublishRisk rule), never by a memorised id.
const parkAtTheGate = async (): Promise<{ runId: string; gateId: string; store: ExecutionRepository }> => {
  const store = new RepositoryManager().getExecutionRepository();
  const nodes = await __test__.resolveConductorNodes();
  const gateId = nodes.find(__test__.isPublishRisk)!.id;
  const started = await startDryRun({ executionMode: "mock", projectId: "platform", input: "T5 single-gate fixture" }, store);
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

describe("T5 acceptance — a durable approval satisfies the driver gate", () => {
  it("a plain advance carries a run with a recorded approval through the publish-risk node", async () => {
    const { runId, gateId, store } = await parkAtTheGate();
    await setOperatorPublishDecision(runId, "approved", store);

    // No `approved` option: exactly what the continuation tick and the Cloud Run conductor job send.
    const advanced = await runNextNode(runId, { executionRepository: store });

    expect(advanced.nodes.find((node) => node.nodeId === gateId)!.status).toBe("completed");
    expect(advanced.status).not.toBe("blocked");
    expect(advanced.approvalsRequired).toEqual([]);
  });

  it("re-enters a run already parked at the gate once the approval is recorded", async () => {
    const { runId, gateId, store } = await parkAtTheGate();

    const blocked = await runNextNode(runId, { executionRepository: store });
    expect(blocked.status).toBe("blocked");
    expect(blocked.nodes.find((node) => node.nodeId === gateId)!.status).toBe("blocked");

    await setOperatorPublishDecision(runId, "approved", store);
    const cleared = await runNextNode(runId, { executionRepository: store });

    // The whole remedy for THIS blocker is approval, and the approval exists — so a plain tick
    // clears it rather than parking the run for a human to say yes a second time.
    expect(cleared.nodes.find((node) => node.nodeId === gateId)!.status).toBe("completed");
    expect(cleared.status).not.toBe("blocked");
  });

  it("does not raise a pending-approval flag for a run that is already approved", async () => {
    const { runId, store } = await parkAtTheGate();
    await setOperatorPublishDecision(runId, "approved", store);

    const advanced = await runNextNode(runId, { executionRepository: store });

    // The look-ahead exists to make an invisible hold visible. A run nobody is holding must not
    // advertise one — an operator chasing a phantom approval is the same wasted click by another name.
    expect(advanced.approvalsRequired.filter((approval) => approval.pending === true)).toEqual([]);
  });

  it("a standing project default counts exactly as an explicit approval does", async () => {
    const projectRepository = repositoryManager.getProjectRepository();
    const config = await projectRepository.get("platform");
    await projectRepository.save({ ...config!, publishingPolicy: { ...config!.publishingPolicy, operatorDefault: "approved" } });
    try {
      const { runId, gateId, store } = await parkAtTheGate();
      const run = (await getRun(runId, store))!;
      // applyOperatorPublishPolicyDefault stamps this at creation; assert it rather than assume it,
      // since the whole test rests on the run genuinely carrying a policy-sourced decision.
      expect(run.operatorPublishDecision).toBe("approved");
      expect(run.operatorDecisionSource).toBe("project_policy_default");

      const advanced = await runNextNode(runId, { executionRepository: store });
      expect(advanced.nodes.find((node) => node.nodeId === gateId)!.status).toBe("completed");
    } finally {
      await projectRepository.save({ ...config! });
    }
  });
});

describe("T5 — what the collapse must NOT weaken", () => {
  it("withheld blocks every driver, with or without the per-call flag", async () => {
    for (const options of [{}, { approved: true }]) {
      const { runId, gateId, store } = await parkAtTheGate();
      await setOperatorPublishDecision(runId, "withheld", store);

      const advanced = await runNextNode(runId, { executionRepository: store, ...options });
      const gate = advanced.nodes.find((node) => node.nodeId === gateId)!;

      // The veto is not a value any advance can outvote — that is what makes it a veto.
      expect(gate.status).toBe("blocked");
      expect(gate.warnings).toContain("operator_publish_withheld");
      expect(advanced.status).toBe("blocked");
    }
  });

  it("no decision and no project default still blocks — absence never authorizes", async () => {
    const { runId, gateId, store } = await parkAtTheGate();
    const run = (await getRun(runId, store))!;
    expect(run.operatorPublishDecision).toBeUndefined();

    const advanced = await runNextNode(runId, { executionRepository: store });

    expect(advanced.nodes.find((node) => node.nodeId === gateId)!.status).toBe("blocked");
    expect(advanced.status).toBe("blocked");
    expect(advanced.approvalsRequired.map((approval) => approval.nodeId)).toContain(gateId);
  });
});
