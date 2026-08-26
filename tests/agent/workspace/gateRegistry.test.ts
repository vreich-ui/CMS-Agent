import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { listRegisteredWorkflowIds, getWorkflowDefinition } from "../../../src/agent/workspace/workflowRegistry.js";
import { listKnownGateIds, listPublishGates, publishGateConformanceIssues, resolveGateId, resolvePublishGate } from "../../../src/agent/workspace/gateRegistry.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { evaluateNodeSkip } from "../../../src/agent/workspace/skipPredicates.js";
import { buildObjectPublishPlan } from "../../../src/agent/workspace/objectPublishExecution.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import "../../../src/agent/workspace/captureConductorWorkflow.js";
import "../../../src/agent/workspace/cloneConductorWorkflow.js";

// T5 (2026-08-26) — gate competence: no gate on an empty branch, and every gate addressable by a
// stable id.
//
// Both halves come from ONE live run. Run 01 blocked at pdf_template_publish demanding an operator
// decision with siteId:null and zero entries — a branch with nothing in it consumed a gate — and the
// only thing the operator was handed to act on was a nodeId and a sentence of prose. nodeId is not an
// address: three workflows share the tail's node ids, so it cannot distinguish clone's publish gate
// from the article path's.

const TARGET = "zilberman-gate-registry";

describe("every publish-risk gate a run can raise has a stable, declared id", () => {
  it("conforms across EVERY registered workflow — this is the test that fails when a publish-risk node is added without a gate", () => {
    const ids = listRegisteredWorkflowIds();
    expect(ids.length).toBeGreaterThan(1);
    for (const workflowId of ids) {
      const nodes = getWorkflowDefinition(workflowId)!.canonicalNodes();
      expect(publishGateConformanceIssues(nodes, workflowId), workflowId).toEqual([]);
    }
  });

  it("actually fires when a publish-risk node has no declared gate — an inert conformance check is worse than none", () => {
    const undeclared = { id: "some_future_publisher", riskLevel: "publish" } as unknown as WorkspaceNode;
    const issues = publishGateConformanceIssues([undeclared], "clone_conductor");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("some_future_publisher");
    expect(issues[0]).toContain("gateRegistry.ts declares no gate id");
    // ...and a non-publish node is not a gate, so it raises nothing.
    expect(publishGateConformanceIssues([{ id: "layout_analyst", riskLevel: "read" } as unknown as WorkspaceNode], "clone_conductor")).toEqual([]);
  });

  it("gives the SAME node id a DIFFERENT gate id per workflow — which is the entire reason gate ids exist", () => {
    expect(resolveGateId("clone_conductor", "publish_executor")).toBe("gate.clone.publish_executor");
    expect(resolveGateId("capture_conductor", "publish_executor")).toBe("gate.capture.publish_executor");
    expect(resolveGateId("publishing_conductor", "publish_executor")).toBe("gate.publishing.publish_executor");
    expect(resolveGateId("clone_conductor", "pdf_template_publish")).toBe("gate.clone.pdf_template_publish");
  });

  it("declares no duplicates, and refuses to synthesize an id for an undeclared pair", () => {
    const ids = listKnownGateIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(listPublishGates().every((definition) => definition.description.trim().length > 0)).toBe(true);
    expect(resolveGateId("clone_conductor", "layout_analyst")).toBeUndefined();
    expect(resolveGateId(undefined, "publish_executor")).toBeUndefined();
    expect(resolveGateId("not_a_workflow", "publish_executor")).toBeUndefined();
    expect(resolvePublishGate("clone_conductor", "publish_executor")?.nodeId).toBe("publish_executor");
  });
});

