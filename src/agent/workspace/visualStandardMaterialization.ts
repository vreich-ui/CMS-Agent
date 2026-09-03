// C5 (BRIEF §3.5) — `visual_standard_materializer`: THE DETERMINISTIC HALF OF THE WRITER PAIR.
//
// WHAT THIS IS. `brand_imagery_writer` spends one vision model turn and writes NOTHING; it emits a
// `brand_imagery_proposal.v1`. This module is what turns that proposal into a governed object and,
// only when it is both asked and allowed, onto the live site. It costs $0 and calls no model — the
// same R-C3 v2 contract capture's/clone's stages and `artifact_materializer` already use: build in
// code, validate against the node's OWN outputSchema, complete with zero usage recorded.
//
// WHY THE SPLIT EXISTS AT ALL (R3). A model that both judges a mood board and writes to a live site
// is a model whose judgment and whose authority cannot be reviewed separately. So the judgment is one
// stateless turn with `allowedTools: []`, and every write here is engine code a reader can enumerate:
// ONE object_create-or-patch of `vis_<site>` / `vis_<site>_<slug>`, and — behind two independent
// gates — one `site_apply_brand_imagery` dry-run followed by one apply.
//
// THE TWO GATES ON THE APPLY, and why both are needed rather than either alone:
//   1. `apply` must be requested on the run's own input. Creating a standard is the normal case;
//      putting it on the live site is a separate, deliberate act. Default is false.
//   2. `effectiveToolPermission(config, 'site_apply_brand_imagery')` must be exactly "allowed" (BRIEF
//      §3.5). "needs_approval" is NOT allowed here: this node has no model turn in which to ask, and
//      an approval-gated verb driven by deterministic code would be an approval nobody granted. Same
//      posture, same reason, as cloneEngine's `site_apply_theme` gate.
// A refused apply is NEVER an error. The standard still exists, `applied:false` carries the reason by
// name, and an operator (or a later run) can apply it once the policy says so. That is the whole
// point of R6's "owner-only, autonomyFloor: ask": the proposal survives the refusal.
//
// WHAT IS A REFUSAL AND WHAT IS A REPORTED NON-EVENT. A missing proposal, an unresolvable project, a
// site with no object id, a `mode:'template'` with no slug, a blocked-by-policy write, a create/patch
// the client rejected — all NODE REFUSALS: none of them heals by continuing and none leaves a usable
// standard behind. A refused APPLY is the opposite: the object write already succeeded, so the node
// completes and says so. Nothing here ever fabricates an id, a body, or an apply that did not happen.
//
// WHAT THIS NEVER DOES. It never publishes: `visual_standard` is NOT a publishable type (BRIEF rule
// 4) and nothing here calls object_publish or release_to_production. It never writes
// `site.brandImagery` by any path other than the one sanctioned verb — `set_site_brand_imagery` is
// privileged and unreachable from object_patch by construction (platform's own object_patch refuses
// it), which is exactly why the apply is a tool call and not an op this module could hand-author.
import { createHash } from "node:crypto";
import type { WorkspaceNode } from "./nodeTypes.js";
import type { WorkflowExecutionRecord } from "./executionTypes.js";
import { effectiveToolPermission, type ProjectConnectionConfig, type ToolPermission } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { ProjectMcpAdapter, type CallToolResult } from "../projects/projectMcpAdapter.js";
import { describeMcpErrorResult } from "../projects/clientToolResult.js";
import { getProjectHooks } from "../projects/projectHooks.js";
import { repositoryManager } from "../runtime/repositories.js";
import { visualStandardIdFor } from "./visualStandardIds.js";

export const BRAND_IMAGERY_WRITER_NODE_ID = "brand_imagery_writer";
export const VISUAL_STANDARD_MATERIALIZER_NODE_ID = "visual_standard_materializer";

export const BRAND_IMAGERY_PROPOSAL_ARTIFACT = "brand_imagery_proposal.v1";
export const VISUAL_STANDARD_RESULT_ARTIFACT = "visual_standard_result.v1";

export const VISUAL_STANDARD_OBJECT_TYPE = "visual_standard";
export const SITE_OBJECT_TYPE = "site";
export const APPLY_BRAND_IMAGERY_TOOL = "site_apply_brand_imagery";
export const SET_VISUAL_STANDARD_FIELDS_OP = "set_visual_standard_fields";

