// W8.3 (2026-08-31) — artifact_materializer: the deterministic node that turns `materialization_spec.v1`
// into materialized, verified media, with NO model turn at all.
//
// WHAT THIS REPLACES. Until W8, `artifact_plan` was a gpt-5.5 tool loop: every adopt, every create and
// every one of the many status polls an image generation needs was a MODEL TURN over a 50-70K context.
// A four-slot article cost $2-3 in the media stage, none of which paid for a single generated pixel —
// and it routinely ran out of tool-call budget mid-flight, reporting slots `needs_generation` while
// their images materialized seconds later, unbound. Polling is not a judgement. It is a state machine,
// and this module is that state machine.
//
// THE SPLIT. `artifact_plan` keeps its id and becomes ONE model turn with no tools: it reads
// brief_architect's mediaSlots, contract_intelligence's protocol and draft_writer's prose, and emits
// `materialization_spec.v1` — per slot, what to make and (for a PDF) which published template plus the
// renderData to fill it with. This node then EXECUTES that spec and emits `artifact_plan.v1`, byte-shape
// identical to what artifact_plan emitted before, so article_body, the publisher's W6 media evidence
// and the readiness checks read exactly what they always read (see materializedPlan.ts for the one
// binding that did have to change).
//
// THE LOOP, AND WHY IT IS SHAPED LIKE captureConductorRoutes.ts. This module COMPUTES; the executor
// owns every state transition. Three outcomes, the same three the capture routes have:
//   completed — every slot is terminal. The executor validates the envelope against the node's OWN
//               outputSchema and completes with ZERO usage recorded (R-20: a $0 event stays $0).
//   pending   — at least one job is still running. The executor RE-QUEUES the node; the long-run planes
//               (the Cloud Run conductor job's advance loop, the run-continuation tick) re-drive it
//               until every slot is terminal. Never a wait loop inside one 30s project-call window.
//   refused   — a typed refusal. A LIVE run BLOCKS (a model must never fabricate an artifact
//               reference — the placement_resolver precedent); a MOCK run falls through to
//               MockNodeRunner so CI graph traversal keeps working.
//
// PER SLOT, PER DISPATCH: adopt, then create, then poll — and never two jobs for one key.
//   1. ADOPT (get_agent_artifact_by_slot). A materialized artifact under this request+slot IS this
//      slot's canonical artifact. Record it, create nothing. This is what makes a RE-RUN free and is
//      the reason acceptance test (b) can assert zero creates on a second pass.
//   2. CREATE (create_agent_artifact_job), only when adoption found nothing AND no jobId is persisted.
//      The jobId is written into run state BEFORE anything polls it, so a crash, a stale-dispatch
//      reclaim or a retry finds the job rather than starting a second one. `idempotency_key` is
//      derived from (runId, requestId, slotId), so even a create whose response never arrived
//      re-attaches instead of duplicating.
//   3. POLL (get_agent_artifact_job_status), exactly once per dispatch per running slot.
// A slot's FIRST dispatch therefore costs at most two round trips (adopt, then create) and every later
// one costs exactly one (poll). Both are bounded work inside the call window, which is the property
// that matters; collapsing adopt+create into separate dispatches would only double the wall clock.
//
// WHY wait:false. The bridge's create defaults to `wait:true` — it blocks internally for "a few
// seconds" hoping the job finishes inline. For ONE slot that is a nice optimization. For four it makes
// a single dispatch's duration unbounded inside a 30s window, which is precisely the failure the
// re-queue idiom exists to avoid. We ask for the 202-shaped response and poll. (A response that
// carries terminal evidence anyway is still read — see readTerminal — because refusing free evidence
// would be silly.)
//
// WHICH REQUEST ID THE ARTIFACTS ARE WRITTEN UNDER. Not the planner's. The bridge's `request_id` names
// the content_item that OWNS the artifact, and on a request_id-dialect client (dr-lurie) that object id
// IS the run's own requestId — the id the content-item shell was created under one step earlier. The
// planner runs before the shell exists and before runContext holds any publish id, so anything it
// authors is a guess at the convention, and a guess that differs by one character names an object the
// client cannot list, reconcile or delete. So the shell's id WINS whenever a shell exists, the planner's
// is the fallback for a server-minted-id client that has no shell, and a disagreement is recorded as a
// run-visible warning rather than silently resolved. The emitted envelope then carries the id the
// artifacts actually live under, which is the id runContext lifts and the publisher patches.
//
// RETRYING. A retry of this node re-attempts every BLOCKED slot and nothing else: an in-flight job keeps
// its id and is polled, a materialized one keeps its evidence and is skipped. See the retry block in
// runArtifactMaterialization for why the absent envelope is the signal.
//
// WHAT IS A SLOT FAILURE AND WHAT IS A NODE FAILURE. A slot whose job terminally failed, or whose
// create was refused, is a BLOCKED SLOT carrying the bridge's own error verbatim (including
// `renderer_unavailable:*` and `RENDERER_MISMATCH` — a renderer problem is the operator's to read, not
// ours to paraphrase). One bad slot does not kill an article. A missing request id, a missing site id,
// an unusable spec, an unreachable project or an exhausted poll budget are NODE refusals: none of them
// can be true of one slot only, and none of them heals by continuing.
import type { WorkspaceNode } from "./nodeTypes.js";
import type { WorkflowExecutionRecord } from "./executionTypes.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { ProjectMcpAdapter, type CallToolResult } from "../projects/projectMcpAdapter.js";
import { describeMcpErrorResult } from "../projects/clientToolResult.js";
import { repositoryManager } from "../runtime/repositories.js";
import { stripCredentialShapedFields } from "../capture/captureEngine.js";
import { readContentItemShell } from "./contentItemShell.js";

