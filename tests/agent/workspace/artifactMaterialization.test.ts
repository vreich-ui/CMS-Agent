import { describe, expect, it } from "vitest";
import {
  ADOPT_TOOL,
  ARTIFACT_MATERIALIZER_JOB_STAGE_KEY,
  CREATE_TOOL,
  STATUS_TOOL,
  evaluateBridgePolicy,
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

// C2. A registered client with NO executable policy hook — the ordinary case, and the one the §3.10
// asset path is specified against. `dr-lurie` keeps its own hooks (and its own test below), so the two
// facts stay separable: "does the materializer forward/derive what it should" and "what does one
// particular client's executable policy do to that".
const HOOKLESS_PROJECT = "acme-media";
const hooklessConfig = { projectId: HOOKLESS_PROJECT, status: "active", objectDialect: { siteObjectId: SITE_ID } } as unknown as ProjectConnectionConfig;
const hooklessRepository = { get: async () => hooklessConfig } as unknown as ProjectRepository;

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

// C1 threaded BRIEF §3.7's site facts onto contract_intelligence.v1. This is the half C2 reads: the
// site's published PDF templates (with the renderDataSchema the mapper emits against) and the draft
// the render data is derived FROM. The schema mirrors pdf-tool's real
// `templates/article_brochure_v1.json` at the top level — required brand/title/deck/sections/
// pullQuotes/sources, additionalProperties:false — without pasting its 2.6KB of $defs.
const ARTICLE_RENDER_DATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brand", "title", "deck", "sections", "pullQuotes", "sources"],
  properties: {
    brand: { type: "object" },
    title: { type: "string" },
    deck: { type: "string" },
    kicker: { type: "string" },
    author: { type: "string" },
    coverImage: { type: "string" },
    sections: { type: "array" },
    pullQuotes: { type: "array" },
    sources: { type: "array" }
  }
};

const ARTICLE_CONTRACT = {
  contract_intelligence: {
    artifact: "contract_intelligence.v1",
    clientObjectType: "content_item",
    pdfTemplates: [
      { templateId: "article_brochure_v1", kind: "article", label: "Article Brochure", isDefault: true, renderDataSchema: ARTICLE_RENDER_DATA_SCHEMA },
      { templateId: "tpl_checklist_v1", kind: "checklist", label: "Checklist", isDefault: false }
    ]
  },
  draft_writer: {
    artifact: "draft.v1",
    summary: "A draft about barrier repair.",
    title: "Rebuilding the skin barrier without stripping it",
    deck: "What actually repairs a compromised barrier, and what only feels like it does.",
    sections: [
      { heading: "What the barrier actually is", paragraphs: ["A short first paragraph about lipids.", "A second paragraph about ceramides."] },
      { heading: "What to stop doing", body: "Stop over-exfoliating." },
      // Dropped: a heading with no prose is a planning gap, never a page.
      { heading: "Coming soon", paragraphs: [] }
    ],
    pullQuotes: [{ quote: "Barrier repair is subtraction before addition.", attribution: "Dr. Lurie" }],
    sources: [{ label: "Journal of Dermatological Science, 2024", url: "https://example.invalid/jds-2024" }]
  }
};

const runFixture = (
  slots: Record<string, unknown>[] = FOUR_SLOTS,
  jobState?: MaterializerJobState,
  extras: { projectId?: string; stageOutputs?: Record<string, unknown> } = {}
): WorkflowExecutionRecord =>
  ({
    runId: "run_materializer_1",
    projectId: extras.projectId ?? "dr-lurie",
    executionMode: "openai",
    // No content-item shell on this fixture: the planner's requestId stands, which is the
    // server-minted-id client's case and keeps every other assertion here about the loop itself.
    nodes: [],
    stageOutputs: {
      artifact_plan: spec(slots),
      ...(extras.stageOutputs ?? {}),
      ...(jobState ? { [ARTIFACT_MATERIALIZER_JOB_STAGE_KEY]: jobState } : {})
    }
  }) as unknown as WorkflowExecutionRecord;