// The mood board's declared cap (BRIEF §3.1: `references`, max 24). Enforced here as well as by the
// platform's own schema so an over-long board is trimmed with a named warning rather than bounced by
// a 422 the operator has to go and read.
export const MAX_REFERENCES = 24;

// Same reason contractPrefetch/sitePrefetch/artifactMaterialization each carry one: these calls
// bypass executeTool entirely (deterministic conductor code, not a model-invoked tool) and inherit no
// timeout of their own.
const VISUAL_STANDARD_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value);
const trimmed = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length ? value.trim() : undefined);

/** True when this node is the deterministic visual-standard materializer. Opt-in per node, same as every sibling route. */
export const readVisualStandardMaterializer = (node: Pick<WorkspaceNode, "metadata">): boolean =>
  node.metadata?.visualStandardMaterializerDeterministic === true;

// ---------------------------------------------------------------------------------------------
// Ids (R2). `vis_<site>` for the house singleton — the `voice_<site>` / `trk_<site>` convention — and
// `vis_<site>_<slug>` for a template. `<site>` is the SITE SLUG, i.e. the project's declared
// `objectDialect.siteObjectId` with its `site_` prefix removed, so a project whose site object is
// `site_drlurie` gets `vis_drlurie` next to its own `voice_drlurie`. Derived, never guessed from the
// projectId: the two differ (project "dr-lurie", site "site_drlurie") and the object namespace is the
// site's.
//
// FIX (chat-recovery): the rule itself MOVED to `visualStandardIds.ts` and is only re-exported here.
// This module is the WRITE path — it imports the project repository, the MCP adapter and the tool
// permission machinery — so the READ path (sitePrefetch.ts, which has to tell a node the id a house
// standard occupies or would occupy) could not import it without dragging all of that along, and
// therefore did not derive the id at all. An id nobody derives is an id something eventually guesses;
// see visualStandardIds.ts's header for the guess this split exists to prevent. The re-exports keep
// every existing importer of this module working unchanged.
export { siteSlugFromObjectId, visualStandardIdFor } from "./visualStandardIds.js";

// A reference id is STABLE PER IMAGE, never positional: BRIEF §3.1's own note is that "a reordered
// mood board must not silently repoint an existing note/weight/region onto a different image". So it
// is derived from the blobKey alone (sha256, first 8 hex — platform's `^ref_[a-z0-9]+$`), which also
// makes a re-run of this node produce a byte-identical body for the same board. A caller-supplied id
// that already matches the platform's shape is kept as-is.
export const referenceIdFor = (blobKey: string): string => `ref_${createHash("sha256").update(blobKey).digest("hex").slice(0, 8)}`;

// ---------------------------------------------------------------------------------------------
// Reading the proposal off the run.

export type BrandImageryProposal = {
  mode: "house" | "template";
  brandImagery: JsonRecord;
  label: string;
  rationale?: string;
  sampleSubjects: string[];
  confidence?: string;
  whenToUse?: string;
  description?: string;
  templateSlug?: string;
};

const stringList = (value: unknown, max: number): string[] =>
  (Array.isArray(value) ? value : []).map(trimmed).filter((entry): entry is string => !!entry).slice(0, max);

/**
 * The writer's own envelope, read off the run's stage outputs — the same place every deterministic
 * route reads its upstream from. Returns undefined (never a partial) when the envelope is absent or
 * is not a `brand_imagery_proposal.v1` carrying the three fields a standard cannot be built without.
 */
export const readBrandImageryProposal = (run: Pick<WorkflowExecutionRecord, "stageOutputs">): BrandImageryProposal | undefined => {
  const raw = run.stageOutputs?.[BRAND_IMAGERY_WRITER_NODE_ID];
  if (!isRecord(raw) || raw.artifact !== BRAND_IMAGERY_PROPOSAL_ARTIFACT) return undefined;
  const mode = raw.mode === "house" || raw.mode === "template" ? raw.mode : undefined;
  const brandImagery = isRecord(raw.brandImagery) ? raw.brandImagery : undefined;
  const label = trimmed(raw.label);
  if (!mode || !brandImagery || !label) return undefined;
  return {
    mode,
    brandImagery,
    label,
    sampleSubjects: stringList(raw.sampleSubjects, 6),
    ...(trimmed(raw.rationale) ? { rationale: trimmed(raw.rationale)! } : {}),
    ...(trimmed(raw.confidence) ? { confidence: trimmed(raw.confidence)! } : {}),
    ...(trimmed(raw.whenToUse) ? { whenToUse: trimmed(raw.whenToUse)! } : {}),
    ...(trimmed(raw.description) ? { description: trimmed(raw.description)! } : {}),
    ...(trimmed(raw.templateSlug) ? { templateSlug: trimmed(raw.templateSlug)! } : {})
  };
};