export const ARTIFACT_MATERIALIZER_NODE_ID = "artifact_materializer";

// The cross-dispatch job bookkeeping key. Deliberately ":"-suffixed so it can never collide with a
// node id in run.stageOutputs — the same guard CAPTURE_CRAWL_JOB_STAGE_KEY uses.
export const ARTIFACT_MATERIALIZER_JOB_STAGE_KEY = "artifact_materializer:jobs";

export const MATERIALIZATION_SPEC_ARTIFACT = "materialization_spec.v1";
export const ARTIFACT_PLAN_ARTIFACT = "artifact_plan.v1";

export const ADOPT_TOOL = "get_agent_artifact_by_slot";
export const CREATE_TOOL = "create_agent_artifact_job";
export const STATUS_TOOL = "get_agent_artifact_job_status";

// ~40 dispatches is roughly ten minutes of the continuation tick's cadence — comfortably past the
// minute a FAL image takes and the few seconds a Chromium PDF takes, and short enough that a job the
// artifact plane has silently dropped surfaces as a retryable block rather than an immortal run.
export const DEFAULT_MAX_POLL_DISPATCHES = 40;

// pdf-tool's ArtifactJobStatus vocabulary, read case-insensitively, with the neighbouring spellings
// tolerated — the same reader the capture engine uses against the same job plane.
const TERMINAL_SUCCESS_STATUSES = new Set(["complete", "completed", "succeeded", "success"]);
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "cancelled", "canceled", "error"]);
// `blocked` is terminal for US but not for the plane: it means pdf-tool is holding the job for operator
// approval (resume_agent_artifact_job). We stop polling and report the slot blocked with the reason,
// rather than burning the poll budget waiting for a human who was never asked.
const APPROVAL_BLOCKED_STATUSES = new Set(["blocked", "awaiting_approval", "needs_approval"]);

// An adopt that comes back "there is nothing under this slot yet" is the NORMAL first-pass answer, not
// a failure. An adopt that comes back with anything else — a missing owning object, a scope mismatch,
// a bridge that is not configured — is ambiguous about whether a create would be safe, so it refuses.
const SLOT_EMPTY_PATTERNS = /(slot|artifact)[_ ]?not[_ ]?found|no[_ ]artifact|not[_ ]found|404|empty/i;
const REQUEST_MISSING_PATTERN = /artifact_request_not_found|request[_ ]?not[_ ]?found/i;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const trimmed = (value: unknown): string | undefined => (nonEmpty(value) ? value.trim() : undefined);
const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// The spec this node executes (artifact_plan's single turn produces it).

export type MaterializationSlotSpec = {
  slotId: string;
  purpose: string;
  desiredKind: "image" | "pdf";
  placement?: string;
  prompt?: string;
  styleRefs?: unknown;
  requirements?: Record<string, unknown>;
  templateId?: string;
  renderData?: Record<string, unknown>;
  assets?: Record<string, unknown>;
  filename?: string;
};

export type MaterializationSpec = {
  requestId: string;
  clientProjectId?: string;
  clientObjectType?: string;
  contractSource?: Record<string, unknown>;
  artifactProtocol?: string;
  requestIdConvention?: string;
  requestIdConfirmedByClient?: boolean;
  slots: MaterializationSlotSpec[];
  notes?: string[];
  blockers?: string[];
};

// ---------------------------------------------------------------------------------------------
// Cross-dispatch state.

export type SlotPhase = "adopted" | "materialized" | "running" | "blocked";

export type SlotJobState = {
  slotId: string;
  phase: SlotPhase;
  status: string;
  jobId?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  artifactReference?: Record<string, unknown>;
  publicPath?: string;
  verification?: Record<string, unknown>;
  error?: string;
};

export type MaterializerJobState = { dispatches: number; slots: Record<string, SlotJobState> };

const isTerminalPhase = (phase: SlotPhase): boolean => phase !== "running";

export type MaterializationOutcome =
  | { kind: "completed"; output: Record<string, unknown>; jobStateKey: string; jobState: MaterializerJobState; warnings: string[] }
  | { kind: "pending"; jobStateKey: string; jobState: MaterializerJobState; warnings: string[] }
  | { kind: "refused"; code: string; message: string };