type Call = { tool: string; args: Record<string, unknown> };

/** A bridge whose jobs need `pollsToFinish` polls before they report complete. */
const bridge = (options: { pollsToFinish?: number; failSlots?: Record<string, string>; adopted?: Record<string, boolean>; imageKeyRoot?: string; canonicalBlobKeys?: boolean } = {}) => {
  const calls: Call[] = [];
  const polls: Record<string, number> = {};
  const pollsToFinish = options.pollsToFinish ?? 1;
  // pdf-tool's canonical blob layout is `{artifactKind}/{safeRequestId}/{sha256}{ext}` — i.e. keys
  // really do start with `image/`. The default `img` here is the historical fixture value; tests that
  // care about what a blob key LOOKS like ask for the canonical root.
  const imageKeyRoot = options.imageKeyRoot ?? "img";
  // FIX-2: the canonical layout's filename is the SHA256 OF THE BYTES, which is why such a key cannot
  // be hand-authored and why dr-lurie's policy can safely exempt it. The historical fixture spells the
  // filename as the slot name — fine for the loop's own arithmetic, wrong for anything asserting what
  // a real key looks like — so a test that cares asks for the real thing.
  const canonicalName = (slot: string, ext: string) => (options.canonicalBlobKeys ? `${"b".repeat(64)}.${ext}` : `${slot}.${ext}`);
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
      const dir = slotOfJob === "worksheet" ? "pdf" : imageKeyRoot;
      const name = canonicalName(slotOfJob, ext);
      return { ok: true, result: { structuredContent: { data: { job: { jobId, status: "complete", artifactReference: { blobKey: `${dir}/${REQUEST_ID}/${name}`, sha256: "b".repeat(64), contentType: slotOfJob === "worksheet" ? "application/pdf" : "image/webp", size: 4096 }, public_path: `/${dir}/${REQUEST_ID}/${name}` } } } } };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  // Cast at the seam: the fixture returns only the fields this module reads, and annotating every
  // literal with the adapter's full CallToolResult would bury the payloads these tests are about.
  return { calls, callTool: callTool as unknown as NonNullable<MaterializerDeps["callTool"]> };
};