// ---------------------------------------------------------------------------------------------
// Reading the materializer's own half of the input: `{ apply?, references[], templateSlug? }`.
//
// It lives on the RUN's initialInput, not on the proposal, deliberately: the mood board and the
// decision to go live are the CALLER's, and a model turn must never be able to escalate its own
// output into a site write by emitting `apply: true`. The writer's envelope is read for content; the
// authority to apply is read only from the run.

export type VisualStandardReference = { id: string; blobKey: string; region?: JsonRecord; note?: string; weight?: number };
export type VisualStandardRequest = {
  apply: boolean;
  references: VisualStandardReference[];
  templateSlug?: string;
  droppedReferences: number;
  // REVIEW: the mode the RUN asked for, when it declared one. `apply` was correctly read from the
  // run and never from the model — but `mode` was read only off the writer's OUTPUT, and mode is
  // what selects the write TARGET: 'house' writes (and can apply) the site's singleton `vis_<site>`,
  // 'template' writes `vis_<site>_<slug>`. A writer that emitted `mode:'house'` on a run that asked
  // for a template therefore redirected the write onto the house standard, and with `apply:true`
  // under an "allowed" policy carried it onto the live site — a target the run never named. The
  // authority to apply came from the run; the authority to say WHAT IS APPLIED must too.
  declaredMode?: "house" | "template";
};

const readReference = (entry: unknown): VisualStandardReference | undefined => {
  if (!isRecord(entry)) return undefined;
  const blobKey = trimmed(entry.blobKey) ?? trimmed(entry.blob_key);
  if (!blobKey) return undefined;
  const suppliedId = trimmed(entry.id);
  const note = trimmed(entry.note);
  const weight = typeof entry.weight === "number" && Number.isFinite(entry.weight) ? Math.min(1, Math.max(0, entry.weight)) : undefined;
  const rawRegion = isRecord(entry.region) ? entry.region : undefined;
  const region = rawRegion && ["x", "y", "w", "h"].every((key) => typeof rawRegion[key] === "number") ? rawRegion : undefined;
  return {
    id: suppliedId && /^ref_[a-z0-9]+$/.test(suppliedId) ? suppliedId : referenceIdFor(blobKey),
    blobKey,
    ...(region ? { region } : {}),
    ...(note ? { note: note.slice(0, 200) } : {}),
    ...(weight !== undefined ? { weight } : {})
  };
};

export const readVisualStandardRequest = (run: Pick<WorkflowExecutionRecord, "initialInput">): VisualStandardRequest => {
  const input = isRecord(run.initialInput) ? run.initialInput : {};
  const rawReferences = Array.isArray(input.references) ? input.references : [];
  const read = rawReferences.map(readReference).filter((entry): entry is VisualStandardReference => !!entry);
  // De-duplicated by id (the same image twice is one board entry, not two) and then capped.
  const byId = new Map(read.map((entry) => [entry.id, entry]));
  const references = [...byId.values()].slice(0, MAX_REFERENCES);
  return {
    apply: input.apply === true,
    references,
    droppedReferences: read.length - references.length,
    ...(trimmed(input.templateSlug) ? { templateSlug: trimmed(input.templateSlug)! } : {}),
    ...(input.mode === "house" || input.mode === "template" ? { declaredMode: input.mode } : {})
  };
};

// ---------------------------------------------------------------------------------------------
// The body (BRIEF §3.1). Built here, in full, every time — `set_visual_standard_fields` is an open
// deep-merge op, so sending the whole body on a patch is what makes a re-run CONVERGENT rather than
// additive. `derivedFrom.method` is always 'writer' on this path, by definition: nothing else reaches
// this module.