const refused = (code: string, message: string): MaterializationOutcome => ({ kind: "refused", code, message });

export type MaterializerDeps = {
  projectRepository?: ProjectRepository;
  callTool?: (config: ProjectConnectionConfig, tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;
};

/** True when this node is the deterministic materializer. Opt-in per node, same as every sibling route. */
export const readArtifactMaterializer = (node: Pick<WorkspaceNode, "metadata">): boolean =>
  node.metadata?.artifactMaterializerDeterministic === true;

export const readMaxPollDispatches = (node: Pick<WorkspaceNode, "metadata">): number => {
  const declared = node.metadata?.maxPollDispatches;
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : DEFAULT_MAX_POLL_DISPATCHES;
};

// ---------------------------------------------------------------------------------------------
// Reading the spec off the run.

export const readMaterializationSpec = (run: Pick<WorkflowExecutionRecord, "stageOutputs">): MaterializationSpec | undefined => {
  const raw = run.stageOutputs?.artifact_plan;
  if (!isRecord(raw) || raw.artifact !== MATERIALIZATION_SPEC_ARTIFACT) return undefined;
  const requestId = trimmed(raw.requestId);
  if (!requestId) return undefined;
  const slots: MaterializationSlotSpec[] = [];
  for (const entry of Array.isArray(raw.slots) ? raw.slots : []) {
    if (!isRecord(entry)) continue;
    const slotId = trimmed(entry.slotId);
    const purpose = trimmed(entry.purpose);
    const desiredKind = entry.desiredKind === "pdf" ? "pdf" : entry.desiredKind === "image" ? "image" : undefined;
    if (!slotId || !purpose || !desiredKind) continue;
    slots.push({
      slotId,
      purpose,
      desiredKind,
      ...(trimmed(entry.placement) ? { placement: trimmed(entry.placement)! } : {}),
      ...(trimmed(entry.prompt) ? { prompt: trimmed(entry.prompt)! } : {}),
      ...(entry.styleRefs !== undefined ? { styleRefs: entry.styleRefs } : {}),
      ...(isRecord(entry.requirements) ? { requirements: entry.requirements } : {}),
      ...(trimmed(entry.templateId) ? { templateId: trimmed(entry.templateId)! } : {}),
      ...(isRecord(entry.renderData) ? { renderData: entry.renderData } : {}),
      ...(isRecord(entry.assets) ? { assets: entry.assets } : {}),
      ...(trimmed(entry.filename) ? { filename: trimmed(entry.filename)! } : {})
    });
  }
  return {
    requestId,
    ...(trimmed(raw.clientProjectId) ? { clientProjectId: trimmed(raw.clientProjectId)! } : {}),
    ...(trimmed(raw.clientObjectType) ? { clientObjectType: trimmed(raw.clientObjectType)! } : {}),
    ...(isRecord(raw.contractSource) ? { contractSource: raw.contractSource } : {}),
    ...(trimmed(raw.artifactProtocol) ? { artifactProtocol: trimmed(raw.artifactProtocol)! } : {}),
    ...(trimmed(raw.requestIdConvention) ? { requestIdConvention: trimmed(raw.requestIdConvention)! } : {}),
    ...(typeof raw.requestIdConfirmedByClient === "boolean" ? { requestIdConfirmedByClient: raw.requestIdConfirmedByClient } : {}),
    slots,
    ...(Array.isArray(raw.notes) ? { notes: raw.notes.filter(nonEmpty) } : {}),
    ...(Array.isArray(raw.blockers) ? { blockers: raw.blockers.filter(nonEmpty) } : {})
  };
};

/** Did artifact_plan SKIP (rather than fail, or never run)? A skipped node writes no stage output, so
 * this is the only way to tell "there was nothing to plan" from "the plan is missing". */
const plannerWasSkipped = (run: Pick<WorkflowExecutionRecord, "nodes">): boolean =>
  (run.nodes ?? []).some((state) => state.nodeId === "artifact_plan" && state.status === "skipped");

const readRunRequestId = (run: Pick<WorkflowExecutionRecord, "requestId" | "publishRequestId">): string | undefined =>
  trimmed((run as { publishRequestId?: unknown }).publishRequestId);

const readClientObjectType = (run: Pick<WorkflowExecutionRecord, "stageOutputs">): string | undefined => {
  const intelligence = run.stageOutputs?.contract_intelligence;
  return isRecord(intelligence) ? trimmed(intelligence.clientObjectType) : undefined;
};

export const readJobState = (run: Pick<WorkflowExecutionRecord, "stageOutputs">): MaterializerJobState => {
  const raw = run.stageOutputs?.[ARTIFACT_MATERIALIZER_JOB_STAGE_KEY];
  if (!isRecord(raw)) return { dispatches: 0, slots: {} };
  const slots: Record<string, SlotJobState> = {};
  const stored = isRecord(raw.slots) ? raw.slots : {};
  for (const [slotId, value] of Object.entries(stored)) {
    if (!isRecord(value)) continue;
    const phase = value.phase;
    slots[slotId] = {
      slotId,
      phase: phase === "adopted" || phase === "materialized" || phase === "blocked" ? phase : "running",
      status: typeof value.status === "string" ? value.status : "pending",
      ...(trimmed(value.jobId) ? { jobId: trimmed(value.jobId)! } : {}),
      attempts: typeof value.attempts === "number" ? value.attempts : 0,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
      ...(isRecord(value.artifactReference) ? { artifactReference: value.artifactReference } : {}),
      ...(trimmed(value.publicPath) ? { publicPath: trimmed(value.publicPath)! } : {}),
      ...(isRecord(value.verification) ? { verification: value.verification } : {}),
      ...(trimmed(value.error) ? { error: trimmed(value.error)! } : {})
    };
  }
  return { dispatches: typeof raw.dispatches === "number" ? raw.dispatches : 0, slots };
};

// ---------------------------------------------------------------------------------------------
// The bridge seam. One place calls the client, so one place strips credential-shaped fields off what
// comes back — a bridge response lands in run state and in a stage artifact, and a remote that echoed a
// grant can never make us persist it.

class MaterializationRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MaterializationRefusal";
  }
}