describe("an empty pdf-template branch consumes no gate", () => {
  const emptyIntake = { artifact: "pdf_template_intake.v1", summary: "no brief on this run", entries: [] };
  const briefedIntake = { artifact: "pdf_template_intake.v1", summary: "one entry", entries: [{ requestedId: "req_invoice", name: "Invoice", renderer: "pdfme" }] };

  const branchNodes = () => {
    const nodes = listCloneConductorNodes();
    return {
      designer: nodes.find((node) => node.id === "pdf_template_designer")!,
      mint: nodes.find((node) => node.id === "pdf_template_mint")!,
      publish: nodes.find((node) => node.id === "pdf_template_publish")!
    };
  };

  it("skips ALL THREE branch nodes when pdf_template_intake names zero entries — not just the designer", () => {
    const { designer, mint, publish } = branchNodes();
    for (const node of [designer, mint, publish]) {
      const verdict = evaluateNodeSkip(node, { initialInput: {}, stageOutputs: { pdf_template_intake: emptyIntake } });
      expect(verdict?.skip, node.id).toBe(true);
      expect(verdict?.predicate?.when, node.id).toBe("clone_no_pdf_template_entries");
      expect(verdict?.reason, node.id).toContain("empty branch must never consume a gate");
    }
  });

  it("pdf_template_publish sees the intake envelope even though it depends only on pdf_template_mint", () => {
    const { publish } = branchNodes();
    // The one-hop dependsOn this node states on purpose — the skip must work WITHOUT widening it.
    expect(publish.dependsOn).toEqual(["pdf_template_mint"]);
    expect(evaluateNodeSkip(publish, { initialInput: {}, stageOutputs: { pdf_template_intake: emptyIntake } })?.skip).toBe(true);
  });

  it("runs all three when the branch has work — the skip is a gate, not a disablement", () => {
    const { designer, mint, publish } = branchNodes();
    for (const node of [designer, mint, publish]) {
      expect(evaluateNodeSkip(node, { initialInput: {}, stageOutputs: { pdf_template_intake: briefedIntake } })?.skip, node.id).toBe(false);
    }
  });

  it("runs all three when no intake envelope exists at all — rule 3: an unanswered question is answered by running", () => {
    const { designer, mint, publish } = branchNodes();
    for (const node of [designer, mint, publish]) {
      expect(evaluateNodeSkip(node, { initialInput: {}, stageOutputs: {} })?.skip, node.id).toBe(false);
    }
  });
});

type RpcRequest = { id: number; method: string; params?: { name?: string } };

describe("a gate a run actually raises carries its gate id", () => {
  beforeEach(() => {
    resetRepositoryManager();
    process.env.ZILBERMAN_GATE_REGISTRY_MCP_ENDPOINT = "https://zilberman-gate-registry.example/mcp";
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: {} } }) } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.ZILBERMAN_GATE_REGISTRY_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  // Operator-gated (no autonomyMode): the tail's own publish-risk guard refuses the first publish-risk
  // node, which is exactly the state whose approval entry an operator has to act on.
  it("blocks a clone run at a named gate, and names it on BOTH the run's approval entry and the node's own output", async () => {
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "Gate registry fixture",
        mcpEndpointEnvVar: "ZILBERMAN_GATE_REGISTRY_MCP_ENDPOINT",
        authMode: "none",
        defaultToolPolicy: "allowed"
      })
    );

    const plan = buildObjectPublishPlan({
      report: { target: TARGET, createdObjects: [{ objectType: "section_template", objectId: "tmpl_hero" }], reusedObjects: [], quarantines: [], validationStates: [{ phase: "postcreate", objectId: "tmpl_hero", valid: true, reason: null }] },
      target: TARGET,
      publishableTypes: resolvePublishableTypeCharter("clone_conductor").publishableTypes,
      workflowId: "clone_conductor"
    });
    const store = repositoryManager.getExecutionRepository();
    const started = await startDryRun(
      {
        projectId: TARGET,
        workflowId: "clone_conductor",
        executionMode: "openai",
        input: { targetProjectId: TARGET, captureRunId: "run_capture_fixture" },
        entrypoint: {
          nodeId: "publish_payload",
          output: {
            artifact: "dry_run_publish_payload.v1",
            summary: "fixture plan.",
            clientProjectId: TARGET,
            clientObjectType: "clone_structure_batch",
            contractSource: { source: "clone_conductor", targetProjectId: TARGET },
            dryRun: true,
            clientObject: { objectPublishPlan: plan },
            blockers: []
          }
        }
      },
      store
    );

    let run = (await getRun(started.runId, store))!;
    for (let i = 0; i < 20 && run.currentNodeId && !HALTED_EXECUTION_STATUSES.has(run.status); i++) {
      run = await runNextNode(started.runId, { executionRepository: store });
    }

    expect(run.status).toBe("blocked");
    expect(run.approvalsRequired.length).toBeGreaterThan(0);

    // Every approval entry this run raised is addressable, and its id is the registry's — not a string
    // assembled at the call site that could drift from what an operator was told.
    const known = new Set(listKnownGateIds());
    for (const approval of run.approvalsRequired) {
      expect(approval.gateId, approval.nodeId).toBeDefined();
      expect(known.has(approval.gateId!), approval.gateId).toBe(true);
      expect(approval.gateId).toBe(resolveGateId("clone_conductor", approval.nodeId));
      // Clone's gate, specifically — never the article path's, though they share the node id.
      expect(approval.gateId!.startsWith("gate.clone.")).toBe(true);
    }

    // ...and the node that actually stopped says so itself.
    const blocked = run.nodes.find((node) => node.status === "blocked")!;
    expect((blocked.output as Record<string, unknown>).gateId).toBe(resolveGateId("clone_conductor", blocked.nodeId));
  });
});