export type VisualStandardBody = {
  version: 1;
  kind: "house" | "template";
  label: string;
  description?: string;
  whenToUse?: string;
  brandImagery: JsonRecord;
  references: VisualStandardReference[];
  sampleSubjects: string[];
  derivedFrom: { method: "writer"; visualStandardId?: string; themeId?: string };
  status: "draft" | "active" | "archived";
};

export function buildVisualStandardBody(params: {
  proposal: BrandImageryProposal;
  references: VisualStandardReference[];
  status: "draft" | "active";
  derivedFromVisualStandardId?: string;
}): VisualStandardBody {
  const { proposal } = params;
  return {
    version: 1,
    kind: proposal.mode,
    label: proposal.label.slice(0, 80),
    ...(proposal.description ? { description: proposal.description.slice(0, 400) } : {}),
    ...(proposal.whenToUse ? { whenToUse: proposal.whenToUse.slice(0, 400) } : {}),
    brandImagery: proposal.brandImagery,
    references: params.references,
    sampleSubjects: proposal.sampleSubjects.map((subject) => subject.slice(0, 300)),
    derivedFrom: { method: "writer", ...(params.derivedFromVisualStandardId ? { visualStandardId: params.derivedFromVisualStandardId } : {}) },
    status: params.status
  };
}

// ---------------------------------------------------------------------------------------------
// Transport. Same shape as artifactMaterialization's bridge: the project's executable policy hook
// runs BEFORE any transport (a blocked call must never reach the client at all), and a client-side
// `isError` result is a failure even though the transport said ok.

export type VisualStandardDeps = {
  projectRepository?: ProjectRepository;
  callTool?: (config: ProjectConnectionConfig, tool: string, args: JsonRecord) => Promise<CallToolResult>;
};

type ClientCall = (tool: string, args: JsonRecord) => Promise<{ ok: true; payload: JsonRecord } | { ok: false; code: string; detail: string }>;

const blockingPolicyCodes = (projectId: string, tool: string, args: JsonRecord): string[] =>
  (getProjectHooks(projectId)?.enforceCallToolPolicy?.({ tool, arguments: args }) ?? [])
    .filter((finding) => finding.severity === "error")
    .map((finding) => finding.code);

const unwrapPayload = (raw: unknown): JsonRecord => {
  if (!isRecord(raw)) return {};
  const structured = isRecord(raw.structuredContent) ? (raw.structuredContent as JsonRecord) : raw;
  if (isRecord(structured.record)) return structured.record as JsonRecord;
  if (isRecord(structured.data)) return structured.data as JsonRecord;
  return structured;
};

const clientCallFor = (config: ProjectConnectionConfig, deps: VisualStandardDeps): ClientCall => {
  const call = deps.callTool ?? ((cfg: ProjectConnectionConfig, tool: string, args: JsonRecord) => {
    const adapter = new ProjectMcpAdapter(cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VISUAL_STANDARD_TIMEOUT_MS);
    return adapter.callTool(tool, args, controller.signal).finally(() => clearTimeout(timer));
  });
  return async (tool, args) => {
    const blocked = blockingPolicyCodes(config.projectId, tool, args);
    if (blocked.length) return { ok: false, code: "tool_policy_blocked", detail: `${tool} is blocked by ${config.projectId}'s executable project policy: ${blocked.join(", ")}` };
    let result: CallToolResult;
    try { result = await call(config, tool, args); } catch (error) { return { ok: false, code: "client_threw", detail: error instanceof Error ? error.message : String(error) }; }
    if (!result.ok) return { ok: false, code: "client_call_failed", detail: result.error ?? "unknown error" };
    if (isRecord(result.result) && result.result.isError) return { ok: false, code: "client_error_result", detail: describeMcpErrorResult(result.result) };
    return { ok: true, payload: unwrapPayload(result.result) };
  };
};

// object_get answers "there is no such object" in two different registers depending on the substrate:
// a refusal, or a success carrying not_found. Both mean the same thing here, and neither is an error
// worth refusing over — it is simply the create path.
const NOT_FOUND = /not[_ ]?found|does not exist|no such object|404/i;

const readLock = (payload: JsonRecord): { lockToken?: string; recordVersion?: unknown } => {
  const nested = isRecord(payload.lock) ? (payload.lock as JsonRecord) : payload;
  const lockToken = trimmed(nested.lockToken) ?? trimmed(nested.lock_token);
  const recordVersion = nested.recordVersion ?? nested.record_version ?? nested.expected_record_version;
  return { ...(lockToken ? { lockToken } : {}), ...(recordVersion !== undefined ? { recordVersion } : {}) };
};