type BridgeCall = (tool: string, args: Record<string, unknown>) => Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; code: string; detail: string }>;

const unwrapPayload = (raw: unknown): Record<string, unknown> => {
  const structured = isRecord(raw) && isRecord(raw.structuredContent) ? (raw.structuredContent as Record<string, unknown>) : isRecord(raw) ? raw : {};
  const unwrapped = isRecord(structured.data) ? (structured.data as Record<string, unknown>) : structured;
  return stripCredentialShapedFields(unwrapped) as Record<string, unknown>;
};

const bridgeCallFor = (config: ProjectConnectionConfig, deps: MaterializerDeps): BridgeCall => {
  const call = deps.callTool ?? ((cfg: ProjectConnectionConfig, tool: string, args: Record<string, unknown>) => new ProjectMcpAdapter(cfg).callTool(tool, args));
  return async (tool, args) => {
    let result: CallToolResult;
    try {
      result = await call(config, tool, args);
    } catch (error) {
      return { ok: false, code: "bridge_threw", detail: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) return { ok: false, code: "bridge_call_failed", detail: result.error ?? "unknown error" };
    const raw = result.result;
    if (isRecord(raw) && raw.isError) return { ok: false, code: "bridge_error_result", detail: describeMcpErrorResult(raw) };
    return { ok: true, payload: unwrapPayload(raw) };
  };
};

// ---------------------------------------------------------------------------------------------
// Payload readers. Tolerant of the bridge's snake/camel spellings and of one level of `job` nesting,
// exactly as the capture engine's readers are against the same plane.

const jobRecord = (payload: Record<string, unknown>): Record<string, unknown> => (isRecord(payload.job) ? (payload.job as Record<string, unknown>) : payload);

const readJobId = (payload: Record<string, unknown>): string | undefined => {
  const job = jobRecord(payload);
  for (const key of ["jobId", "job_id", "id"]) {
    const value = job[key];
    if (nonEmpty(value)) return value.trim();
  }
  return undefined;
};

const readStatus = (payload: Record<string, unknown>): string => {
  const job = jobRecord(payload);
  const value = job.status;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
};

const readArtifactReference = (payload: Record<string, unknown>): Record<string, unknown> | undefined => {
  const job = jobRecord(payload);
  for (const scope of [job, payload]) {
    for (const key of ["artifactReference", "artifact_reference", "artifact", "reference"]) {
      const value = scope[key];
      if (isRecord(value) && (nonEmpty(value.blobKey) || nonEmpty(value.blob_key) || nonEmpty(value.key))) {
        const blobKey = trimmed(value.blobKey) ?? trimmed(value.blob_key) ?? trimmed(value.key)!;
        return { ...value, blobKey };
      }
    }
    const result = scope.result;
    if (isRecord(result)) {
      const nested = readArtifactReference(result);
      if (nested) return nested;
    }
  }
  return undefined;
};

const readPublicPath = (payload: Record<string, unknown>): string | undefined => {
  const job = jobRecord(payload);
  for (const scope of [job, payload, isRecord(job.result) ? (job.result as Record<string, unknown>) : {}]) {
    for (const key of ["publicPath", "public_path", "url"]) {
      const value = scope[key];
      if (nonEmpty(value)) return value.trim();
    }
  }
  return undefined;
};

const readErrorDetail = (payload: Record<string, unknown>): string | undefined => {
  const job = jobRecord(payload);
  for (const scope of [job, payload]) {
    for (const key of ["errorDetail", "error_detail", "error", "errorCode", "error_code", "message"]) {
      const value = scope[key];
      if (nonEmpty(value)) return value.trim();
    }
  }
  return undefined;
};

/** Terminal evidence carried inline (a create that completed within the bridge's own wait, a status
 * that succeeded). Both forms of the artifact must be present: a key with no public path is not a
 * materialization this run can bind, and a public path with no key is not one it can reconcile. */
const readTerminal = (payload: Record<string, unknown>): { artifactReference: Record<string, unknown>; publicPath: string } | undefined => {
  const artifactReference = readArtifactReference(payload);
  const publicPath = readPublicPath(payload);
  return artifactReference && publicPath ? { artifactReference, publicPath } : undefined;
};

const verificationOf = (source: "adopted" | "job", terminal: { artifactReference: Record<string, unknown>; publicPath: string }, jobId?: string): Record<string, unknown> => {
  const reference = terminal.artifactReference;
  return {
    source,
    verifiedAt: nowIso(),
    ...(jobId ? { jobId } : {}),
    ...(nonEmpty(reference.blobKey) ? { key: reference.blobKey } : {}),
    ...(nonEmpty(reference.sha256) ? { sha256: reference.sha256 } : {}),
    ...(nonEmpty(reference.contentType) ? { contentType: reference.contentType } : {}),
    ...(typeof reference.size === "number" ? { size: reference.size } : {}),
    publicPath: terminal.publicPath
  };
};

// ---------------------------------------------------------------------------------------------
// Job arguments.

const EXTENSION_BY_KIND: Record<"image" | "pdf", string> = { image: "webp", pdf: "pdf" };

const filenameFor = (slot: MaterializationSlotSpec): string => {
  if (slot.filename) return slot.filename;
  const stem = slot.slotId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "artifact";
  return stem.includes(".") ? stem : `${stem}.${EXTENSION_BY_KIND[slot.desiredKind]}`;
};

/** Stable across every dispatch and every retry of this node, so an ambiguous create (a 504 whose job
 * really was created) re-attaches to the original job instead of minting a second one. */
export const materializationIdempotencyKey = (runId: string, requestId: string, slotId: string): string => `artifact:${runId}:${requestId}:${slotId}`;

const createArgsFor = (params: { runId: string; siteId: string; requestId: string; slot: MaterializationSlotSpec }): Record<string, unknown> | { refusal: string } => {
  const { slot } = params;
  const base: Record<string, unknown> = {
    site_id: params.siteId,
    request_id: params.requestId,
    artifact_kind: slot.desiredKind,
    filename: filenameFor(slot),
    slot: slot.slotId,
    // See the header: the bridge's inline wait makes a multi-slot dispatch unbounded. We poll.
    wait: false,
    idempotency_key: materializationIdempotencyKey(params.runId, params.requestId, slot.slotId),
    ...(slot.requirements ? { requirements: slot.requirements } : {})
  };
  if (slot.desiredKind === "pdf") {
    // W9: a PDF slot renders a PUBLISHED template. This node never authors one, never falls back to an
    // image, and never invents renderData — artifact_plan's turn resolved both against the site's
    // declared renderDataSchema, or it marked the slot blocked and we never got here.
    if (!slot.templateId) return { refusal: "no_pdf_template" };
    if (!slot.renderData) return { refusal: "no_render_data" };
    return { ...base, template_id: slot.templateId, data: slot.renderData, ...(slot.assets ? { assets: slot.assets } : {}) };
  }
  if (!slot.prompt) return { refusal: "no_image_prompt" };
  // The prompt is the SUBJECT ONLY. Platform prepends the site's brandImagery styleSentence, merges its
  // negatives and derives its seed server-side; anything we sent for those would be silently overridden,
  // so we do not send them at all.
  return { ...base, operation: "generate", prompt: slot.prompt };
};

// ---------------------------------------------------------------------------------------------
// The envelope. `artifact_plan.v1`, unchanged — this is the whole point of the split.

const statusForPhase = (phase: SlotPhase): "has_trusted_artifact" | "blocked" | "needs_generation" =>
  phase === "adopted" || phase === "materialized" ? "has_trusted_artifact" : phase === "blocked" ? "blocked" : "needs_generation";

export const buildArtifactPlanEnvelope = (params: { spec: MaterializationSpec; jobState: MaterializerJobState; clientProjectId: string; clientObjectType: string }): Record<string, unknown> => {
  const { spec, jobState } = params;
  const mediaSlots: Record<string, unknown>[] = [];
  const artifactReferences: Record<string, unknown>[] = [];
  const blockers: string[] = [...(spec.blockers ?? [])];
  let verified = 0;

  for (const slot of spec.slots) {
    const state = jobState.slots[slot.slotId];
    const phase: SlotPhase = state?.phase ?? "running";
    const status = statusForPhase(phase);
    if (status === "has_trusted_artifact") verified += 1;
    mediaSlots.push({
      slotId: slot.slotId,
      purpose: slot.purpose,
      status,
      nodeId: ARTIFACT_MATERIALIZER_NODE_ID,
      desiredKind: slot.desiredKind,
      ...(slot.placement ? { placement: slot.placement } : {}),
      ...(state?.artifactReference ? { artifactReference: state.artifactReference } : {}),
      ...(state?.publicPath ? { publicPath: state.publicPath } : {}),
      ...(state?.verification ? { verification: state.verification } : {}),
      ...(status === "blocked" ? { blocker: state?.error ?? "materialization_failed" } : {})
    });
    if (status === "has_trusted_artifact" && state?.artifactReference && state.publicPath) {
      artifactReferences.push({
        slotId: slot.slotId,
        verified: true,
        publicPath: state.publicPath,
        artifactReference: state.artifactReference,
        ...(state.verification ? { verification: state.verification } : {})
      });
    }
    if (status === "blocked") blockers.push(`${slot.slotId}: ${state?.error ?? "materialization_failed"}`);
  }

  const envelope: Record<string, unknown> = {
    artifact: ARTIFACT_PLAN_ARTIFACT,
    summary:
      spec.slots.length === 0
        ? `No media slots were requested${spec.requestId ? ` for ${spec.requestId}` : ""}; nothing was generated.`
        : `${verified} of ${spec.slots.length} slot(s) materialized and verified for ${spec.requestId} across ${jobState.dispatches} deterministic dispatch(es), with no model turn.`,
    clientProjectId: params.clientProjectId,
    clientObjectType: params.clientObjectType,
    ...(spec.requestId ? { requestId: spec.requestId } : {}),
    media_slots: mediaSlots,
    artifactReferences,
    requiredArtifactCapabilities: [],
    blockers,
    notes: [
      ...(spec.notes ?? []),
      "Materialized deterministically by artifact_materializer (no model turn); every reference here is either an adoption response or a terminal-success job status."
    ]
  };
  // The node's own schema requires artifactProtocol whenever media_slots is non-empty, and forbids
  // inventing one when it is empty. Both halves are the planner's declaration, carried through.
  if (spec.artifactProtocol) envelope.artifactProtocol = spec.artifactProtocol;
  if (spec.contractSource) envelope.contractSource = spec.contractSource;
  if (spec.requestIdConvention) envelope.requestIdConvention = spec.requestIdConvention;
  if (spec.requestIdConfirmedByClient !== undefined) envelope.requestIdConfirmedByClient = spec.requestIdConfirmedByClient;
  return envelope;
};

// ---------------------------------------------------------------------------------------------
// The dispatch.

export async function runArtifactMaterialization(
  input: { run: WorkflowExecutionRecord; node: WorkspaceNode },
  deps: MaterializerDeps = {}
): Promise<MaterializationOutcome> {
  const { run, node } = input;
  const warnings: string[] = [];

  const spec = readMaterializationSpec(run);
  if (!spec) {
    // THE ZERO-MEDIA FLOOR. A SKIPPED artifact_plan wrote no stage output by construction ("a skipped
    // node asserted nothing"), and that absence is not a missing spec — it is the run saying there was
    // never any media to plan. Refusing here would block every text-only article at a node whose entire
    // job is media. The node's own no_media_slots predicate normally skips it alongside the planner;
    // this is the second lock, for the run whose media declaration the predicate could not see.
    if (plannerWasSkipped(run)) {
      return {
        kind: "completed",
        output: buildArtifactPlanEnvelope({
          spec: { requestId: readRunRequestId(run) ?? "", slots: [], notes: ["artifact_plan was skipped for this run (no media slots declared), so there was nothing to materialize."] },
          jobState: { dispatches: 0, slots: {} },
          clientProjectId: run.projectId,
          clientObjectType: readClientObjectType(run) ?? "content_item"
        }),
        jobStateKey: ARTIFACT_MATERIALIZER_JOB_STAGE_KEY,
        jobState: { dispatches: 0, slots: {} },
        warnings: ["artifact_materialization_skipped:planner_skipped"]
      };
    }
    return refused(
      "materialization_spec_missing",
      `artifact_materializer found no usable ${MATERIALIZATION_SPEC_ARTIFACT} under stageOutputs.artifact_plan (an envelope with a non-empty requestId), and artifact_plan did not skip. It executes a plan; it never authors one.`
    );
  }

  const projects = deps.projectRepository ?? repositoryManager.getProjectRepository();
  const config = await projects.get(run.projectId);
  if (!config) return refused("unknown_project", `Unknown projectId: ${run.projectId}. The artifact bridge is reached through the run's registered client, never guessed.`);
  if (config.status === "disabled") return refused("project_disabled", `Project ${run.projectId} is disabled; no artifact may be materialized against it.`);

  const siteId = trimmed(config.objectDialect?.siteObjectId);
  if (!siteId) {
    return refused(
      "artifact_site_scope_missing",
      `Project ${run.projectId} declares no objectDialect.siteObjectId, and every artifact bridge verb is site-scoped. Register the site id rather than letting the bridge guess which tenant owns the artifact.`
    );
  }

  // The owning object's id beats the planner's guess — see the header. readContentItemShell reads this
  // node's own dispatch input, where the executor recorded the shell it created immediately before.
  const shell = readContentItemShell(run);
  const requestId = shell?.requestId ?? spec.requestId;
  if (shell && shell.requestId !== spec.requestId) {
    warnings.push(`artifact_request_id_from_shell:${shell.requestId}`);
  }
  const effective: MaterializationSpec = { ...spec, requestId };

  const jobState = readJobState(run);

  // A RETRY MUST RECONSIDER A BLOCKED SLOT — found live, run_1788189874186_5973sq (2026-08-31).
  //
  // retryNode clears `stageOutputs[<nodeId>]` but NOT `stageOutputs["<nodeId>:jobs"]`, and it cannot:
  // that key is deliberately separate so an IN-FLIGHT job survives a retry and gets polled instead of
  // re-created (the same reason capture_crawl keeps its own). The cost was that a slot this node had
  // already marked `blocked` stayed blocked forever: the next dispatch read it back as terminal, skipped
  // it, and completed instantly with the identical failure — so an operator who FIXED the cause (a
  // mis-shaped requirements object, a renderer brought back up) retried and got the old error verbatim,
  // which reads as "the fix did nothing".
  //
  // The absent envelope beside a present job state is exactly the retry signal, and it is the only state
  // retryNode can produce. Blocked slots are dropped so they re-adopt and re-create; `running` slots keep
  // their jobId (polled, never duplicated) and `adopted`/`materialized` slots keep their evidence (skipped
  // as terminal, still zero creates). So a retry costs a re-attempt of exactly what failed, and nothing
  // that succeeded is bought twice.
  if (run.stageOutputs?.[ARTIFACT_MATERIALIZER_NODE_ID] === undefined) {
    for (const [slotId, slotState] of Object.entries(jobState.slots)) {
      if (slotState.phase !== "blocked") continue;
      delete jobState.slots[slotId];
      warnings.push(`artifact_slot_retried:${slotId}`);
    }
  }

  jobState.dispatches += 1;
  const maxDispatches = readMaxPollDispatches(node);

  // Zero slots: the planner said there is nothing to make. Emit the empty plan and complete — no bridge
  // call at all. (The skip predicate normally catches this before dispatch; this is the honest floor
  // for a run whose brief declared slots and whose planner resolved none of them.)
  if (effective.slots.length === 0) {
    return {
      kind: "completed",
      output: buildArtifactPlanEnvelope({ spec: effective, jobState, clientProjectId: effective.clientProjectId ?? run.projectId, clientObjectType: effective.clientObjectType ?? "content_item" }),
      jobStateKey: ARTIFACT_MATERIALIZER_JOB_STAGE_KEY,
      jobState,
      warnings
    };
  }

  const bridge = bridgeCallFor(config, deps);

  for (const slot of effective.slots) {
    const existing = jobState.slots[slot.slotId];
    if (existing && isTerminalPhase(existing.phase)) continue;
    try {
      jobState.slots[slot.slotId] = await advanceSlot({ runId: run.runId, siteId, requestId, slot, state: existing, bridge });
    } catch (error) {
      if (error instanceof MaterializationRefusal) return refused(error.code, error.message);
      throw error;
    }
  }

  const stillRunning = effective.slots.filter((slot) => !isTerminalPhase(jobState.slots[slot.slotId]?.phase ?? "running"));

  if (stillRunning.length === 0) {
    return {
      kind: "completed",
      output: buildArtifactPlanEnvelope({ spec: effective, jobState, clientProjectId: effective.clientProjectId ?? run.projectId, clientObjectType: effective.clientObjectType ?? "content_item" }),
      jobStateKey: ARTIFACT_MATERIALIZER_JOB_STAGE_KEY,
      jobState,
      warnings
    };
  }

  if (jobState.dispatches >= maxDispatches) {
    // Retryable by construction: every jobId is persisted, so a retry adopts whatever finished in the
    // meantime rather than re-creating anything.
    return refused(
      "artifact_materialization_poll_budget_exhausted",
      `${stillRunning.length} slot(s) (${stillRunning.map((slot) => slot.slotId).join(", ")}) were still running after ${jobState.dispatches} dispatches (limit ${maxDispatches}). Every job id is persisted, so retrying this node adopts any that have since finished; it never creates a second job.`
    );
  }

  warnings.push(`artifact_materialization_pending:${stillRunning.map((slot) => slot.slotId).join(",")}`);
  return { kind: "pending", jobStateKey: ARTIFACT_MATERIALIZER_JOB_STAGE_KEY, jobState, warnings };
}

async function advanceSlot(params: {
  runId: string;
  siteId: string;
  requestId: string;
  slot: MaterializationSlotSpec;
  state: SlotJobState | undefined;
  bridge: BridgeCall;
}): Promise<SlotJobState> {
  const { runId, siteId, requestId, slot, bridge } = params;
  const at = nowIso();
  const base: SlotJobState = params.state ?? { slotId: slot.slotId, phase: "running", status: "pending", attempts: 0, createdAt: at, updatedAt: at };

  // --- 3. POLL. A slot that already has a job is never re-created, whatever the poll says.
  if (base.jobId) {
    const polled = await bridge(STATUS_TOOL, { site_id: siteId, request_id: requestId, job_id: base.jobId });
    if (!polled.ok) {
      // A transport-level poll failure says nothing about the job. Leave it running; the next dispatch
      // asks again. (The dispatch budget is what stops this being forever.)
      return { ...base, attempts: base.attempts + 1, updatedAt: at, status: base.status, error: `${polled.code}:${polled.detail}`.slice(0, 300) };
    }
    const status = readStatus(polled.payload) || "pending";
    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      return { ...base, phase: "blocked", status, attempts: base.attempts + 1, updatedAt: at, error: readErrorDetail(polled.payload) ?? `job ${base.jobId} reached terminal status "${status}"` };
    }
    if (APPROVAL_BLOCKED_STATUSES.has(status)) {
      return { ...base, phase: "blocked", status, attempts: base.attempts + 1, updatedAt: at, error: readErrorDetail(polled.payload) ?? `job ${base.jobId} is held for operator approval (resume_agent_artifact_job); this node never approves on an operator's behalf` };
    }
    if (TERMINAL_SUCCESS_STATUSES.has(status)) {
      const terminal = readTerminal(polled.payload);
      if (!terminal) {
        return { ...base, phase: "blocked", status, attempts: base.attempts + 1, updatedAt: at, error: `job ${base.jobId} reported "${status}" but carried no artifact reference and public path; a success without both forms is not evidence this run can bind` };
      }
      return { ...base, phase: "materialized", status, attempts: base.attempts + 1, updatedAt: at, artifactReference: terminal.artifactReference, publicPath: terminal.publicPath, verification: verificationOf("job", terminal, base.jobId) };
    }
    return { ...base, status, attempts: base.attempts + 1, updatedAt: at };
  }

  // --- 1. ADOPT. Free, and the reason a re-run creates nothing.
  const adopted = await bridge(ADOPT_TOOL, { site_id: siteId, request_id: requestId, slot: slot.slotId });
  if (adopted.ok) {
    const terminal = readTerminal(adopted.payload);
    if (terminal) {
      return { ...base, phase: "adopted", status: "complete", updatedAt: at, artifactReference: terminal.artifactReference, publicPath: terminal.publicPath, verification: verificationOf("adopted", terminal) };
    }
    // A clean response with no artifact is the normal first-pass answer: nothing here yet, go create.
  } else if (REQUEST_MISSING_PATTERN.test(adopted.detail)) {
    // The owning content_item does not exist. Creating under it would produce an artifact the client can
    // never list, reconcile or delete — the exact failure the content-item shell exists to prevent — so
    // this is a NODE refusal, not a slot the run limps past.
    throw new MaterializationRefusal(
      "artifact_owning_object_missing",
      `The artifact bridge reports no content_item under request id ${requestId} (${adopted.detail}). Media is indexed against the owning object; the content-item shell must exist before anything is generated.`
    );
  } else if (!SLOT_EMPTY_PATTERNS.test(adopted.detail)) {
    // Ambiguous: we do not know whether an artifact exists, so we do not create one that might be a
    // duplicate.
    throw new MaterializationRefusal(
      "artifact_adoption_failed",
      `${ADOPT_TOOL} for slot ${slot.slotId} under ${requestId} failed with ${adopted.code}: ${adopted.detail}. A slot whose current state cannot be read is never given a job — a duplicate leaves an orphaned artifact on the client.`
    );
  }

  // --- 2. CREATE. Only ever reached with adoption having positively found nothing.
  const args = createArgsFor({ runId, siteId, requestId, slot });
  if ("refusal" in args) {
    return { ...base, phase: "blocked", status: "refused", updatedAt: at, error: `${args.refusal}: the plan's slot "${slot.slotId}" (${slot.desiredKind}) is missing what its kind requires; this node never authors a prompt, a template or renderData` };
  }
  const created = await bridge(CREATE_TOOL, args);
  if (!created.ok) {
    return { ...base, phase: "blocked", status: "create_failed", updatedAt: at, error: `${created.code}:${created.detail}`.slice(0, 500) };
  }
  const jobId = readJobId(created.payload);
  const terminal = readTerminal(created.payload);
  if (terminal) {
    // The bridge finished it inline anyway. Free evidence is still evidence.
    return { ...base, phase: "materialized", status: readStatus(created.payload) || "complete", updatedAt: at, ...(jobId ? { jobId } : {}), artifactReference: terminal.artifactReference, publicPath: terminal.publicPath, verification: verificationOf("job", terminal, jobId) };
  }
  if (!jobId) {
    return { ...base, phase: "blocked", status: "create_incomplete", updatedAt: at, error: `${CREATE_TOOL} for slot ${slot.slotId} returned neither a job id nor a terminal artifact; a job that cannot be named cannot be polled, and re-creating it would duplicate` };
  }
  // The jobId is returned so the EXECUTOR persists it before anything polls it.
  return { ...base, phase: "running", status: readStatus(created.payload) || "pending", jobId, attempts: 0, updatedAt: at };
}
