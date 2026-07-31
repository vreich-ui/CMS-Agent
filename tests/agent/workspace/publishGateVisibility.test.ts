import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { buildAttentionItems } from "../../../src/agent/observability/constellationMetrics.js";
import { emptyInputs } from "../observability/constellationFixtures.js";

const post = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  if (!response.result) throw new Error(`tool ${name} failed: ${JSON.stringify(response.error)}`);
  return response.result.structuredContent;
};

// Client-shaped envelope: the article_body node's own outputSchema is the authority, and a seeded
// entrypoint output is now validated against it before the run is created.
const articleBody = {
  artifact: "client_object.v1",
  summary: "Publish gate visibility fixture.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", objectType: "content_item" },
  body: { slug: "gate", title: "Gate", nodes: [{ id: "n_a1", kind: "content", visibility: "public", public: { title: "Gate", body: "Publish gate visibility fixture." } }] }
};

// Drive a late-stage run up to (but not into) the publish-risk node. The entrypoint seeds article_body and
// its ancestors; artifact_plan and publish_payload are downstream of it (R-22 topology) and both still run,
// so two advances land the run exactly one step short of publication_controller.
const runToTheEdgeOfTheGate = async (approved = false) => {
  const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", entrypoint: "article_body", articleBody, input: { artifact: "content_source.v1", summary: "gate fixture" } });
  const runId: string = started.data.run.runId;
  let run = started.data.run;
  // Advance until the publish-risk node is the one in line, rather than hard-coding a step count — the
  // point of R-22 is that the node list is no longer a constant anybody should be memorising.
  for (let i = 0; i < 10 && run.currentNodeId !== "publication_controller"; i++) {
    run = (await call("workflow.run_next_node", approved ? { runId, approved: true } : { runId })).data.run;
  }
  return { runId, run };
};

describe("R-18 — a run held before the publish gate is visible", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("records a pending approval as soon as a publish-risk node is next in line", async () => {
    const { run } = await runToTheEdgeOfTheGate();

    expect(run.currentNodeId).toBe("publication_controller");
    // The regression this locks: approvalsRequired used to be [] here, so a run that could never advance
    // on its own was indistinguishable from one still working.
    expect(run.approvalsRequired).toHaveLength(1);
    expect(run.approvalsRequired[0]).toMatchObject({ nodeId: "publication_controller", type: "approval_required", pending: true });

    // Execution semantics are deliberately unchanged: nothing was attempted at the gate.
    const controller = run.nodes.find((node: any) => node.nodeId === "publication_controller");
    expect(controller.status).toBe("queued");
    expect(run.artifacts.some((artifact: any) => artifact.nodeId === "publication_controller")).toBe(false);
  });

  it("survives a re-read, so the hold is durable and not just a response artefact", async () => {
    const { runId } = await runToTheEdgeOfTheGate();
    const reread = await call("workflow.get_run", { runId });
    expect(reread.data.run.approvalsRequired[0]).toMatchObject({ nodeId: "publication_controller", pending: true });
  });

  it("replaces the look-ahead with the attempted record once the gate actually refuses", async () => {
    const { runId } = await runToTheEdgeOfTheGate();
    const blocked = (await call("workflow.run_next_node", { runId })).data.run;

    expect(blocked.status).toBe("blocked");
    // Exactly one entry, and it is the authoritative attempted record — not the look-ahead alongside it.
    expect(blocked.approvalsRequired).toHaveLength(1);
    expect(blocked.approvalsRequired[0].pending).toBeUndefined();
    // The audit record the gate has always produced is still produced.
    expect(blocked.nodes.find((node: any) => node.nodeId === "publication_controller").output).toMatchObject({ decision: "blocked", approvalRequired: true });
  });

  it("mints no look-ahead hold when the advance is explicitly approved", async () => {
    const { run } = await runToTheEdgeOfTheGate(true);
    expect(run.approvalsRequired).toHaveLength(0);
  });

  it("raises an attention item for a pre-gate hold, not only for an attempted one", () => {
    const pendingRun: any = {
      runId: "run_pending", workflowId: "publishing_conductor", projectId: "platform", status: "running",
      startedAt: "2026-07-28T09:00:00.000Z", updatedAt: "2026-07-28T09:00:01.000Z", nodes: [], artifacts: [], errors: [],
      approvalsRequired: [{ nodeId: "publication_controller", type: "approval_required", reason: "publish-risk next", requestedAt: "2026-07-28T09:00:01.000Z", pending: true }],
      stageOutputs: {}, dryRun: true
    };
    const items = buildAttentionItems({ ...emptyInputs(), runs: [pendingRun] });
    const item = items.find((entry) => entry.id === "attn_approval_pending_run_pending");
    expect(item).toBeDefined();
    // The wording must not claim a block that has not happened.
    expect(item!.detail).toContain("cannot advance without explicit approval");
    expect(item!.detail).not.toContain("is blocked before");
  });
});

describe("R-18 — pause is its own status", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("reports paused rather than reusing the overloaded blocked", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", input: { artifact: "content_source.v1", summary: "pause fixture" } });
    const runId: string = started.data.run.runId;
    const paused = (await call("workflow.pause_run", { runId })).data.run;

    expect(paused.status).toBe("paused");
    // The three meanings are now separable: an operator pause carries neither marker AND says so.
    expect(paused.approvalsRequired).toHaveLength(0);
    expect(paused.budgetBlock).toBeUndefined();
  });

  it("does not advance a paused run", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", input: { artifact: "content_source.v1", summary: "pause fixture" } });
    const runId: string = started.data.run.runId;
    await call("workflow.pause_run", { runId });

    const afterAdvance = (await call("workflow.run_next_node", { runId })).data.run;
    expect(afterAdvance.status).toBe("paused");
    expect(afterAdvance.nodes.every((node: any) => node.status === "queued")).toBe(true);

    // run_all must respect the pause too — it used to spin on an inline status list that would not have
    // known about a newly added halt state.
    const afterRunAll = (await call("workflow.run_all", { runId })).data.run;
    expect(afterRunAll.status).toBe("paused");
    expect(afterRunAll.nodes.every((node: any) => node.status === "queued")).toBe(true);
  });

  it("resumes to queued and then advances", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", input: { artifact: "content_source.v1", summary: "pause fixture" } });
    const runId: string = started.data.run.runId;
    await call("workflow.pause_run", { runId });
    expect((await call("workflow.resume_run", { runId })).data.run.status).toBe("queued");
    const advanced = (await call("workflow.run_next_node", { runId })).data.run;
    expect(advanced.nodes.find((node: any) => node.nodeId === "input_triage").status).toBe("completed");
  });
});