const readChangedFields = (payload: JsonRecord): string[] => {
  const raw = payload.changedFields ?? payload.changed_fields ?? (isRecord(payload.dryRun) ? (payload.dryRun as JsonRecord).changedFields : undefined);
  return Array.isArray(raw) ? raw.map(trimmed).filter((entry): entry is string => !!entry) : [];
};

// ---------------------------------------------------------------------------------------------
// The outcome.

export type VisualStandardResult = {
  artifact: typeof VISUAL_STANDARD_RESULT_ARTIFACT;
  summary: string;
  visualStandardId: string;
  applied: boolean;
  styleSource: "visual_standard" | "site";
  kind: "house" | "template";
  status: "draft" | "active";
  created: boolean;
  reason?: string;
  changedFields?: string[];
};

export type VisualStandardOutcome =
  | { kind: "completed"; output: VisualStandardResult; warnings: string[] }
  | { kind: "refused"; code: string; message: string };

const refused = (code: string, message: string): VisualStandardOutcome => ({ kind: "refused", code, message });

/**
 * Materialize the writer's proposal.
 *
 * Live only: a mock run reaches no client, so it refuses `not_live` and the executor falls through to
 * the MockNodeRunner placeholder — the identical posture capture's and clone's deterministic stages
 * take, and for the identical reason (CI graph traversal must keep working without a client).
 */