/** Drives the node the way the executor does: re-queue on pending, persist job state, dispatch again. */
const driveToTerminal = async (params: {
  slots?: Record<string, unknown>[];
  deps: { calls: Call[]; callTool: ReturnType<typeof bridge>["callTool"] };
  maxDispatches?: number;
  projectId?: string;
  projectRepository?: ProjectRepository;
  stageOutputs?: Record<string, unknown>;
}) => {
  let jobState: MaterializerJobState | undefined;
  let dispatches = 0;
  // Warnings are per-DISPATCH (the executor records each one as it lands), so a caller that wants to
  // assert on something the node said while it was still pending has to accumulate them the way the
  // run log does.
  const warnings: string[] = [];
  for (let i = 0; i < (params.maxDispatches ?? 12); i += 1) {
    dispatches += 1;
    const outcome = await runArtifactMaterialization(
      { run: runFixture(params.slots ?? FOUR_SLOTS, jobState, { ...(params.projectId ? { projectId: params.projectId } : {}), ...(params.stageOutputs ? { stageOutputs: params.stageOutputs } : {}) }), node },
      { projectRepository: params.projectRepository ?? projectRepository, callTool: params.deps.callTool }
    );
    if (outcome.kind !== "refused") warnings.push(...outcome.warnings);
    if (outcome.kind === "pending") {
      jobState = outcome.jobState;
      continue;
    }
    return { outcome, dispatches, jobState, warnings };
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
    // THREE creates, not four: C2's §3.10 ordering means the worksheet PDF is never dispatched while
    // an image slot is still running, because its cover cannot be named before the image exists. Its
    // job was therefore never bought — which is the point: a budget exhausted on images does not also
    // spend on a PDF that would have rendered cover-less.
    expect(createCalls(stuck.calls).map((call) => call.args.slot)).toEqual(["hero", "inline_1", "inline_2"]);
  });

  // WHOSE REQUEST ID. The planner runs before the content-item shell exists and before runContext holds
  // any publish id, so whatever it authors is a guess at the client's convention. The bridge's
  // request_id names the object that OWNS the artifact, and on a request_id-dialect client that is the
  // shell's id. A one-character disagreement writes artifacts under an object the client can never list.
  it("writes artifacts under the OWNING object's request id, not the planner's guess", async () => {
    const deps = bridge({ pollsToFinish: 1 });
    const shellId = "req_conductor_owning_20260831_07";
    const run = {
      runId: "run_shell_wins",
      projectId: "dr-lurie",
      executionMode: "openai",
      stageOutputs: { artifact_plan: spec([FOUR_SLOTS[0]]) },
      nodes: [{ nodeId: "artifact_materializer", input: { contentItemShell: { objectId: shellId, created: true, objectType: "content_item", requestId: shellId } } }]
    } as unknown as WorkflowExecutionRecord;

    // Two dispatches, the way the executor drives it: adopt+create, then poll.
    const first = await runArtifactMaterialization({ run, node }, { projectRepository, callTool: deps.callTool });
    expect(first.kind).toBe("pending");
    const withJobs = { ...run, stageOutputs: { ...run.stageOutputs, [ARTIFACT_MATERIALIZER_JOB_STAGE_KEY]: first.kind === "pending" ? first.jobState : {} } } as unknown as WorkflowExecutionRecord;
    const outcome = await runArtifactMaterialization({ run: withJobs, node }, { projectRepository, callTool: deps.callTool });
    expect(outcome.kind).toBe("completed");
    // Every bridge call — adopt, create, poll — is scoped to the shell's id, never the spec's.
    expect(deps.calls.every((call) => call.args.request_id === shellId)).toBe(true);
    expect(deps.calls.some((call) => call.args.request_id === REQUEST_ID)).toBe(false);
    // And the envelope reports the id the artifacts actually live under, because runContext lifts it
    // and the publisher patches that object.
    const output = outcome.kind === "completed" ? outcome.output : {};
    expect(output.requestId).toBe(shellId);
    // The disagreement is recorded, not silently resolved.
    expect(outcome.kind === "completed" ? outcome.warnings : []).toContain(`artifact_request_id_from_shell:${shellId}`);
  });

  it("falls back to the planner's id when there is no shell (a server-minted-id client)", async () => {
    const deps = bridge({ pollsToFinish: 1 });
    const { outcome } = await driveToTerminal({ deps, slots: [FOUR_SLOTS[0]] });
    expect(outcome.kind).toBe("completed");
    expect(deps.calls.every((call) => call.args.request_id === REQUEST_ID)).toBe(true);
    expect((outcome.kind === "completed" ? outcome.warnings : []).some((warning) => warning.startsWith("artifact_request_id_from_shell"))).toBe(false);
  });

  // A RETRY MUST RECONSIDER A BLOCKED SLOT — the defect found on run_1788189874186_5973sq. retryNode
  // clears stageOutputs[nodeId] but not the ":jobs" key, so a blocked slot used to read back as terminal
  // and the retry completed instantly with the identical error, making an operator's fix look inert.
  it("re-attempts a blocked slot on a retry, and buys nothing that already succeeded", async () => {
    const deps = bridge({ pollsToFinish: 1 });
    const priorJobs: MaterializerJobState = {
      dispatches: 3,
      slots: {
        hero: { slotId: "hero", phase: "materialized", status: "complete", jobId: "job_hero", attempts: 2, createdAt: "x", updatedAt: "x", artifactReference: { blobKey: `img/${REQUEST_ID}/hero.webp` }, publicPath: `/img/${REQUEST_ID}/hero.webp`, verification: { source: "job" } },
        inline_1: { slotId: "inline_1", phase: "running", status: "running", jobId: "job_inline_1", attempts: 2, createdAt: "x", updatedAt: "x" },
        inline_2: { slotId: "inline_2", phase: "blocked", status: "create_failed", attempts: 0, createdAt: "x", updatedAt: "x", error: "bridge_error_result:status 400 requirements.format: Invalid enum value" }
      }
    };
    // The retry signal: the node's envelope is gone, the job bookkeeping is not.
    const run = {
      runId: "run_materializer_1",
      projectId: "dr-lurie",
      executionMode: "openai",
      nodes: [],
      stageOutputs: { artifact_plan: spec(FOUR_SLOTS.slice(0, 3)), [ARTIFACT_MATERIALIZER_JOB_STAGE_KEY]: priorJobs }
    } as unknown as WorkflowExecutionRecord;

    const outcome = await runArtifactMaterialization({ run, node }, { projectRepository, callTool: deps.callTool });

    // The blocked slot is re-attempted: adopt (finds nothing) then create.
    expect(createCalls(deps.calls).map((call) => call.args.slot)).toEqual(["inline_2"]);
    expect(deps.calls.filter((call) => call.tool === ADOPT_TOOL).map((call) => call.args.slot)).toEqual(["inline_2"]);
    // The materialized slot is never re-created and never even re-adopted.
    expect(deps.calls.some((call) => call.args.slot === "hero")).toBe(false);
    // The in-flight slot keeps its job id and is polled, never duplicated.
    expect(deps.calls.filter((call) => call.tool === STATUS_TOOL).map((call) => call.args.job_id)).toContain("job_inline_1");
    expect(outcome.kind === "pending" || outcome.kind === "completed").toBe(true);
    const warnings = outcome.kind === "refused" ? [] : outcome.warnings;
    expect(warnings).toContain("artifact_slot_retried:inline_2");
  });

  it("does NOT reset a blocked slot mid-run, when the node's own envelope is still present", async () => {
    const deps = bridge({ pollsToFinish: 1 });
    const priorJobs: MaterializerJobState = {
      dispatches: 1,
      slots: { hero: { slotId: "hero", phase: "blocked", status: "create_failed", attempts: 0, createdAt: "x", updatedAt: "x", error: "refused" } }
    };
    const run = {
      runId: "run_materializer_1",
      projectId: "dr-lurie",
      executionMode: "openai",
      nodes: [],
      stageOutputs: {
        artifact_plan: spec([FOUR_SLOTS[0]]),
        artifact_materializer: { artifact: "artifact_plan.v1" },
        [ARTIFACT_MATERIALIZER_JOB_STAGE_KEY]: priorJobs
      }
    } as unknown as WorkflowExecutionRecord;

    const outcome = await runArtifactMaterialization({ run, node }, { projectRepository, callTool: deps.callTool });
    // Terminal stays terminal within a run: no second job for a slot this dispatch sequence already gave up on.
    expect(deps.calls).toHaveLength(0);
    expect(outcome.kind).toBe("completed");
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
  // ------------------------------------------------------------------------------------------
  // C2 (BRIEF §3.8 and §3.10): run/slot style, the usage-context policy, the executable project
  // policy, and deterministic PDF render data.

  it("C2: forwards a slot's `style` verbatim on create, folding brief_architect's `instructions` into the bridge's `note`", async () => {
    const deps = bridge({ pollsToFinish: 1 });
    const styled = [
      { ...FOUR_SLOTS[0], style: { visualStandardId: "vis_drlurie_editorial", override: { styleSentence: "soft daylight, matte finish" }, note: "keep it clinical" } },
      { ...FOUR_SLOTS[1], style: { instructions: "match the mood board's palette, not its subject" } }
    ];
    await driveToTerminal({ deps, slots: styled });

    const hero = createCalls(deps.calls).find((call) => call.args.slot === "hero")!;
    expect(hero.args.style).toEqual({ visualStandardId: "vis_drlurie_editorial", override: { styleSentence: "soft daylight, matte finish" }, note: "keep it clinical" });
    // R4's subject-only rule survives: nothing from `style` leaked into the prompt.
    expect(hero.args.prompt).toBe("a jar of moisturizer on a marble countertop");

    // pdf-tool's style object is `.strict()`, so `instructions` — brief_architect's spelling — has to
    // become `note` here or the whole create is rejected for an unknown key.
    const inline = createCalls(deps.calls).find((call) => call.args.slot === "inline_1")!;
    expect(inline.args.style).toEqual({ note: "match the mood board's palette, not its subject" });

    // A slot with no style sends no style key at all — not an empty object.
    const bare = bridge({ pollsToFinish: 1 });
    await driveToTerminal({ deps: bare, slots: [FOUR_SLOTS[0]] });
    expect(Object.keys(createCalls(bare.calls)[0].args)).not.toContain("style");
  });

  it("C2: blocks a slot whose usageContext is not in the site's image-model policy, with the code usage_context_not_in_policy", async () => {
    const deps = bridge({ pollsToFinish: 1 });
    const contexts = { contract_intelligence: { artifact: "contract_intelligence.v1", clientObjectType: "content_item", imagePolicyContexts: ["article_hero", "article_body"] } };
    const slots = [
      { ...FOUR_SLOTS[0], requirements: { image: { usageContext: "article_hero", outputFormat: "webp" } } },
      { ...FOUR_SLOTS[1], requirements: { image: { usageContext: "instagram_story", outputFormat: "webp" } } }
    ];
    const { outcome } = await driveToTerminal({ deps, slots, stageOutputs: contexts });

    expect(outcome.kind).toBe("completed");
    const mediaSlots = (outcome.kind === "completed" ? outcome.output.media_slots : []) as Record<string, unknown>[];
    const offender = mediaSlots.find((slot) => slot.slotId === "inline_1")!;
    expect(offender.status).toBe("blocked");
    expect(String(offender.blocker)).toContain("usage_context_not_in_policy");
    expect(String(offender.blocker)).toContain("instagram_story");
    // Never dispatched: the refusal happens while composing the args, before any create.
    expect(createCalls(deps.calls).map((call) => call.args.slot)).toEqual(["hero"]);
    // The in-policy slot is untouched — one bad slot does not kill the article.
    expect(mediaSlots.find((slot) => slot.slotId === "hero")?.status).toBe("has_trusted_artifact");

    // With no policy list on the run there is nothing to check against, and nothing is blocked: an
    // unknown policy is not a violation.
    const unchecked = bridge({ pollsToFinish: 1 });
    const loose = await driveToTerminal({ deps: unchecked, slots });
    expect(createCalls(unchecked.calls).map((call) => call.args.slot)).toEqual(["hero", "inline_1"]);
    expect(loose.outcome.kind).toBe("completed");
  });

  it("C2: runs every image slot to a terminal state BEFORE it dispatches a PDF slot", async () => {
    const deps = bridge({ pollsToFinish: 3, imageKeyRoot: "image" });
    const { outcome } = await driveToTerminal({ deps, projectId: HOOKLESS_PROJECT, projectRepository: hooklessRepository, stageOutputs: ARTICLE_CONTRACT });

    expect(outcome.kind).toBe("completed");
    expect(createCalls(deps.calls).map((call) => call.args.slot)).toEqual(["hero", "inline_1", "inline_2", "worksheet"]);

    // Not merely "last in the array": at the moment the PDF was created, every image job had already
    // reported terminal success — which is the only reason its cover could be named at all.
    const pdfCreateIndex = deps.calls.findIndex((call) => call.tool === CREATE_TOOL && call.args.slot === "worksheet");
    const before = deps.calls.slice(0, pdfCreateIndex);
    for (const slotId of ["hero", "inline_1", "inline_2"]) {
      expect(before.some((call) => call.tool === CREATE_TOOL && call.args.slot === slotId), slotId).toBe(true);
      expect(before.some((call) => call.tool === STATUS_TOOL && call.args.job_id === `job_${slotId}`), slotId).toBe(true);
    }
    // The PDF is not adopted or polled before the images are done either.
    expect(before.some((call) => call.args.slot === "worksheet" && call.tool !== ADOPT_TOOL)).toBe(false);
  });

  it("C2: a PDF slot on the site's default article template needs NO model-filled data — template_id, data and assets are all derived", async () => {
    const deps = bridge({ pollsToFinish: 1, imageKeyRoot: "image" });
    const slots = [
      FOUR_SLOTS[0],
      // No renderData, no assets: exactly what artifact_plan emits for an article template whose
      // renderDataSchema the run can fill deterministically (R7).
      { slotId: "brochure", purpose: "downloadable article PDF", desiredKind: "pdf", templateId: "article_brochure_v1" }
    ];
    const { outcome, warnings } = await driveToTerminal({ deps, slots, projectId: HOOKLESS_PROJECT, projectRepository: hooklessRepository, stageOutputs: ARTICLE_CONTRACT });
    expect(outcome.kind).toBe("completed");

    const create = createCalls(deps.calls).find((call) => call.args.slot === "brochure")!;
    expect(create.args.template_id).toBe("article_brochure_v1");

    const data = create.args.data as Record<string, unknown>;
    expect(data.title).toBe("Rebuilding the skin barrier without stripping it");
    expect(data.deck).toBe("What actually repairs a compromised barrier, and what only feels like it does.");
    expect(data.sections).toEqual([
      { heading: "What the barrier actually is", paragraphs: ["A short first paragraph about lipids.", "A second paragraph about ceramides."] },
      { heading: "What to stop doing", paragraphs: ["Stop over-exfoliating."] }
    ]);
    expect(data.pullQuotes).toEqual([{ quote: "Barrier repair is subtraction before addition.", attribution: "Dr. Lurie" }]);
    expect(data.sources).toEqual([{ label: "Journal of Dermatological Science, 2024", url: "https://example.invalid/jds-2024" }]);
    // Nothing was invented: `brand` is required by the template but is not derivable from a draft, so
    // it is absent rather than fabricated (pdf-tool does not validate a job's `data` against the
    // template schema — the template renders on its own defaults).
    expect(data.brand).toBeUndefined();
    // Only keys the template's own renderDataSchema declares.
    expect(Object.keys(data).every((key) => ["title", "deck", "kicker", "author", "coverImage", "sections", "pullQuotes", "sources", "brand"].includes(key))).toBe(true);

    // §3.10: the cover is the header IMAGE slot, named by assetId and resolved by pdf-tool from the
    // blobKey. The bytes never travel.
    expect(data.coverImage).toBe("hero");
    expect(create.args.assets).toEqual({ images: [{ assetId: "hero", blobKey: `image/${REQUEST_ID}/hero.webp` }] });

    // The derivation and the one required field it could not fill are both reported on the run.
    expect(warnings).toContain("artifact_render_data_unfilled:brochure:brand");
    expect(warnings).toContain("artifact_pdf_cover_bound:brochure:hero");
    expect(warnings.some((warning) => warning.startsWith("artifact_render_data_derived:brochure:"))).toBe(true);
  });

  it("C2: the planner's own renderData still wins per key over the derived one", async () => {
    const deps = bridge({ pollsToFinish: 1, imageKeyRoot: "image" });
    const slots = [
      FOUR_SLOTS[0],
      { slotId: "brochure", purpose: "downloadable article PDF", desiredKind: "pdf", templateId: "article_brochure_v1", renderData: { title: "A deliberately different cover title" } }
    ];
    const { outcome } = await driveToTerminal({ deps, slots, projectId: HOOKLESS_PROJECT, projectRepository: hooklessRepository, stageOutputs: ARTICLE_CONTRACT });
    expect(outcome.kind).toBe("completed");
    const data = createCalls(deps.calls).find((call) => call.args.slot === "brochure")!.args.data as Record<string, unknown>;
    expect(data.title).toBe("A deliberately different cover title");
    // …and the rest is still derived, so overriding one field does not cost the other five.
    expect(Array.isArray(data.sections)).toBe(true);
    expect(data.coverImage).toBe("hero");
  });

  it("C2: the three per-kind create refusals are blocked SLOTS carrying their code", async () => {
    const cases: Array<{ slot: Record<string, unknown>; code: string }> = [
      { slot: { slotId: "no_template", purpose: "a PDF nobody chose a template for", desiredKind: "pdf", renderData: { title: "x" } }, code: "no_pdf_template" },
      // A template the run knows nothing about (or a non-article one) derives nothing, so a slot that
      // brought no renderData of its own has none at all.
      { slot: { slotId: "no_data", purpose: "a PDF with a template but no data", desiredKind: "pdf", templateId: "tpl_worksheet_v1" }, code: "no_render_data" },
      { slot: { slotId: "no_prompt", purpose: "an image nobody wrote a subject for", desiredKind: "image" }, code: "no_image_prompt" }
    ];
    for (const { slot, code } of cases) {
      const deps = bridge({ pollsToFinish: 1 });
      const { outcome } = await driveToTerminal({ deps, slots: [slot], stageOutputs: ARTICLE_CONTRACT });
      expect(outcome.kind, code).toBe("completed");
      const mediaSlots = (outcome.kind === "completed" ? outcome.output.media_slots : []) as Record<string, unknown>[];
      expect(mediaSlots[0].status, code).toBe("blocked");
      expect(String(mediaSlots[0].blocker).startsWith(`${code}:`), String(mediaSlots[0].blocker)).toBe(true);
      // Adopted (free, and the reason a re-run is free) but never created.
      expect(createCalls(deps.calls), code).toHaveLength(0);
    }
  });

  // THE POLICY GAP THIS CLOSES. Every other deterministic conductor call site runs the project's
  // executable policy hook before its transport; this module reached ProjectMcpAdapter directly and
  // ran none, so a project whose policy blocks a verb or an argument shape was silently obeyed
  // everywhere EXCEPT the one module that creates things on the client.
  it("C2: runs the project's executable call-tool policy before every bridge call", async () => {
    // (i) the two SCOPES, at the seam itself. A finding whose path is the tool name condemns the verb
    // for every slot at once (a node refusal); a finding on the arguments is per-slot.
    expect(evaluateBridgePolicy("dr-lurie", "save_artifact", { site_id: SITE_ID })).toMatchObject({ scope: "tool", codes: ["blocked_legacy_artifact_tool"] });
    // A HAND-COPIED reference is still an arguments-scope block — the rule the pattern exists for.
    expect(evaluateBridgePolicy("dr-lurie", CREATE_TOOL, { site_id: SITE_ID, assets: { images: [{ assetId: "hero", blobKey: `image/${REQUEST_ID}/hero.webp` }] } })).toMatchObject({ scope: "arguments", codes: ["blocked_copied_artifact_ref"] });
    // FIX-2: …and the SANCTIONED §3.10 cover binding is not, because a canonical
    // `{kind}/{request}/{sha256}{ext}` key is machine-minted by construction (its filename is the
    // digest of bytes nobody knows until they exist) and so cannot be the hand-copied reference the
    // rule is about. Before this, an article PDF with a cover was a blocked slot on dr-lurie.
    expect(evaluateBridgePolicy("dr-lurie", CREATE_TOOL, { site_id: SITE_ID, assets: { images: [{ assetId: "hero", blobKey: `image/${REQUEST_ID}/${"b".repeat(64)}.webp` }] } })).toBeUndefined();
    // The three sanctioned verbs with ordinary arguments pass, so nothing here is blocked by accident.
    expect(evaluateBridgePolicy("dr-lurie", CREATE_TOOL, { site_id: SITE_ID, prompt: "a jar of moisturizer on a marble countertop", filename: "hero.webp" })).toBeUndefined();
    expect(evaluateBridgePolicy("dr-lurie", ADOPT_TOOL, { site_id: SITE_ID, request_id: REQUEST_ID, slot: "hero" })).toBeUndefined();
    expect(evaluateBridgePolicy("dr-lurie", STATUS_TOOL, { site_id: SITE_ID, job_id: "job_hero" })).toBeUndefined();
    // A project with no hook at all is never blocked.
    expect(evaluateBridgePolicy(HOOKLESS_PROJECT, "save_artifact", {})).toBeUndefined();

    // (ii) FIX-2, end to end and on the real client this bit: dr-lurie's own executable policy no
    // longer blocks the sanctioned cover binding, so an article PDF with a cover RENDERS. The cover
    // this run binds is the header image the same run just generated, named by assetId and resolved by
    // pdf-tool from a canonical blobKey — the bytes never travel.
    const canonical = bridge({ pollsToFinish: 1, imageKeyRoot: "image", canonicalBlobKeys: true });
    const rendered = await driveToTerminal({
      deps: canonical,
      slots: [FOUR_SLOTS[0], { slotId: "brochure", purpose: "downloadable article PDF", desiredKind: "pdf", templateId: "article_brochure_v1" }],
      stageOutputs: ARTICLE_CONTRACT
    });
    expect(rendered.outcome.kind).toBe("completed");
    const renderedSlots = (rendered.outcome.kind === "completed" ? rendered.outcome.output.media_slots : []) as Record<string, unknown>[];
    expect(renderedSlots.find((slot) => slot.slotId === "brochure")?.status).toBe("has_trusted_artifact");
    const coverCreate = createCalls(canonical.calls).find((call) => call.args.slot === "brochure")!;
    expect(coverCreate.args.assets).toEqual({ images: [{ assetId: "hero", blobKey: `image/${REQUEST_ID}/${"b".repeat(64)}.webp` }] });
    expect((coverCreate.args.data as Record<string, unknown>).coverImage).toBe("hero");

    // (iii) …and a finding on the ARGUMENTS is still per-slot, so a genuinely HAND-COPIED reference —
    // one the planner typed onto the slot's own `assets`, which is precisely what the rule exists to
    // refuse — blocks that slot and the article keeps the rest of its media.
    const argBlocked = bridge({ pollsToFinish: 1, imageKeyRoot: "image", canonicalBlobKeys: true });
    const { outcome } = await driveToTerminal({
      deps: argBlocked,
      slots: [
        FOUR_SLOTS[0],
        { slotId: "brochure", purpose: "downloadable article PDF", desiredKind: "pdf", templateId: "article_brochure_v1", assets: { images: [{ assetId: "typed_cover", blobKey: `image/${REQUEST_ID}/cover.webp` }] } }
      ],
      stageOutputs: ARTICLE_CONTRACT
    });
    expect(outcome.kind).toBe("completed");
    const mediaSlots = (outcome.kind === "completed" ? outcome.output.media_slots : []) as Record<string, unknown>[];
    expect(mediaSlots.find((slot) => slot.slotId === "hero")?.status).toBe("has_trusted_artifact");
    const brochure = mediaSlots.find((slot) => slot.slotId === "brochure")!;
    expect(brochure.status).toBe("blocked");
    expect(String(brochure.blocker)).toContain("tool_policy_blocked");
    expect(String(brochure.blocker)).toContain("blocked_copied_artifact_ref");
    // And the blocked call never reached the client.
    expect(argBlocked.calls.some((call) => call.tool === CREATE_TOOL && call.args.slot === "brochure")).toBe(false);
  });
});
