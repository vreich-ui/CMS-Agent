import { describe, expect, it } from "vitest";
import {
  ADOPT_TOOL,
  ARTIFACT_MATERIALIZER_JOB_STAGE_KEY,
  CREATE_TOOL,
  STATUS_TOOL,
  materializationIdempotencyKey,
  runArtifactMaterialization,
  type MaterializerDeps,
  type MaterializerJobState
} from "../../../src/agent/workspace/artifactMaterialization.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { evaluateNodeSkip } from "../../../src/agent/workspace/skipPredicates.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { materializedPlanOf } from "../../../src/agent/workspace/materializedPlan.js";
import { artifactPlanVerifiedMediaRefsOf } from "../../../src/agent/projects/readinessContentChecks.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// W8.3 acceptance. The whole point of this node is that the loop it runs costs NO model turns, so
// every assertion here is about the loop's arithmetic against a mocked bridge:
//   (a) 3 images + 1 PDF materialize across N dispatches with EXACTLY 4 create calls;
//   (b) a re-run after completion creates nothing at all;
//   (c) a PDF whose job fails terminally is a blocked SLOT carrying the renderer error verbatim,
//       not a dead node and not a paraphrase;
//   (d) the envelope validates against the existing artifact_plan.v1 outputSchema, unchanged;
//   (e) the model is never consulted — asserted structurally, by the module taking no runner at all.

const SITE_ID = "site_drlurie";
const REQUEST_ID = "req_conductor_barrier_20260831_01";

const projectConfig = { projectId: "dr-lurie", status: "active", objectDialect: { siteObjectId: SITE_ID } } as unknown as ProjectConnectionConfig;
const projectRepository = { get: async () => projectConfig } as unknown as ProjectRepository;

const node = getWorkspaceNode("artifact_materializer")!;

const spec = (slots: Record<string, unknown>[]) => ({
  artifact: "materialization_spec.v1",
  summary: "Four slots planned in one turn.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  artifactProtocol: "agent_artifact_jobs",
  requestId: REQUEST_ID,
  slots
});

const FOUR_SLOTS = [
  { slotId: "hero", purpose: "hero image", desiredKind: "image", placement: "top", prompt: "a jar of moisturizer on a marble countertop" },
  { slotId: "inline_1", purpose: "inline diagram", desiredKind: "image", prompt: "a three-step barrier repair sequence" },
  { slotId: "inline_2", purpose: "second inline image", desiredKind: "image", prompt: "a close-up of dry skin texture" },
  { slotId: "worksheet", purpose: "downloadable worksheet", desiredKind: "pdf", templateId: "tpl_worksheet_v1", renderData: { title: "Barrier repair", rows: [] } }
];

const runFixture = (slots: Record<string, unknown>[] = FOUR_SLOTS, jobState?: MaterializerJobState): WorkflowExecutionRecord =>
  ({
    runId: "run_materializer_1",
    projectId: "dr-lurie",
    executionMode: "openai",
    stageOutputs: {
      artifact_plan: spec(slots),
      ...(jobState ? { [ARTIFACT_MATERIALIZER_JOB_STAGE_KEY]: jobState } : {})
    }
  }) as unknown as WorkflowExecutionRecord;

type Call = { tool: string; args: Record<string, unknown> };