export async function runVisualStandardMaterialization(
  params: { run: WorkflowExecutionRecord; node: WorkspaceNode },
  deps: VisualStandardDeps = {}
): Promise<VisualStandardOutcome> {
  const { run } = params;
  const warnings: string[] = [];

  if ((run.executionMode ?? "mock") !== "openai") {
    return refused("not_live", `execution mode "${run.executionMode ?? "mock"}" never reaches the client; a visual standard is never fabricated.`);
  }

  const proposal = readBrandImageryProposal(run);
  if (!proposal) {
    return refused("brand_imagery_proposal_absent", `${VISUAL_STANDARD_MATERIALIZER_NODE_ID} found no ${BRAND_IMAGERY_PROPOSAL_ARTIFACT} carrying mode/brandImagery/label in stageOutputs.${BRAND_IMAGERY_WRITER_NODE_ID}; there is nothing to materialize and a standard is never invented.`);
  }

  const config = await (deps.projectRepository ?? repositoryManager.getProjectRepository()).get(run.projectId);
  if (!config) return refused("visual_standard_project_unresolved", `Unknown projectId "${run.projectId}"; the visual standard has no client to be created on.`);

  const siteObjectId = config.objectDialect?.siteObjectId;
  if (!siteObjectId) {
    return refused("visual_standard_site_unconfigured", `Project "${run.projectId}" declares no objectDialect.siteObjectId, so neither the standard's id (vis_<site>) nor the site an apply would target can be resolved.`);
  }

  const request = readVisualStandardRequest(run);
  // REVIEW: the run's declared mode is the authority on the write TARGET, and a proposal that
  // disagrees with it is a refusal, not something to reconcile. Overriding the proposal silently
  // would be worse than refusing: the writer's body was composed for the mode it thought it was in
  // (a template's `whenToUse`, a house standard's absence of one), so filing it under the other
  // mode's id files a body nobody wrote for that object. A run that declares no mode — the
  // single-node chat path, where the caller supplies only the materializer's own half — is
  // unaffected and still takes the proposal's word for it.
  if (request.declaredMode && request.declaredMode !== proposal.mode) {
    return refused(
      "visual_standard_mode_mismatch",
      `The run asked for mode "${request.declaredMode}" and ${BRAND_IMAGERY_WRITER_NODE_ID} returned a proposal for mode "${proposal.mode}". The mode selects which object is written — vis_<site> for a house standard, vis_<site>_<slug> for a template — so a disagreement here would file (and possibly apply) a look against a target the run never named. Nothing was written.`
    );
  }
  const templateSlug = request.templateSlug ?? proposal.templateSlug;
  const visualStandardId = visualStandardIdFor({ siteObjectId, mode: proposal.mode, templateSlug });
  if (!visualStandardId) {
    return refused(
      "visual_standard_id_unresolvable",
      proposal.mode === "template"
        ? `mode "template" needs a templateSlug (vis_<site>_<slug>, R2); none was supplied on the run's input and the proposal carries none. A template standard is never filed under the house id.`
        : `Site object id "${siteObjectId}" does not reduce to a usable id segment, so vis_<site> cannot be formed.`
    );
  }
  if (request.droppedReferences > 0) warnings.push(`visual_standard_references_trimmed:${request.droppedReferences}`);
  if (!proposal.sampleSubjects.length) {
    return refused("visual_standard_sample_subjects_absent", `${BRAND_IMAGERY_PROPOSAL_ARTIFACT} carries no sampleSubjects; the body schema requires 1..6 and this node never invents a subject.`);
  }

  const call = clientCallFor(config, deps);

  // 1. Does it already exist? A miss is the create path, not a failure.
  const existing = await call("object_get", { object_type: VISUAL_STANDARD_OBJECT_TYPE, object_id: visualStandardId });
  const notFound = !existing.ok
    ? NOT_FOUND.test(existing.detail)
    : existing.payload.not_found === true;
  if (!existing.ok && !notFound) {
    return refused("visual_standard_read_failed", `object_get(${visualStandardId}) failed for project ${run.projectId}: ${existing.detail}`);
  }
  const exists = existing.ok && !notFound;

  const body = buildVisualStandardBody({ proposal, references: request.references, status: "draft" });

  // 2. Create or patch. A patch takes the site-standard checkout/patch/checkin sequence — object_patch
  //    refuses without a held lease — and the lease is released in a `finally`, never left dangling on
  //    a mid-sequence refusal (cloneEngine's own T13.4 lock-leak lesson, applied here from the start).
  if (!exists) {
    const created = await call("object_create", { object_type: VISUAL_STANDARD_OBJECT_TYPE, site: siteObjectId, requested_id: visualStandardId, body, idempotency_key: run.runId });
    if (!created.ok) return refused("visual_standard_create_failed", `object_create(${visualStandardId}) failed for project ${run.projectId}: ${created.detail}`);
  } else {
    const patched = await patchVisualStandard(call, visualStandardId, { ...body });
    if (!patched.ok) return refused("visual_standard_patch_failed", `Patching ${visualStandardId} failed for project ${run.projectId}: ${patched.detail}`);
  }

  // 3. The apply, behind BOTH gates.
  const permission: ToolPermission = effectiveToolPermission(config, APPLY_BRAND_IMAGERY_TOOL);
  if (!request.apply) {
    return completed(visualStandardId, proposal.mode, "draft", !exists, false, warnings, `apply_not_requested: the run's input did not ask for the standard to be applied, so ${visualStandardId} was ${exists ? "updated" : "created"} as a draft and site.brandImagery is untouched.`);
  }
  if (permission !== "allowed") {
    return completed(visualStandardId, proposal.mode, "draft", !exists, false, warnings, `apply_policy_${permission}: project ${run.projectId}'s tool policy for ${APPLY_BRAND_IMAGERY_TOOL} is "${permission}", and this node has no turn in which to ask for an approval, so the standard stays a draft rather than being applied by a permission nobody granted.`);
  }

  // 3a. DRY RUN FIRST, ALWAYS — §3.3's preview is not optional decoration: it is how `changedFields`
  // reaches the receipt, and it needs neither lock nor record version.
  const preview = await call(APPLY_BRAND_IMAGERY_TOOL, { site_id: siteObjectId, visual_standard_id: visualStandardId, dry_run: true });
  if (!preview.ok) {
    return completed(visualStandardId, proposal.mode, "draft", !exists, false, warnings, `apply_dry_run_failed: ${preview.detail}. Nothing was applied; ${visualStandardId} stands as a draft.`);
  }
  const changedFields = readChangedFields(preview.payload);

  // 3b. The apply itself, under the site's own checkout.
  const checkout = await call("object_checkout", { object_type: SITE_OBJECT_TYPE, object_id: siteObjectId });
  if (!checkout.ok) {
    return completed(visualStandardId, proposal.mode, "draft", !exists, false, warnings, `apply_site_checkout_failed: ${checkout.detail}. The dry run succeeded, nothing was applied, and no lease was taken.`);
  }
  const lock = readLock(checkout.payload);
  let applyFailure: string | undefined;
  try {
    if (!lock.lockToken) {
      applyFailure = "apply_site_lock_absent: object_checkout(site) returned no lockToken, and site_apply_brand_imagery never auto-checkouts.";
    } else {
      const applied = await call(APPLY_BRAND_IMAGERY_TOOL, {
        site_id: siteObjectId,
        visual_standard_id: visualStandardId,
        lock_token: lock.lockToken,
        ...(lock.recordVersion !== undefined ? { expected_record_version: lock.recordVersion } : {})
      });
      if (!applied.ok) applyFailure = `apply_failed: ${applied.detail}`;
    }
  } finally {
    if (lock.lockToken) {
      // Best-effort, exactly like cloneEngine's: a leaked site lease is worse than a failed apply, and
      // the lease expires on its own if this too fails.
      const released = await call("object_checkin", { object_type: SITE_OBJECT_TYPE, object_id: siteObjectId, lock_token: lock.lockToken });
      if (!released.ok) warnings.push("visual_standard_site_checkin_failed");
    }
  }
  if (applyFailure) return completed(visualStandardId, proposal.mode, "draft", !exists, false, warnings, `${applyFailure} ${visualStandardId} stands as a draft.`, changedFields);

  // 4. An applied standard is the site's ACTIVE look, so it stops being a draft. Best-effort: the
  //    apply already happened and a failed status promotion must not report it as not having.
  const promoted = await patchVisualStandard(call, visualStandardId, { status: "active" });
  if (!promoted.ok) warnings.push("visual_standard_status_promotion_failed");
  return completed(visualStandardId, proposal.mode, promoted.ok ? "active" : "draft", !exists, true, warnings, undefined, changedFields);
}

async function patchVisualStandard(call: ClientCall, visualStandardId: string, fields: JsonRecord): Promise<{ ok: true } | { ok: false; detail: string }> {
  const checkout = await call("object_checkout", { object_type: VISUAL_STANDARD_OBJECT_TYPE, object_id: visualStandardId });
  if (!checkout.ok) return { ok: false, detail: `object_checkout: ${checkout.detail}` };
  const lock = readLock(checkout.payload);
  if (!lock.lockToken) return { ok: false, detail: "object_checkout returned no lockToken; object_patch refuses without a held lease." };
  try {
    const patched = await call("object_patch", {
      object_type: VISUAL_STANDARD_OBJECT_TYPE,
      object_id: visualStandardId,
      lock_token: lock.lockToken,
      ...(lock.recordVersion !== undefined ? { expected_record_version: lock.recordVersion } : {}),
      ops: [{ op: SET_VISUAL_STANDARD_FIELDS_OP, fields }]
    });
    return patched.ok ? { ok: true } : { ok: false, detail: `object_patch: ${patched.detail}` };
  } finally {
    await call("object_checkin", { object_type: VISUAL_STANDARD_OBJECT_TYPE, object_id: visualStandardId, lock_token: lock.lockToken });
  }
}

function completed(
  visualStandardId: string,
  kind: "house" | "template",
  status: "draft" | "active",
  created: boolean,
  applied: boolean,
  warnings: string[],
  reason?: string,
  changedFields?: string[]
): VisualStandardOutcome {
  return {
    kind: "completed",
    warnings,
    output: {
      artifact: VISUAL_STANDARD_RESULT_ARTIFACT,
      summary: applied
        ? `${created ? "Created" : "Updated"} ${kind} visual standard ${visualStandardId} and applied its brandImagery to the site${changedFields?.length ? ` (${changedFields.length} changed field(s))` : ""}.`
        : `${created ? "Created" : "Updated"} ${kind} visual standard ${visualStandardId} as a ${status}; site.brandImagery was NOT changed.`,
      visualStandardId,
      applied,
      // §3.4's vocabulary: the site's imagery now comes from this standard, or it still comes from
      // whatever the site already carried. Nothing here can produce 'override' or 'derived' — those
      // are the artifact-job resolver's answers, not this node's.
      styleSource: applied ? "visual_standard" : "site",
      kind,
      status,
      created,
      ...(reason ? { reason } : {}),
      ...(changedFields?.length ? { changedFields } : {})
    }
  };
}