/** A bridge whose jobs need `pollsToFinish` polls before they report complete. */
const bridge = (options: { pollsToFinish?: number; failSlots?: Record<string, string>; adopted?: Record<string, boolean> } = {}) => {
  const calls: Call[] = [];
  const polls: Record<string, number> = {};
  const pollsToFinish = options.pollsToFinish ?? 1;
  const callTool = async (_config: ProjectConnectionConfig, tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const slot = String(args.slot ?? "");
    if (tool === ADOPT_TOOL) {
      return options.adopted?.[slot]
        ? { ok: true, result: { structuredContent: { data: { artifactReference: { blobKey: `image/${REQUEST_ID}/${slot}-adopted.webp`, sha256: "a".repeat(64), contentType: "image/webp", size: 1234 }, public_path: `/img/${REQUEST_ID}/${slot}-adopted.webp` } } } }
        : { ok: true, result: { structuredContent: { data: { error_code: "artifact_not_found", isError: false } } } };
    }
    if (tool === CREATE_TOOL) {
      return { ok: true, result: { structuredContent: { data: { job: { jobId: `job_${slot}`, status: "pending" } } } } };
    }
    if (tool === STATUS_TOOL) {
      const jobId = String(args.job_id);
      polls[jobId] = (polls[jobId] ?? 0) + 1;
      const slotOfJob = jobId.replace(/^job_/, "");
      const failure = options.failSlots?.[slotOfJob];
      if (polls[jobId] < pollsToFinish) return { ok: true, result: { structuredContent: { data: { job: { jobId, status: "running" } } } } };
      if (failure) return { ok: true, result: { structuredContent: { data: { job: { jobId, status: "failed", errorDetail: failure } } } } };
      const ext = slotOfJob === "worksheet" ? "pdf" : "webp";
      const dir = slotOfJob === "worksheet" ? "pdf" : "img";
      return { ok: true, result: { structuredContent: { data: { job: { jobId, status: "complete", artifactReference: { blobKey: `${dir}/${REQUEST_ID}/${slotOfJob}.${ext}`, sha256: "b".repeat(64), contentType: slotOfJob === "worksheet" ? "application/pdf" : "image/webp", size: 4096 }, public_path: `/${dir}/${REQUEST_ID}/${slotOfJob}.${ext}` } } } } };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  // Cast at the seam: the fixture returns only the fields this module reads, and annotating every
  // literal with the adapter's full CallToolResult would bury the payloads these tests are about.
  return { calls, callTool: callTool as unknown as NonNullable<MaterializerDeps["callTool"]> };
};

/** Drives the node the way the executor does: re-queue on pending, persist job state, dispatch again. */
const driveToTerminal = async (params: { slots?: Record<string, unknown>[]; deps: { calls: Call[]; callTool: ReturnType<typeof bridge>["callTool"] }; maxDispatches?: number }) => {
  let jobState: MaterializerJobState | undefined;
  let dispatches = 0;
  for (let i = 0; i < (params.maxDispatches ?? 12); i += 1) {
    dispatches += 1;
    const outcome = await runArtifactMaterialization(
      { run: runFixture(params.slots ?? FOUR_SLOTS, jobState), node },
      { projectRepository, callTool: params.deps.callTool }
    );
    if (outcome.kind === "pending") {
      jobState = outcome.jobState;
      continue;
    }
    return { outcome, dispatches, jobState };
  }
  throw new Error("never reached a terminal outcome");
};

const createCalls = (calls: Call[]) => calls.filter((call) => call.tool === CREATE_TOOL);

describe("artifact_materializer — the deterministic materialization loop (W8.3)", () => {
  it("(a) materializes 3 images + 1 PDF across several dispatches with exactly four create calls", async () => {
    const deps = bridge({ pollsToFinish: 3 });
    const { outcome, dispatches } = await driveToTerminal({ deps });

    expect(outcome.kind).toBe("completed");
    expect(createCalls(deps.calls)).toHaveLength(4);
    // It really did span dispatches rather than spinning inside one call window.
    expect(dispatches).toBeGreaterThan(1);
    // One adopt per slot, once — a slot with a job id is never re-adopted.
    expect(deps.calls.filter((call) => call.tool === ADOPT_TOOL)).toHaveLength(4);

    const output = outcome.kind === "completed" ? outcome.output : {};
    expect(output.artifact).toBe("artifact_plan.v1");
    const slots = output.media_slots as Record<string, unknown>[];
    expect(slots.map((slot) => slot.status)).toEqual(["has_trusted_artifact", "has_trusted_artifact", "has_trusted_artifact", "has_trusted_artifact"]);
    // Both forms of every artifact, in the fields the publisher's evidence reader looks in.
    expect(slots.find((slot) => slot.slotId === "worksheet")?.publicPath).toBe(`/pdf/${REQUEST_ID}/worksheet.pdf`);
    expect(output.blockers).toEqual([]);
  });

  it("(a2) sends a stable idempotency key and asks for the 202-shaped response, never the inline wait", async () => {
    const deps = bridge({ pollsToFinish: 1 });
    await driveToTerminal({ deps });
    for (const call of createCalls(deps.calls)) {
      expect(call.args.site_id).toBe(SITE_ID);
      expect(call.args.request_id).toBe(REQUEST_ID);
      expect(call.args.wait).toBe(false);
      expect(call.args.idempotency_key).toBe(materializationIdempotencyKey("run_materializer_1", REQUEST_ID, String(call.args.slot)));
    }
    // The PDF slot renders a published template; it never carries a prompt, and never authors one.
    const pdfCreate = createCalls(deps.calls).find((call) => call.args.slot === "worksheet")!;
    expect(pdfCreate.args.template_id).toBe("tpl_worksheet_v1");
    expect(pdfCreate.args.data).toEqual({ title: "Barrier repair", rows: [] });
    expect(pdfCreate.args.prompt).toBeUndefined();
    // An image prompt is the SUBJECT only: no seed, no loras, no style fields we know are overridden.
    const imageCreate = createCalls(deps.calls).find((call) => call.args.slot === "hero")!;
    expect(imageCreate.args.prompt).toBe("a jar of moisturizer on a marble countertop");
    expect(imageCreate.args.seed).toBeUndefined();
    expect(imageCreate.args.loras).toBeUndefined();
  });

  it("(b) a re-run after completion adopts everything and creates nothing", async () => {
    const first = bridge({ pollsToFinish: 2 });
    const { jobState } = await driveToTerminal({ deps: first });
    expect(createCalls(first.calls)).toHaveLength(4);

    // Second pass, fresh bridge, every slot already materialized on the client.
    const second = bridge({ adopted: { hero: true, inline_1: true, inline_2: true, worksheet: true } });
    const rerun = await runArtifactMaterialization(
      // A retry clears stageOutputs for the node, so the honest re-run starts with NO job state.
      { run: runFixture(FOUR_SLOTS, undefined), node },
      { projectRepository, callTool: second.callTool }
    );
    expect(rerun.kind).toBe("completed");
    expect(createCalls(second.calls)).toHaveLength(0);
    expect(second.calls.every((call) => call.tool === ADOPT_TOOL)).toBe(true);
    const slots = (rerun.kind === "completed" ? rerun.output.media_slots : []) as Record<string, unknown>[];
    expect(slots.every((slot) => slot.status === "has_trusted_artifact")).toBe(true);
    expect((slots[0].verification as Record<string, unknown>).source).toBe("adopted");
    expect(jobState).toBeDefined();
  });

  it("(c) a terminally failed PDF job is a blocked slot carrying the renderer error verbatim, and the images still land", async () => {
    const deps = bridge({ pollsToFinish: 2, failSlots: { worksheet: "renderer_unavailable:chromium RENDER_SERVICE_URL not reachable" } });
    const { outcome } = await driveToTerminal({ deps });

    expect(outcome.kind).toBe("completed");
    const output = outcome.kind === "completed" ? outcome.output : {};
    const slots = output.media_slots as Record<string, unknown>[];
    const worksheet = slots.find((slot) => slot.slotId === "worksheet")!;
    expect(worksheet.status).toBe("blocked");
    // Verbatim: a renderer problem is the operator's to read, not ours to paraphrase.
    expect(worksheet.blocker).toBe("renderer_unavailable:chromium RENDER_SERVICE_URL not reachable");
    expect(output.blockers).toContain("worksheet: renderer_unavailable:chromium RENDER_SERVICE_URL not reachable");
    // One bad slot does not kill the article.
    expect(slots.filter((slot) => slot.status === "has_trusted_artifact")).toHaveLength(3);
    // And a blocked slot contributes no verified reference downstream.
    expect((output.artifactReferences as unknown[]).length).toBe(3);
  });

  it("(d) the envelope validates against the unchanged artifact_plan.v1 output schema, and the publisher's evidence readers find it", async () => {
    const deps = bridge({ pollsToFinish: 1 });
    const { outcome } = await driveToTerminal({ deps });
    const output = outcome.kind === "completed" ? outcome.output : {};

    for (const schema of [node.outputSchema, node.schema]) {
      const validation = validateOutput(output, schema);
      expect(validation.ok, validation.ok ? "" : validation.errors.join("; ")).toBe(true);
    }

    // The W8.3 binding change: both readers must find the plan under the materializer's node id.
    const stageOutputs = { artifact_materializer: output };
    expect(materializedPlanOf(stageOutputs)).toBe(output);
    const refs = artifactPlanVerifiedMediaRefsOf(stageOutputs);
    expect(refs).toContain(`/img/${REQUEST_ID}/hero.webp`);
    expect(refs).toContain(`img/${REQUEST_ID}/hero.webp`);
    expect(refs).toContain(`/pdf/${REQUEST_ID}/worksheet.pdf`);
  });

  it("(e) runs the whole loop with no runner, no model config and no usage — the module cannot consult a model", async () => {
    const deps = bridge({ pollsToFinish: 4 });
    const { outcome } = await driveToTerminal({ deps });
    expect(outcome.kind).toBe("completed");
    // Every bridge call is one of the three artifact verbs; nothing else was reached.
    expect([...new Set(deps.calls.map((call) => call.tool))].sort()).toEqual([CREATE_TOOL, ADOPT_TOOL, STATUS_TOOL].sort());
    // The structural form of "total model calls = 0": the only injectable seams this module has are a
    // project repository and a callTool. There is no runner, no model config and no usage recorder to
    // pass it, so a model cannot be consulted here even by mistake.
    expect(Object.keys(deps)).toEqual(["calls", "callTool"]);
  });

  it("refuses the NODE (never a half-materialized plan) when the spec, the site scope or the poll budget is missing", async () => {
    const deps = bridge();
    const noSpec = await runArtifactMaterialization(
      { run: { runId: "r", projectId: "dr-lurie", stageOutputs: {} } as unknown as WorkflowExecutionRecord, node },
      { projectRepository, callTool: deps.callTool }
    );
    expect(noSpec).toMatchObject({ kind: "refused", code: "materialization_spec_missing" });

    const noSite = await runArtifactMaterialization(
      { run: runFixture(), node },
      { projectRepository: { get: async () => ({ projectId: "dr-lurie", status: "active" }) } as unknown as ProjectRepository, callTool: deps.callTool }
    );
    expect(noSite).toMatchObject({ kind: "refused", code: "artifact_site_scope_missing" });

    // A job that never finishes exhausts the bound and blocks RETRYABLY — the job ids are persisted,
    // so a retry adopts rather than creating a fifth image.
    const stuck = bridge({ pollsToFinish: 10_000 });
    const budgeted = { ...node, metadata: { ...node.metadata, maxPollDispatches: 3 } };
    let jobState: MaterializerJobState | undefined;
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await runArtifactMaterialization({ run: runFixture(FOUR_SLOTS, jobState), node: budgeted }, { projectRepository, callTool: stuck.callTool });
      if (last.kind !== "pending") break;
      jobState = last.jobState;
    }
    expect(last).toMatchObject({ kind: "refused", code: "artifact_materialization_poll_budget_exhausted" });
    expect(createCalls(stuck.calls)).toHaveLength(4);
  });

  // THE ZERO-MEDIA FLOOR — the regression W8 nearly shipped. A text-only run declares mediaSlots: []
  // on brief_architect, artifact_plan skips, and a skipped node writes no stage output. Before this
  // pair of locks the materializer dispatched into that absence and refused, blocking every text-only
  // article at a node whose entire job is media.
  it("skips alongside its planner on a zero-media run, because it shares the planner's carrier", () => {
    const stageOutputs = { brief_architect: { artifact: "article_brief.v1", mediaSlots: [] }, contract_intelligence: { artifact: "contract_intelligence.v1", clientObjectType: "content_item" } };
    const initialInput = { topic: "barrier repair", contentClass: "editorial" };
    // brief_architect is on this node's dependsOn for exactly this reason — carriersFor reads a node's
    // own dependencies, so without that edge the predicate cannot see the declaration.
    expect(node.dependsOn).toContain("brief_architect");
    expect(evaluateNodeSkip(getWorkspaceNode("artifact_plan")!, { initialInput, stageOutputs })?.skip).toBe(true);
    expect(evaluateNodeSkip(node, { initialInput, stageOutputs })?.skip).toBe(true);
  });

  it("completes with an empty plan — never refuses — when it dispatches anyway and the planner was skipped", async () => {
    const deps = bridge();
    const run = {
      runId: "run_text_only",
      projectId: "dr-lurie",
      executionMode: "openai",
      stageOutputs: { contract_intelligence: { artifact: "contract_intelligence.v1", clientObjectType: "content_item" } },
      nodes: [{ nodeId: "artifact_plan", status: "skipped" }]
    } as unknown as WorkflowExecutionRecord;
    const outcome = await runArtifactMaterialization({ run, node }, { projectRepository, callTool: deps.callTool });
    expect(outcome.kind).toBe("completed");
    expect(deps.calls).toHaveLength(0);
    const output = outcome.kind === "completed" ? outcome.output : {};
    expect(output.media_slots).toEqual([]);
    expect(validateOutput(output, node.outputSchema).ok).toBe(true);
    // A skipped planner may precede the publishRequestId mint, so the empty plan claims no id it does
    // not have — and must still validate.
    expect(output.requestId).toBeUndefined();
  });

  it("still refuses when the spec is absent and the planner did NOT skip — that is a real gap", async () => {
    const deps = bridge();
    const run = {
      runId: "run_broken",
      projectId: "dr-lurie",
      executionMode: "openai",
      stageOutputs: {},
      nodes: [{ nodeId: "artifact_plan", status: "failed" }]
    } as unknown as WorkflowExecutionRecord;
    expect(await runArtifactMaterialization({ run, node }, { projectRepository, callTool: deps.callTool })).toMatchObject({ kind: "refused", code: "materialization_spec_missing" });
  });

  it("a zero-slot spec completes with an empty plan and touches the bridge not at all", async () => {
    const deps = bridge();
    const outcome = await runArtifactMaterialization({ run: runFixture([]), node }, { projectRepository, callTool: deps.callTool });
    expect(outcome.kind).toBe("completed");
    expect(deps.calls).toHaveLength(0);
    const output = outcome.kind === "completed" ? outcome.output : {};
    expect(output.media_slots).toEqual([]);
    // The zero-media schema rule still holds: a protocol-less empty plan is legal.
    const protocolLess = { ...output };
    delete protocolLess.artifactProtocol;
    expect(validateOutput(protocolLess, node.outputSchema).ok).toBe(true);
  });
});
