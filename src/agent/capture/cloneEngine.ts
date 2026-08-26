// T13.1 — the clone engine's CMS-Agent seam: one module that (a) resolves the target project's
// registry record (there is no capture-policy gate here — clone never crawls, it only authors DRAFT
// recipes/theme/page writes against an ALREADY-registered target) and (b) invokes the vendored
// platform clone stages (see ./provenance.ts) against stage artifacts. Both consumers — a future
// clone.* controlled tool surface and the clone_conductor deterministic node routes in
// workspace/cloneConductorRoutes.ts — go through these functions, so the write laws below cannot be
// enforced in one place and forgotten in the other. Mirrors captureEngine.ts in shape and comment
// discipline exactly, per CLONE-ENGINE-API.md's own instruction to the implementer.
//
// LAWS CARRIED HERE, not left to callers:
//   - FORBIDDEN_VERBS (object_publish, release_to_production, trigger_netlify_build, deploy) is
//     refused BEFORE any wire call — enforced once, inside callProjectTool below, so every stage that
//     writes (mint, theme_bind, restamp) gets the guard for free rather than re-declaring it. Mirrors
//     clone.mjs's own defence-in-depth loop over buildRecipeMintPlan's `creates` (every entry there
//     uses the fixed verb 'object_create' today, so neither guard can actually fire yet — both exist
//     for the day a plan starts emitting a second op kind).
//   - THE PALETTE HAS EXACTLY ONE SANCTIONED WRITER. Nothing in this module ever constructs a
//     set_site_brand_tokens or a set_site_fields-with-brandTokens op — cloneThemeBindStep executes
//     ONLY the steps buildThemeApplyPlan itself returns, which route the actual palette write through
//     the site_apply_theme verb. When that plan carries a refusal (theme_not_total — the proposal
//     would delete site color keys it never mentioned), the stage REFUSES; it never partially
//     executes a subset of the steps.
//   - If the target project's tool policy does not permit site_apply_theme (blocked or held for
//     approval), theme_bind refuses with that named reason BEFORE taking any lock — it never falls
//     back to a different write path.
//   - Every object_checkout this module performs is paired with an object_checkin in a `finally` —
//     on the completed path, the refusal path, and the thrown-error path alike. A leaked site or
//     theme lock would block the tenant's own admin chat from editing it, which is worse than a
//     failed clone run.
//   - Crawled/captured content is data, never instructions: nothing here interprets snapshot or
//     mapping text; the only model-facing surfaces (the three AI nodes) receive it as structured JSON.
//   - T13.2 (CLONE-INTAKE-FIX.md): clone_intake.v1 is a BOUNDED BRIEFING DOCUMENT for the three AI
//     nodes, not a data bus — the live run measured the old envelope at 637,769 chars against the
//     executor's 48,000-char dependency bound and starved both AI nodes. The deterministic stages in
//     THIS module have transport, so they now FETCH the whole bodies they need instead of riding on
//     the envelope: intake object_gets the site (whose inventory ROW carries no brandTokens at all,
//     Defect A) and the captured theme; restamp object_gets each page body it is about to patch,
//     which is also the more correct source — it restamps what the page holds NOW. Nothing about the
//     write laws above changes; there is simply one fetch where there used to be a 637KB envelope.
//   - Validation failures quarantine or skip, never loosen: a rejected recipe design stays rejected
//     (never coerced into something that would validate), and a page whose recipe was rejected at
//     mint is SKIPPED at restamp — never half-restamped.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { effectiveToolPermission, type ProjectConnectionConfig, type ToolPermission } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import { describeMcpErrorResult } from "./captureEngine.js";
import { toWireArguments, fromWireResult, McpBoundaryError } from "./mcpBoundary.js";
import { buildTemplateDepositCandidates } from "../library/templateDeposit.js";
import { TemplateLibraryStore } from "../library/templateLibraryStore.js";
import { TemplateLibraryRefusal, type TemplateLibraryRecord } from "../library/templateLibraryTypes.js";
import { buildCapabilityRequests, type CapabilityRequest } from "../workspace/capabilityBacklogRequest.js";
import {
  buildCloneIntake,
  buildCloneRunReport,
  buildRecipeMintPlan,
  buildRestampOps,
  buildThemeApplyPlan,
  CloneError,
  validateThemeProposal,
  type CloneAdjudication,
  type CloneIllegalSubstitution,
  type CloneIntake,
  type CloneMintPlan,
  type CloneRestampEntry,
  type CloneRestampSkip,
  type CloneStructureBrief,
  type CloneSubstitution,
  type CloneThemeApplied,
  type CloneThemeApplyPlan
} from "./engine/clone.mjs";

export const CLONE_ARTIFACTS = {
  intake: "clone_intake.v1",
  mint: "clone_recipe_mint.v1",
  themeBind: "clone_theme_bind.v1",
  restamp: "clone_restamp.v1",
  report: "clone_run_report.v1"
} as const;

export class CloneRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CloneRefusal";
  }
}

// T15.12 — a NAMED subtype of CloneRefusal for the one failure mode that is sometimes worth trying
// again: object_checkout's own contract (contractReduction's REAL_SHAPED_CONTRACT fixture, verbatim)
// is "423 = no/expired/other-held lock (checkout again)". Everything that already catches
// CloneRefusal keeps working unchanged (this IS one); callers that care specifically about a lock
// conflict — cloneRestampStep, to name the quarantine reason precisely instead of folding it into the
// generic restamp_patch_failed — can narrow with `instanceof CloneLockConflict`.
export class CloneLockConflict extends CloneRefusal {
  constructor(message: string) {
    super("clone_lock_conflict", message);
    this.name = "CloneLockConflict";
  }
}

export type CloneDeps = {
  projectRepository?: ProjectRepository;
  executionRepository?: ExecutionRepository;
  // T15.31 (#207): injectable so tests exercise the deposit step against an in-memory store instead
  // of the real blob backend, exactly as projectRepository/executionRepository are.
  templateLibraryStore?: TemplateLibraryStore;
  // Injected ONLY so tests never wait on a real clock — see the retry block below. Production
  // defaults to a real timer and Math.random(); neither default is ever exercised by a test.
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
};
const projectsOf = (deps: CloneDeps = {}): ProjectRepository => deps.projectRepository ?? repositoryManager.getProjectRepository();
const executionsOf = (deps: CloneDeps = {}): ExecutionRepository => deps.executionRepository ?? repositoryManager.getExecutionRepository();
const templateLibraryOf = (deps: CloneDeps = {}): TemplateLibraryStore => deps.templateLibraryStore ?? new TemplateLibraryStore();

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// Mirrors emit.mjs's (unexported) FORBIDDEN_VERBS and clone.mjs's own hand-kept duplicate of it —
// see clone.mjs's header comment. Kept in lockstep by hand whenever either changes.
const FORBIDDEN_VERBS = new Set(["object_publish", "release_to_production", "trigger_netlify_build", "deploy"]);

// ---------------------------------------------------------------------------------------------
// Authority resolution — every clone step passes through this before touching the target project.
// Unlike captureEngine's resolveCaptureAuthority, there is no capture-policy validation here: clone
// never crawls, it only authors drafts against a project that is already registered and enabled. The
// per-verb law that DOES apply (site_apply_theme's tool-policy gate) is checked at the one stage that
// needs it, not here, so a project that simply cannot theme-bind is not refused before it can mint.
export type ResolvedClone = { projectId: string; config: ProjectConnectionConfig };

export async function resolveCloneAuthority(targetProjectId: string, deps: CloneDeps = {}): Promise<ResolvedClone> {
  const trimmed = typeof targetProjectId === "string" ? targetProjectId.trim() : "";
  if (!trimmed) throw new CloneRefusal("clone_target_missing", "A target projectId is required; clone writes are per-project and there is no global default.");
  const config = await projectsOf(deps).get(trimmed);
  if (!config) throw new CloneRefusal("unknown_project", `Unknown projectId: ${trimmed}. Register the target via project.create before any clone step.`);
  if (config.status === "disabled") throw new CloneRefusal("project_disabled", `Project ${trimmed} is disabled; no clone step may run against it.`);
  return { projectId: trimmed, config };
}

// The non-secret policy view stamped onto clone stage envelopes, mirroring captureEngine's
// CapturePolicyView — the project's effective tool-permission map, so downstream nodes (and a human
// reading the report) can see WHY a write did or did not happen without re-fetching the registry.
export type ClonePolicyView = { defaultToolPolicy: ToolPermission; toolPolicies: Record<string, ToolPermission>; allowedTools: string[] };

const clonePolicyView = (config: ProjectConnectionConfig): ClonePolicyView => ({
  defaultToolPolicy: config.defaultToolPolicy ?? "blocked",
  toolPolicies: { ...(config.toolPolicies ?? {}) },
  allowedTools: [...config.allowedTools]
});

// ---------------------------------------------------------------------------------------------
// Guarded project MCP call. Uses the SAME adapter + per-project tool permissions project.call_tool
// uses. FORBIDDEN_VERBS is checked FIRST, before this function even resolves the project — so a
// forbidden verb is refused before any wire call regardless of which stage attempted it. A tool the
// project's policy blocks or holds for approval (ProjectMcpAdapter.callTool's own "blocked" /
// "needs_approval" gate) is likewise refused before transport, with the adapter's own error naming
// the reason — this is what makes theme_bind's "policy blocks site_apply_theme" law hold without any
// special-casing at the call site.
//
// T13.4: THE CHOKE POINT. Every argument object this module hands to the wire, and every result it
// reads back, passes through mcpBoundary.ts's toWireArguments/fromWireResult HERE and only here — no
// other function in this file may construct a wire argument object or read a raw wire result field.
// A boundary refusal (a missing required field on the way out; a missing lock token on the way back)
// is a McpBoundaryError, re-thrown here as the module's own CloneRefusal so every caller keeps
// catching one error family regardless of which layer refused.
// T15.12 — BOUNDED, JITTERED RETRY ON A LOCK CONFLICT, object_checkout ONLY.
//
// THE INCIDENT. Live run run_1787582215829_u5rncz quarantined page_partners and page_filmography with
// `restamp_patch_failed: HTTP 423` — object_checkout found both pages already locked. Every lock this
// module takes was already released in a `finally` before this fix (T13.4's lock-leak audit; the
// comment at this file's own header states the law), and T14.4 (executor.ts) already stamps a dispatch
// claim so the SAME run can never re-enter the SAME node and collide with itself. What is left is the
// case both of those fixes correctly leave alone: a lock genuinely held by someone else at the instant
// restamp asks — a still-finishing capture emission on the same page, an overlapping clone run, or a
// lease that has not yet naturally expired. object_checkout's own contract answers this directly
// (contractReduction's REAL_SHAPED_CONTRACT fixture, verbatim): "423 = no/expired/other-held lock
// (checkout again)". A 423 is therefore a REAL signal, not an obstacle — but "checkout again" only
// ever means checkout again, on the SAME object, waiting for the SAME holder to finish or expire. It
// never means substituting a different lock token, forcing the checkout, or falling back to a write
// path that skips locking — that would be stealing the lock, which this retry never does.
//
// THE BOUND. Retrying while a stale-diagnostic-worthy conflict is genuinely live forever is a
// livelock, so this is capped at OBJECT_CHECKOUT_LOCK_RETRY_MAX_ATTEMPTS total attempts (first try
// plus bounded retries) with an exponential, JITTERED backoff — jittered so that two runs contending
// for the same lock do not retry in lockstep and starve each other indefinitely. Exhausting the bound
// throws CloneLockConflict, a NAMED, typed refusal a caller can recognize and report as retryable —
// never a silent skip and never a coerced write.
//
// DETERMINISM (#200). The backoff delay and the outcome of any one real attempt are exactly the kind
// of wall-clock, network-dependent facts that must never leak into anything a run emits or hashes: the
// delay is never included in an error message, an attempt counter is never recorded on any envelope,
// and the exhausted-retries message below names the (constant) policy, never how many attempts THIS
// call actually took. Two runs against the same fixed sequence of server responses always reach the
// same outcome through the same code path — only the real wall-clock time spent getting there differs,
// which is exactly what determinism here promises to ignore.
const OBJECT_CHECKOUT_LOCK_RETRY_MAX_ATTEMPTS = 4;
const OBJECT_CHECKOUT_LOCK_RETRY_BASE_MS = 200;
const OBJECT_CHECKOUT_LOCK_RETRY_CEILING_MS = 1_500;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const defaultRandom = (): number => Math.random();

/** The client's own statusCode from a raw MCP error result — the same field describeMcpErrorResult
 * reads for its human-readable prefix. Read here ONLY to decide whether a failure is specifically a
 * lock conflict worth a bounded retry; it decides nothing else about how the error is reported. */
function mcpErrorStatusCode(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  const structured = isRecord(raw.structuredContent) ? raw.structuredContent : undefined;
  return typeof structured?.statusCode === "number" ? structured.statusCode : undefined;
}

// Exported (not just __test__-seamed) since T15.34/#210: pdfTemplateEngine.ts reuses this SAME
// guarded transport for the pdf-tool bridge verbs — same project resolution, same forbidden-verb
// gate (moot for pdf-tool's own vocabulary, but never disabled per-caller), same wire-boundary
// discipline (mcpBoundary.ts). "The discipline is shared; the transport is not" (ADR-2026-08-25-
// structure-studio §7) means the CALLING CONVENTION is shared, not that pdf-tool calls become CMS
// object calls — nothing here routes a pdf-tool verb through object_create/object_publish or any
// other CMS-object machinery; it is the same "resolve the project, guard the verb, cross the wire
// once" shape applied to a different vocabulary.
export async function callProjectTool(projectId: string, tool: string, args: Record<string, unknown>, deps: CloneDeps = {}): Promise<Record<string, unknown>> {
  if (FORBIDDEN_VERBS.has(tool)) throw new CloneRefusal("forbidden_verb", `Forbidden clone verb: ${tool}. object_publish / release_to_production / trigger_netlify_build / deploy are unreachable from clone_conductor.`);
  const config = await projectsOf(deps).get(projectId);
  if (!config) throw new CloneRefusal("unknown_project", `Unknown projectId: ${projectId}`);

  let wireArgs: Record<string, unknown>;
  try {
    wireArgs = toWireArguments(tool, args);
  } catch (error) {
    if (error instanceof McpBoundaryError) throw new CloneRefusal("clone_wire_argument_invalid", error.message);
    throw error;
  }

  const adapter = new ProjectMcpAdapter(config);
  const sleep = deps.sleepImpl ?? defaultSleep;
  const random = deps.randomImpl ?? defaultRandom;
  // The retry loop is scoped to object_checkout by construction — no other verb's failure is ever
  // eligible, so a patch/checkin/create failure keeps throwing on its first and only attempt exactly
  // as before this change.
  const maxAttempts = tool === "object_checkout" ? OBJECT_CHECKOUT_LOCK_RETRY_MAX_ATTEMPTS : 1;

  let raw: Record<string, unknown> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const call = await adapter.callTool(tool, wireArgs);
    if (!call.ok) throw new CloneRefusal("project_tool_call_failed", `${tool} on ${projectId} failed: ${call.error ?? "unknown error"}`);
    raw = call.result as Record<string, unknown> | undefined;
    if (!(isRecord(raw) && raw.isError)) break;

    const isLockConflict = tool === "object_checkout" && mcpErrorStatusCode(raw) === 423;
    if (!isLockConflict) {
      throw new CloneRefusal("project_tool_call_failed", `${tool} on ${projectId} returned an MCP error result: ${describeMcpErrorResult(raw)}`);
    }
    if (attempt === maxAttempts) {
      // THE BOUND HIT. Never steal the lock, never coerce a write — refuse, NAMED, so the caller can
      // report exactly which object is still contended and a human or a later run can retry it.
      throw new CloneLockConflict(`${tool} on ${projectId} could not acquire the lock after ${maxAttempts} bounded attempt(s); the object is held by another writer or its lease has not yet expired. object_checkout's own contract: "checkout again" — never steal the token, never fall back to a different write path. ${describeMcpErrorResult(raw)}`);
    }
    // Exponential backoff with full jitter (uniform in [0, ceiling]) — bounded by
    // OBJECT_CHECKOUT_LOCK_RETRY_CEILING_MS so two contending runs do not retry in lockstep. Real
    // wall-clock delay only; never recorded on anything the run emits.
    const ceiling = Math.min(OBJECT_CHECKOUT_LOCK_RETRY_BASE_MS * 2 ** (attempt - 1), OBJECT_CHECKOUT_LOCK_RETRY_CEILING_MS);
    await sleep(ceiling * random());
  }

  const structured = isRecord(raw) && isRecord(raw.structuredContent) ? (raw.structuredContent as Record<string, unknown>) : (isRecord(raw) ? raw : {});
  const unwrapped = isRecord(structured.data) ? (structured.data as Record<string, unknown>) : structured;

  try {
    return fromWireResult(tool, unwrapped);
  } catch (error) {
    if (error instanceof McpBoundaryError) throw new CloneRefusal("clone_wire_result_invalid", error.message);
    throw error;
  }
}

// object_get returns {record:{...}} on the platform dialect and a bare record on some targets; a
// record in turn carries its payload under `body` or inline. Both unwrappings are done HERE, once, so
// what this module hands the engine is unambiguous — clone.mjs tolerates either shape, but a stage
// that says "this is the site BODY" should have actually resolved one.
const recordOf = (result: Record<string, unknown>): Record<string, unknown> => (isRecord(result.record) ? (result.record as Record<string, unknown>) : result);
const bodyOf = (record: Record<string, unknown>): Record<string, unknown> => (isRecord(record.body) ? (record.body as Record<string, unknown>) : record);

const objectIdOf = (row: unknown): string | undefined => {
  if (!isRecord(row)) return undefined;
  const value = row.object_id ?? row.objectId;
  return typeof value === "string" && value ? value : undefined;
};

const stageOutput = (run: { stageOutputs: Record<string, unknown> }, nodeId: string): Record<string, unknown> | undefined => {
  const value = run.stageOutputs[nodeId];
  return isRecord(value) ? value : undefined;
};

// ---------------------------------------------------------------------------------------------
// Stage: intake — resolves the finished capture run's artifacts plus the target's CURRENT inventory,
// LIVE registries, SITE BODY and captured THEME, and builds the bounded clone_intake.v1 briefing
// (clone.mjs, pure). `artifact` and `summary` come from the engine itself now; this stage stamps only
// the non-secret policy view on top, then re-settles budget.chars so the envelope still reports the
// size of the thing that actually travels.
export type CloneIntakeEnvelope = CloneIntake & { artifact: typeof CLONE_ARTIFACTS.intake; summary: string; policy: ClonePolicyView };

const isCloneIntakeEnvelope = (value: unknown): value is CloneIntakeEnvelope => isRecord(value) && value.artifact === CLONE_ARTIFACTS.intake;

export function assertCloneIntakeEnvelope(value: unknown): CloneIntakeEnvelope {
  if (!isCloneIntakeEnvelope(value)) {
    throw new CloneRefusal("clone_upstream_artifact_invalid", `Expected clone_intake's stage output to be a ${CLONE_ARTIFACTS.intake} envelope; found ${isRecord(value) ? `artifact "${String(value.artifact)}"` : "nothing"}. A placeholder or malformed upstream artifact is never built upon.`);
  }
  return value;
}

const INVENTORY_TYPES = ["page", "template", "section_template", "theme", "navigation", "site"] as const;

// T15.30 (#206; ADR-2026-08-25-structure-studio §3) — clone_intake is the ONE adapter for BOTH
// entries. `captureRunId` (non-empty) selects the CLONE-DRIVEN path, unchanged since T13.1/T13.2:
// resolve the finished capture run, read its snapshot/mapping/emission. Its ABSENCE, with a
// `structureBrief` supplied instead, selects the DEMAND-DRIVEN path (T15.30): no capture run is
// looked up at all — `buildCloneIntake` normalizes the brief directly. Both converge on the same
// registry/inventory/site/theme fetches below and the same `buildCloneIntake` call; only the
// clone-specific fetches (the capture run, its snapshot/mapping) are conditional on the mode.
export async function cloneIntakeStep(
  input: { targetProjectId: string; captureRunId?: string; structureBrief?: unknown },
  deps: CloneDeps = {}
): Promise<CloneIntakeEnvelope> {
  const { projectId, config } = await resolveCloneAuthority(input.targetProjectId, deps);
  const captureRunId = typeof input.captureRunId === "string" ? input.captureRunId.trim() : "";
  const structureBrief = captureRunId ? undefined : input.structureBrief;
  if (!captureRunId && structureBrief === undefined) {
    throw new CloneRefusal("clone_source_missing", "clone_intake needs either a captureRunId (clone-driven) or a structureBrief (demand-driven); neither was supplied.");
  }

  let mapping: unknown;
  let emissionReport: unknown = null;
  let themeOut: Record<string, unknown> | undefined;
  if (captureRunId) {
    const captureRun = await executionsOf(deps).getRun(captureRunId);
    if (!captureRun) throw new CloneRefusal("clone_source_run_missing", `No run found for captureRunId ${captureRunId}.`);
    if (typeof captureRun.projectId === "string" && captureRun.projectId.trim() && captureRun.projectId.trim() !== projectId) {
      throw new CloneRefusal("clone_source_run_project_mismatch", `Capture run ${captureRunId} belongs to project "${captureRun.projectId}", not this clone run's own target "${projectId}"; a clone may never graft one tenant's captured content onto another's site.`);
    }

    const crawlOut = stageOutput(captureRun, "capture_crawl");
    const mapOut = stageOutput(captureRun, "capture_map_refine") ?? stageOutput(captureRun, "capture_map");
    themeOut = stageOutput(captureRun, "capture_theme");
    const emitOut = stageOutput(captureRun, "capture_emit_live");
    if (!crawlOut || !isRecord(crawlOut.snapshot)) {
      throw new CloneRefusal("clone_source_snapshot_missing", `Capture run ${captureRunId} carries no capture_crawl snapshot; there is nothing to clone from.`);
    }
    if (!mapOut || !isRecord(mapOut.mapping)) {
      throw new CloneRefusal("clone_source_mapping_missing", `Capture run ${captureRunId} carries neither a capture_map nor a capture_map_refine mapping.`);
    }
    mapping = mapOut.mapping;
    emissionReport = emitOut?.report ?? null;
  }

  const componentRegistry = await callProjectTool(projectId, "registry_get", { registry: "component" }, deps);
  const pageTypeRegistry = await callProjectTool(projectId, "registry_get", { registry: "page_type" }, deps);
  const inventory: Record<string, unknown[]> = {};
  for (const objectType of INVENTORY_TYPES) {
    const rows = await callProjectTool(projectId, "object_inventory", { objectType }, deps);
    inventory[objectType] = Array.isArray(rows.objects) ? (rows.objects as unknown[]) : [];
  }

  // EXACTLY ONE ACTIVE SITE. buildCloneIntake refuses on the identical rule, but this stage has to
  // resolve the id BEFORE it can object_get the body the engine now requires — so the count is
  // checked at the point the id is needed, with its own named refusal, and the two never disagree
  // (the filter below is clone.mjs's own, verbatim: object_type 'site' AND status 'active').
  const activeSiteIds = (inventory.site ?? [])
    .filter((row) => isRecord(row) && row.object_type === "site" && row.status === "active")
    .map((row) => objectIdOf(row))
    .filter((objectId): objectId is string => Boolean(objectId));
  if (activeSiteIds.length !== 1) {
    throw new CloneRefusal("clone_site_not_unique", `Clone intake requires exactly one ACTIVE site object in ${projectId}'s inventory; found ${activeSiteIds.length}. A clone writes a palette onto ONE site, so neither an empty nor an ambiguous inventory may be guessed at.`);
  }
  const siteId = activeSiteIds[0];

  // DEFECT A (CLONE-INTAKE-FIX.md): the site BODY, not its inventory row. An object_inventory row
  // carries no brandTokens at all, which is why the live run's theme_reconciler had no slots to
  // enumerate and correctly refused against an empty palette. buildCloneIntake refuses a body without
  // one rather than letting that surface three stages later as a theme refusal.
  const siteGet = await callProjectTool(projectId, "object_get", { objectType: "site", objectId: siteId }, deps);
  const siteBody = bodyOf(recordOf(siteGet));

  // The CAPTURED theme, correlated from the capture run's own emission report the same way the theme
  // bind stage used to — or, when the report names no theme create (a target that already had one),
  // the single theme row inventory reports. Either way this stage fetches the RECORD, so the briefing
  // carries the theme's real objectId and its whole ~900-char token set. When neither resolves there
  // is nothing to bind: the capture stage's own draft still supplies the tokens for the AI node, the
  // briefing's theme.objectId stays null, and theme_bind refuses with clone_theme_missing.
  const capturedThemeId = resolveEmittedThemeId(emissionReport) ?? (inventory.theme?.length === 1 ? objectIdOf(inventory.theme[0]) : undefined);
  let theme: unknown = themeOut?.theme ?? null;
  if (capturedThemeId) {
    const themeGet = await callProjectTool(projectId, "object_get", { objectType: "theme", objectId: capturedThemeId }, deps);
    theme = recordOf(themeGet);
  }

  let intake: CloneIntake;
  try {
    intake = buildCloneIntake({
      captureRunId: captureRunId || undefined,
      structureBrief: structureBrief as CloneStructureBrief | undefined,
      target: projectId,
      mapping,
      siteBody,
      theme,
      emissionReport,
      inventory,
      componentRegistry,
      pageTypeRegistry
    });
  } catch (error) {
    if (error instanceof CloneError) throw new CloneRefusal("clone_intake_invalid", error.message);
    throw error;
  }

  return settleEnvelopeBudget({
    ...intake,
    artifact: CLONE_ARTIFACTS.intake,
    summary: `${intake.summary} Briefed ${intake.pages.length} page(s), ${Object.keys(intake.registry.sectionTypes).length} registered section type(s), ${Object.keys(intake.registry.pageTypes).length} page type(s) at ${intake.budget.chars} of ${intake.budget.cap} chars.`,
    policy: clonePolicyView(config)
  });
}

// This stage stamps the non-secret policy view onto the engine's own briefing, so `budget.chars` —
// which buildCloneIntake settled against ITS serialization — would otherwise under-report the
// envelope that actually travels to the AI nodes. A briefing that under-reports its own size is the
// precise defect CLONE-INTAKE-FIX.md exists to make unreachable, so restate the number against the
// final object (the same bounded settle loop clone.mjs runs: writing the number changes the length by
// up to one digit, and the claim may never fall below the measured length) and refuse outright if the
// stamp pushed the result past the cap the engine enforces.
function settleEnvelopeBudget(envelope: CloneIntakeEnvelope): CloneIntakeEnvelope {
  let claimed = JSON.stringify(envelope).length;
  for (let pass = 0; pass < 5; pass += 1) {
    envelope.budget.chars = claimed;
    const actual = JSON.stringify(envelope).length;
    if (actual === claimed) break;
    claimed = Math.max(actual, claimed);
  }
  envelope.budget.chars = claimed;
  if (claimed > envelope.budget.cap) {
    throw new CloneRefusal("clone_intake_cannot_be_bounded", `The clone briefing measures ${claimed} chars against its own ${envelope.budget.cap}-char cap once this run's policy view is stamped on it; a silently oversized briefing is what starved both AI nodes on run_1787508397978_8fyyst.`);
  }
  return envelope;
}

// ---------------------------------------------------------------------------------------------
// Stage: mint — re-validates recipe_designer's designs against the live registries (clone.mjs, pure
// planner) and EXECUTES the surviving creates as governed draft writes, reuse-first.
export type CloneMintCreatedRow = { objectType: string; objectId: string; requestedId: string; name: string; draftVerified: boolean };
export type CloneMintEnvelope = {
  artifact: typeof CLONE_ARTIFACTS.mint;
  summary: string;
  plan: CloneMintPlan;
  report: { createdObjects: CloneMintCreatedRow[] };
  applied: CloneMintCreatedRow[];
  rejected: Array<Record<string, unknown>>;
  reused: Array<Record<string, unknown>>;
  // T13.4 PART B/C: surfaced at the TOP LEVEL, mirroring `applied`/`rejected`/`reused` (all already
  // lifted out of `plan` for callers), because cloneRestampStep and buildCloneReportStep both read
  // `mint.substitutions` — restamp's resolveSectionTypeSubstitutions re-validates fit_adjudicator's
  // choices against exactly this list, and a caller that narrows the mint envelope down to
  // `{rejected}` alone (as cloneRestampStep once did) silently turns every valid choice into a
  // `substitution_not_in_candidates` rejection, because there is nothing left to check it against.
  substitutions: CloneSubstitution[];
  policy: ClonePolicyView;
};

export async function cloneMintStep(input: { targetProjectId: string; intake: unknown; design: unknown }, deps: CloneDeps = {}): Promise<CloneMintEnvelope> {
  const { projectId, config } = await resolveCloneAuthority(input.targetProjectId, deps);
  const intake = assertCloneIntakeEnvelope(input.intake);
  if (intake.target !== projectId) {
    throw new CloneRefusal("clone_target_mismatch", `clone_intake was built for target "${intake.target}", not this run's own target "${projectId}".`);
  }

  const design = isRecord(input.design) ? input.design : {};
  let plan: CloneMintPlan;
  try {
    plan = buildRecipeMintPlan({ intake, design: { sectionTemplates: (design.sectionTemplates as unknown[]) ?? [], templates: (design.templates as unknown[]) ?? [] } });
  } catch (error) {
    throw new CloneRefusal("clone_mint_plan_invalid", error instanceof CloneError || error instanceof Error ? error.message : String(error));
  }

  // Defence in depth (see the module header): every create buildRecipeMintPlan produces uses the
  // fixed verb 'object_create' today, so this can never actually fire — but a future plan change
  // that starts emitting a second op kind must trip it here, before any wire call, not at the wire.
  for (const create of plan.creates) {
    if (FORBIDDEN_VERBS.has(create.verb)) throw new CloneRefusal("forbidden_verb", `Recipe mint plan attempted a forbidden verb: ${create.verb}`);
  }

  const applied: CloneMintCreatedRow[] = [];
  const rejected: Array<Record<string, unknown>> = [...plan.rejected];
  for (const create of plan.creates) {
    try {
      // T13.4-SPEC.md's non-naming sibling defect: object_create REQUIRES `site`
      // (required: ["object_type","site","body"]) and the mint plan (engine/clone.mjs, out of this
      // module's scope) never emitted one — a body the platform itself validates as eligible:true
      // was rejected 400: Invalid request fields. `intake.site.objectId` is the one authority for
      // this run's site (the same id theme_bind and buildCloneRunReport both read); toWireArguments
      // now refuses BEFORE any wire call if it is ever absent, rather than producing an invalid call.
      const result = await callProjectTool(projectId, create.verb, { objectType: create.objectType, requestedId: create.requestedId, body: create.body, site: intake.site?.objectId }, deps);
      const record = isRecord(result.record) ? (result.record as Record<string, unknown>) : result;
      const objectId = typeof record.object_id === "string" ? record.object_id : create.requestedId;
      const publication = isRecord(record.publication) ? (record.publication as Record<string, unknown>) : undefined;
      const publishedTime = publication?.published_time;
      applied.push({
        objectType: create.objectType,
        objectId,
        requestedId: create.requestedId,
        name: typeof create.body.name === "string" ? create.body.name : create.requestedId,
        draftVerified: publishedTime === null || publishedTime === undefined
      });
    } catch (error) {
      rejected.push({ kind: create.objectType, name: (create.body.name as string | undefined) ?? null, reason: "object_create_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    artifact: CLONE_ARTIFACTS.mint,
    summary: `Recipe mint for ${projectId}: ${applied.length} created (${plan.reused.length} reused, ${rejected.length} rejected).`,
    plan,
    report: { createdObjects: applied },
    applied,
    rejected,
    reused: plan.reused,
    substitutions: plan.substitutions,
    policy: clonePolicyView(config)
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: theme_bind — the palette's ONE sanctioned writer. Re-validates theme_reconciler's proposal
// against the site's own declared slots (clone.mjs, pure), builds the apply plan (pure — a totality
// refusal here means NO steps at all), and executes exactly the steps that plan names: checkout the
// theme, patch its tokens, check it back in; checkout the site, dry-run site_apply_theme, then apply
// it for real; check the site back in. Every checkout is released in a finally.
const CHECKOUT_PLACEHOLDER_RE = /^<from .* checkout>$/;
const isCheckoutPlaceholder = (value: unknown): value is string => typeof value === "string" && CHECKOUT_PLACEHOLDER_RE.test(value);

export type CloneThemeBindEnvelope = {
  artifact: typeof CLONE_ARTIFACTS.themeBind;
  summary: string;
  siteId: string;
  themeId: string;
  applied: CloneThemeApplied;
  dropped: Array<Record<string, unknown>>;
  before: Record<string, unknown>;
  after: CloneThemeApplied;
  // T13.4 PART B/C: validateThemeProposal's own font substitution ledger, unnarrowed — buildCloneReportStep
  // already passes this WHOLE envelope as buildCloneRunReport's `themeReport`, so this field is what
  // makes `themeReport.substitutions` (font-kind ledger entries) actually reach the final report.
  substitutions: CloneSubstitution[];
  published: false;
  policy: ClonePolicyView;
};

// The already-emitted theme object's id, correlated from the capture run's OWN emission report the
// same way clone.mjs's briefingPages() correlates pages. Since T13.2 this is INTAKE's helper: intake
// resolves the id, object_gets the record, and publishes it as `intake.theme.objectId`, so theme_bind
// reads one authority rather than re-deriving the correlation from an emission report the briefing no
// longer carries. Kept here, next to the stage that consumes the id it produces. Detail: the report's `creates` entry for objectType
// 'theme' names the requestedId the emitter attempted; that id is the final objectId when the target
// MCP honored it (createdObjects), or — on a re-run against a tenant that already had a theme, T12.28's
// reuse path — the reused theme's own objectId (matched by name at emission time, so there is no
// requestedId to look up here). No theme create in the report at all is `undefined`: nothing to bind.
function resolveEmittedThemeId(emissionReport: unknown): string | undefined {
  if (!isRecord(emissionReport)) return undefined;
  const creates = Array.isArray(emissionReport.creates) ? (emissionReport.creates as Array<Record<string, unknown>>) : [];
  const themeCreate = creates.find((entry) => entry.objectType === "theme" && typeof entry.requestedId === "string");
  if (!themeCreate) return undefined;
  const createdObjects = Array.isArray(emissionReport.createdObjects) ? (emissionReport.createdObjects as Array<Record<string, unknown>>) : [];
  const createdThemeIds = new Set(createdObjects.filter((row) => row.objectType === "theme").map((row) => row.objectId));
  if (createdThemeIds.has(themeCreate.requestedId)) return themeCreate.requestedId as string;
  const reusedObjects = Array.isArray(emissionReport.reusedObjects) ? (emissionReport.reusedObjects as Array<Record<string, unknown>>) : [];
  const reusedTheme = reusedObjects.find((row) => row.objectType === "theme" && typeof row.objectId === "string");
  return reusedTheme ? (reusedTheme.objectId as string) : undefined;
}

export async function cloneThemeBindStep(input: { targetProjectId: string; intake: unknown; themeProposal: unknown }, deps: CloneDeps = {}): Promise<CloneThemeBindEnvelope> {
  const { projectId, config } = await resolveCloneAuthority(input.targetProjectId, deps);
  const intake = assertCloneIntakeEnvelope(input.intake);
  if (intake.target !== projectId) {
    throw new CloneRefusal("clone_target_mismatch", `clone_intake was built for target "${intake.target}", not this run's own target "${projectId}".`);
  }

  // THE POLICY GATE, CHECKED BEFORE ANY LOCK IS TAKEN. If the target project's tool policy does not
  // permit site_apply_theme (blocked, or held for approval), refuse with that named reason now —
  // never fall back to a different write path, and never leave a theme checkout dangling while this
  // is discovered three steps later.
  const themePermission = effectiveToolPermission(config, "site_apply_theme");
  if (themePermission !== "allowed") {
    throw new CloneRefusal("clone_theme_apply_policy_blocked", `Project ${projectId}'s tool policy for site_apply_theme is "${themePermission}"; the only sanctioned palette writer is refused by policy, so theme_bind refuses rather than attempting any other write path.`);
  }

  // ONE AUTHORITY FOR BOTH IDS. The briefing resolved the site (exactly one active) and the captured
  // theme at intake and published their objectIds; re-deriving either here from an emission report the
  // envelope no longer carries would be a second, drift-prone answer to a question already settled —
  // and buildCloneRunReport reads the site's id from the very same place.
  const siteId = intake.site?.objectId;
  if (!siteId) throw new CloneRefusal("clone_site_missing", "clone_intake's briefing carries no active site object id.");
  const themeId = intake.theme?.objectId;
  if (!themeId) throw new CloneRefusal("clone_theme_missing", "clone_intake's briefing carries no captured theme object id; theme_bind needs the theme capture already created to write its reconciled tokens onto.");

  const themeProposal = isRecord(input.themeProposal) ? input.themeProposal : {};
  // Both records are still read HERE, live: buildThemeApplyPlan is handed the site and theme as they
  // stand at apply time, not as the briefing saw them at intake. The palette the proposal is judged
  // against comes from the briefing (below); these two supply the plan's own record arguments.
  const siteGet = await callProjectTool(projectId, "object_get", { objectType: "site", objectId: siteId }, deps);
  const siteBody = bodyOf(recordOf(siteGet));
  const themeGet = await callProjectTool(projectId, "object_get", { objectType: "theme", objectId: themeId }, deps);
  const themeRecord = recordOf(themeGet);

  let validated: ReturnType<typeof validateThemeProposal>;
  try {
    // DEFECT A's other half: the proposal is validated against `intake.site.brandTokens` — the palette
    // intake fetched with object_get and refused to build a briefing without — not against a site body
    // this stage re-read for itself. There is exactly one place a site palette can enter a clone run.
    validated = validateThemeProposal({ proposal: { colors: themeProposal.colors as Record<string, unknown> | undefined, fonts: themeProposal.fonts as Record<string, unknown> | undefined }, intake });
  } catch (error) {
    throw new CloneRefusal("clone_theme_proposal_empty", error instanceof CloneError || error instanceof Error ? error.message : String(error));
  }

  let plan: CloneThemeApplyPlan;
  try {
    plan = buildThemeApplyPlan({ siteId, themeId, siteRecord: siteBody, themeRecord, applied: validated.applied, missingKeys: validated.missingKeys });
  } catch (error) {
    throw new CloneRefusal("clone_theme_apply_plan_invalid", error instanceof CloneError || error instanceof Error ? error.message : String(error));
  }

  // TOTALITY REFUSAL. buildThemeApplyPlan returns an EMPTY steps array here — nothing has been
  // checked out yet, so there is no lock to release, and this stage refuses without executing any
  // part of the plan. Never backfill a missing key and retry: silently inventing a brand color would
  // be worse than refusing to apply a theme at all.
  if (plan.refusal) {
    throw new CloneRefusal(plan.refusal.reason, `Theme apply refused: ${JSON.stringify(plan.refusal.detail)}`);
  }

  const openLocks = new Map<string, { objectId: string; lockToken: string; recordVersion?: string | number }>();
  try {
    for (const step of plan.steps) {
      const args: Record<string, unknown> = { ...step.arguments };
      // site_apply_theme's own arguments are {site_id, theme_id, dry_run, ...} — it never carries
      // object_type/object_id (its own tool description: it never auto-checkouts) — so the lock its
      // placeholders resolve against is always the SITE lock, inferred from the verb rather than a
      // field that step simply does not have.
      const objectType = typeof args.object_type === "string" ? args.object_type : step.verb === "site_apply_theme" ? "site" : undefined;
      const held = objectType ? openLocks.get(objectType) : undefined;
      if (isCheckoutPlaceholder(args.lock_token)) {
        if (!held) throw new CloneRefusal("clone_theme_apply_lock_missing", `Step "${step.verb}" expected an already-open ${objectType ?? "unknown"} lock, but none was taken.`);
        args.lock_token = held.lockToken;
      }
      if (isCheckoutPlaceholder(args.expected_record_version)) {
        args.expected_record_version = held?.recordVersion;
      }
      const result = await callProjectTool(projectId, step.verb, args, deps);
      // T13.4 LOCK-LEAK FIX. Registration is the very next statement after the wire call returns —
      // nothing computed here can throw before openLocks.set runs. This is what makes the release in
      // `finally` below not depend on any LATER step succeeding: callProjectTool already guarantees
      // (via mcpBoundary's fromWireResult) that a successful object_checkout's result carries
      // `lockToken`, in whichever casing the platform used — or callProjectTool has already thrown
      // and this line never runs, in which case the platform never confirmed a lock and there is
      // nothing to leak. The historical bug was the other order: the OLD code called a tolerant
      // reader that only recognized `lock_token`, found nothing for a real `lockToken` response, and
      // threw BEFORE ever calling openLocks.set — so a lock that genuinely existed server-side was
      // never tracked here to be released. There is no window between "checkout returned" and "this
      // map knows about it" any more.
      if (step.verb === "object_checkout" && objectType && typeof args.object_id === "string") {
        openLocks.set(objectType, { objectId: args.object_id, lockToken: result.lockToken as string, recordVersion: result.recordVersion as string | number | undefined });
      }
      if (step.verb === "object_checkin" && objectType) openLocks.delete(objectType);
    }
  } finally {
    // Belt-and-braces: release any lock this run still holds, even on an error/refusal thrown
    // mid-sequence — a leaked site or theme lock is worse than a failed clone run. Iterating
    // `openLocks` itself (rather than re-deriving from `plan.steps`) is what makes this release NOT
    // depend on any prior step other than the checkout that put the entry there.
    for (const [objectType, held] of openLocks) {
      try {
        await callProjectTool(projectId, "object_checkin", { objectType, objectId: held.objectId, lockToken: held.lockToken }, deps);
      } catch { /* best-effort; the lease expires naturally */ }
    }
  }

  return {
    artifact: CLONE_ARTIFACTS.themeBind,
    summary: `Theme bind for ${projectId}: ${Object.keys(validated.applied.colors).length} color(s) and ${Object.keys(validated.applied.fonts).length} font(s) applied to site ${siteId} via theme ${themeId}; ${validated.dropped.length} token(s) dropped.`,
    siteId,
    themeId,
    applied: validated.applied,
    dropped: validated.dropped,
    before: (siteBody.brandTokens ?? {}) as Record<string, unknown>,
    after: validated.applied,
    substitutions: validated.substitutions,
    published: false,
    policy: clonePolicyView(config)
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: restamp — object_gets the body of every page the briefing names, re-assembles each mint
// survivor's page onto the sections that body actually holds (clone.mjs, pure planner), and executes
// each page's ops under its own checkout/checkin pair. A page whose plan step fails at the wire is
// QUARANTINED, never partially patched; its lock is still released in a finally.
//
// T13.2 (CLONE-INTAKE-FIX.md Defect B): the bodies are FETCHED here and passed to buildRestampOps as
// `pageBodies`, instead of being read out of the intake envelope. The briefing carries page SHAPES —
// an ordered list of section type names — because that is all the AI nodes ever read; full bodies were
// part of the 156,239 chars of source.mapping that starved them. Fetching is also the more correct
// source: this stage restamps what a page holds NOW, not what a mapping said it held when capture ran.
export type CloneRestampEnvelope = {
  artifact: typeof CLONE_ARTIFACTS.restamp;
  summary: string;
  restamped: CloneRestampEntry[];
  skipped: Array<Record<string, unknown>>;
  quarantined: Array<Record<string, unknown>>;
  // T13.4 PART C: buildRestampOps' own re-validated resolution of the adjudicator's section_type
  // choices — the GROUND TRUTH of what this run actually resolved (never adjudication's raw claim).
  // buildCloneReportStep reads both to fold the ledger into the final report; dropping either here
  // (the same "narrow the envelope to what one caller needed" mistake that dropped `substitutions`
  // below) would silently empty the report's substitutions ledger for section_type entries.
  appliedSubstitutions: Array<{ wanted: string; chosen: string }>;
  substitutionRejections: CloneIllegalSubstitution[];
  policy: ClonePolicyView;
};

export async function cloneRestampStep(
  input: { targetProjectId: string; intake: unknown; mint: unknown; adjudication?: unknown },
  deps: CloneDeps = {}
): Promise<CloneRestampEnvelope> {
  const { projectId, config } = await resolveCloneAuthority(input.targetProjectId, deps);
  const intake = assertCloneIntakeEnvelope(input.intake);
  if (intake.target !== projectId) {
    throw new CloneRefusal("clone_target_mismatch", `clone_intake was built for target "${intake.target}", not this run's own target "${projectId}".`);
  }
  // T13.4 PART C — THE SUBTLE NARROWING BUG: this used to read `{ rejected: input.mint.rejected }`
  // alone. buildRestampOps' resolveSectionTypeSubstitutions re-validates a fit_adjudicator choice
  // against `mintReport.substitutions`' own `candidates` — drop `substitutions` here and every
  // choice, however legitimate, fails re-validation as `substitution_not_in_candidates` because there
  // is nothing left to check it against. Both fields are read off `input.mint` (CloneMintEnvelope),
  // which now surfaces `substitutions` at the top level for exactly this reason.
  const mintReport = isRecord(input.mint)
    ? {
        rejected: (input.mint.rejected as Array<{ sourceCandidateIds?: string[] }> | undefined) ?? [],
        substitutions: (input.mint.substitutions as CloneSubstitution[] | undefined) ?? []
      }
    : { rejected: [], substitutions: [] };
  const adjudication = isRecord(input.adjudication) ? (input.adjudication as CloneAdjudication) : undefined;

  const quarantined: Array<Record<string, unknown>> = [];
  // EVERY briefed page is fetched, including one whose recipe was rejected at mint: buildRestampOps
  // checks "no body supplied" BEFORE it checks the rejection, so withholding a fetch to save a call
  // would relabel a `recipe_rejected_at_mint` skip as a `source_page_missing` one — the same page,
  // skipped for a reason that is not true.
  const pageBodies: Array<{ objectId: string; body: Record<string, unknown> }> = [];
  const unreadable = new Set<string>();
  for (const page of intake.pages ?? []) {
    const objectId = typeof page?.objectId === "string" ? page.objectId : "";
    if (!objectId) continue;
    try {
      const pageGet = await callProjectTool(projectId, "object_get", { objectType: "page", objectId }, deps);
      pageBodies.push({ objectId, body: bodyOf(recordOf(pageGet)) });
    } catch (error) {
      // A body this stage could not READ is quarantined under its own reason rather than left to
      // surface as the planner's generic `source_page_missing`: swallowing a transport error into a
      // shape-level skip reason would hide a broken or policy-blocked target behind a ledger that
      // reads like a clean structural decision. It is reported ONCE, here — the planner's redundant
      // entry for the same page is dropped below.
      unreadable.add(objectId);
      quarantined.push({ objectId, reason: "restamp_page_fetch_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  let built: { restamp: CloneRestampEntry[]; skipped: CloneRestampSkip[]; appliedSubstitutions: Array<{ wanted: string; chosen: string }>; substitutionRejections: CloneIllegalSubstitution[] };
  try {
    built = buildRestampOps({ intake, mintReport, pageBodies, adjudication });
  } catch (error) {
    throw new CloneRefusal("clone_restamp_plan_invalid", error instanceof CloneError || error instanceof Error ? error.message : String(error));
  }
  const skipped = built.skipped.filter((entry) => !unreadable.has(entry.objectId));

  const restamped: CloneRestampEntry[] = [];
  for (const page of built.restamp) {
    let lockToken: string | undefined;
    let recordVersion: string | number | undefined;
    try {
      const checkout = await callProjectTool(projectId, "object_checkout", { objectType: "page", objectId: page.objectId }, deps);
      // T13.4 LOCK-LEAK FIX: assigned as the very next statement after the wire call returns, from
      // the canonical field callProjectTool/fromWireResult already guarantees is present for a
      // successful checkout (in whichever casing the platform used) — see the identical comment in
      // cloneThemeBindStep above. `lockToken` stays `undefined` only when the checkout call itself
      // threw, in which case there is genuinely no server-side lock for `finally` to release.
      lockToken = checkout.lockToken as string;
      recordVersion = checkout.recordVersion as string | number | undefined;
      await callProjectTool(projectId, "object_patch", { objectType: "page", objectId: page.objectId, lockToken, expectedRecordVersion: recordVersion, ops: page.ops }, deps);
      restamped.push(page);
    } catch (error) {
      // T15.12 — NAME the lock conflict as its own reason rather than folding it into the generic
      // restamp_patch_failed: callProjectTool has already retried object_checkout, bounded and
      // jittered, before this throws, so a reader seeing restamp_lock_conflict knows retrying the
      // whole run is a reasonable next step — the object was never patched, and never will have been
      // half-patched, because the checkout that would have let this loop write never succeeded.
      const reason = error instanceof CloneLockConflict ? "restamp_lock_conflict" : "restamp_patch_failed";
      quarantined.push({ objectId: page.objectId, reason, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      if (lockToken) {
        try {
          await callProjectTool(projectId, "object_checkin", { objectType: "page", objectId: page.objectId, lockToken }, deps);
        } catch { /* best-effort; the lease expires naturally */ }
      }
    }
  }

  return {
    artifact: CLONE_ARTIFACTS.restamp,
    summary: `Restamp for ${projectId}: ${restamped.length} page(s) restamped, ${skipped.length} skipped, ${quarantined.length} quarantined.`,
    restamped,
    skipped,
    quarantined,
    appliedSubstitutions: built.appliedSubstitutions,
    substitutionRejections: built.substitutionRejections,
    policy: clonePolicyView(config)
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: publish_payload — the object-scoped report the shared publishing tail's publish_payload
// node (composeWorkflowNodes, cloneConductorRoutes.ts) turns into an object_publish_plan.v1 via
// workspace/objectPublishExecution.ts's buildObjectPublishPlan. THE SAME shape capture's own
// publish_payload stage builds (there, straight from capture_emit_live's single emission report);
// here it is ASSEMBLED from three separate stage envelopes (mint/theme_bind/restamp) because clone's
// authoring is three deterministic writes, not one emission pass.
//
// T15.10 (#189, ADR-2026-08-25-publish-autonomy §6.2): clone's publish_payload binds
// [recipe_mint, theme_bind, layout_restamp] — this function is that binding, expressed as one
// ObjectPublishSourceReport-shaped object so buildObjectPublishPlan needs to know nothing about
// clone specifically.
export type CloneObjectPublishSourceReport = {
  target: string;
  createdObjects: Array<{ objectType: string; objectId: string }>;
  reusedObjects: Array<{ objectType: string; objectId: string }>;
  validationStates: Array<{ objectId: string; phase: string; valid: boolean; reason?: string | null }>;
  quarantines: Array<{ objectId: string; reason: string; detail?: string | null }>;
};

export function buildCloneObjectPublishReport(input: {
  target: string;
  intake: CloneIntakeEnvelope;
  mint: CloneMintEnvelope;
  themeBind: CloneThemeBindEnvelope;
  restamp: CloneRestampEnvelope;
}): CloneObjectPublishSourceReport {
  const { target, intake, mint, themeBind, restamp } = input;
  const siteId = typeof intake.site?.objectId === "string" ? intake.site.objectId : undefined;
  const themeId = typeof intake.theme?.objectId === "string" ? intake.theme.objectId : undefined;
  // Same condition buildCloneRunReport's own reviewQueue uses for the site row: a proposal that was
  // entirely dropped changed nothing, so there is nothing new here for publish_payload to plan either.
  const themeTokensApplied = Object.keys(themeBind.applied?.colors ?? {}).length + Object.keys(themeBind.applied?.fonts ?? {}).length;

  // Minted recipes (section_template / template — "page template" on the wire; see
  // publishableTypeCharter.ts). draftVerified mirrors capture_emit_live's own postcreate signal: the
  // object was created and confirmed still unpublished, i.e. a clean draft to hand publish_executor.
  const createdObjects: Array<{ objectType: string; objectId: string }> = mint.applied.map((row) => ({ objectType: row.objectType, objectId: row.objectId }));
  const validationStates: Array<{ objectId: string; phase: string; valid: boolean; reason?: string | null }> = mint.applied.map((row) => ({
    objectId: row.objectId,
    phase: "postcreate",
    valid: row.draftVerified === true,
    reason: row.draftVerified === true ? null : "clone_mint_draft_verification_failed"
  }));

  // The bound theme, and the site it was applied to — ADR §6.2's "the bound theme". Both are real
  // candidates only when this run actually wrote tokens onto them.
  if (themeTokensApplied > 0) {
    if (themeId) {
      createdObjects.push({ objectType: "theme", objectId: themeId });
      validationStates.push({ objectId: themeId, phase: "postpatch", valid: true });
    }
    if (siteId) {
      createdObjects.push({ objectType: "site", objectId: siteId });
      validationStates.push({ objectId: siteId, phase: "postpatch", valid: true });
    }
  }

  // Restamped pages are named as candidates too — NOT because clone is chartered to publish them
  // (publishableTypeCharter.ts carries no "page" entry for clone_conductor: structure-studio ADR
  // §2.1, a page is evidence of a structure, never the studio's own product) but so
  // buildObjectPublishPlan withholds them EXPLICITLY, with reason "type_not_publishable", rather than
  // the ledger falling silent about a page this run did in fact write. Silence about a withheld
  // object is the same defect wearing a different hat (ADR §3, carried from publish.mjs).
  for (const page of restamp.restamped) {
    if (typeof page.objectId !== "string" || !page.objectId) continue;
    createdObjects.push({ objectType: "page", objectId: page.objectId });
    validationStates.push({ objectId: page.objectId, phase: "postpatch", valid: true });
  }

  const quarantines = restamp.quarantined.flatMap((entry) => {
    const objectId = typeof entry.objectId === "string" ? entry.objectId : undefined;
    if (!objectId) return [];
    return [{ objectId, reason: typeof entry.reason === "string" ? entry.reason : "restamp_quarantined", detail: typeof entry.detail === "string" ? entry.detail : null }];
  });

  return { target, createdObjects, reusedObjects: [], validationStates, quarantines };
}

// ---------------------------------------------------------------------------------------------
// Stage: library deposit — T15.31 (#207; ADR-2026-08-25-structure-studio §4.1): "the studio's
// publish step deposits there [the cross-tenant library] in addition to the minting tenant." Runs
// AFTER publish_executor (cloneConductorRoutes.ts's "publish_executor" case calls this once
// executeObjectPublish has returned), so only recipes that actually WENT LIVE in the minting tenant
// — never a draft that was rejected, withheld, or never reached publish — become library candidates
// (buildTemplateDepositCandidates enforces this by checking membership in `published`, not `applied`).
//
// TENANCY SEAM: this is the ONLY write path in this file that reaches outside the minting tenant's
// own object store — everything else in cloneEngine.ts writes exclusively to `targetProjectId`. The
// library store itself (templateLibraryStore.ts) is keyed by templateId, never by project, which is
// what makes it cross-tenant. Per-tenant CLIENT MEMORY (§5.2) is #208's own terminal-stage write and
// does not belong here.
//
// NEVER FATAL to the run: one candidate's unstateable provenance (or any other library refusal) is
// recorded by name in the returned ledger's `refused` array — it does not throw, and it does not
// stop the rest of the batch, the same "one bad item doesn't abort the batch" discipline recipe_mint
// and buildRecipeMintPlan already hold. A recipe that went live in its own tenant stays live either
// way; the library is additive, never a gate on the tenant's own publish.
export type LibraryDepositLedger = {
  deposited: Array<{ templateId: string; version: number; objectId: string }>;
  unchanged: Array<{ templateId: string; version: number; objectId: string }>;
  refused: Array<{ objectId: string; requestedId: string; code: string; reason: string }>;
};

export async function depositPublishedTemplatesStep(
  input: {
    sourceProjectId: string;
    // T15.30 (#206; ADR-2026-08-25-structure-studio §3, §4.1) — which entry produced the recipes
    // being deposited. "clone" REQUIRES captureRunId (sourceUrl is then resolved from that run's own
    // capture_crawl stage, exactly as before); "demand" carries no captureRunId at all and
    // `sourceUrl` — when the structureBrief that drove the run stated one — is supplied directly by
    // the caller instead (read off clone_intake's own `sourceUrl` field). Neither branch fabricates
    // the other's source of truth: a demand-driven deposit never borrows a captureRunId, and a
    // clone-driven deposit never guesses a sourceUrl the capture run didn't itself resolve.
    driven: "clone" | "demand";
    captureRunId?: string;
    sourceUrl?: string;
    // `plan` is Partial here (not CloneMintEnvelope's own required shape) — some existing run
    // fixtures/mocks in this codebase carry `applied` without a `plan`, and this stage must degrade
    // to "nothing to deposit" rather than assume every caller populates it.
    mint: Pick<CloneMintEnvelope, "applied"> & { plan?: Partial<Pick<CloneMintPlan, "creates">> };
    publishedObjects: Array<{ objectType: string; objectId: string }>;
  },
  deps: CloneDeps = {}
): Promise<LibraryDepositLedger> {
  const ledger: LibraryDepositLedger = { deposited: [], unchanged: [], refused: [] };
  const candidates = buildTemplateDepositCandidates({
    sourceProjectId: input.sourceProjectId,
    mintApplied: input.mint.applied,
    // `plan` is optional here by construction — a run whose recipe_mint predates this field, or a
    // fixture/mock that never populated it, must still report zero deposit candidates rather than
    // throw. buildTemplateDepositCandidates already treats "no matching plan.creates entry" as a
    // per-candidate skip (never a partial deposit), so an absent plan is just the degenerate case of
    // that same rule — every row in `applied` skips for want of a body to deposit.
    mintCreates: input.mint.plan?.creates ?? [],
    publishedObjects: input.publishedObjects
  });
  if (candidates.length === 0) return ledger;

  // CLONE-DRIVEN: fetched ONCE per deposit batch, not per candidate — the same capture run backs
  // every recipe this clone run minted. Absence is itself a valid, honest outcome (every candidate
  // below is refused with the SAME named reason, never silently skipped) rather than a thrown error
  // that would also hide however many candidates already had a coherent provenance to state.
  // DEMAND-DRIVEN: no capture run exists to read a sourceUrl from — the caller's own `sourceUrl`
  // (clone_intake's `sourceUrl`, stated by the structureBrief or left `null`) is used as-is; a
  // demand-driven run whose brief never named one deposits nothing (every candidate refuses
  // `template_provenance_unstateable`, named per-candidate below, never fatally).
  let sourceUrl = input.sourceUrl;
  if (input.driven === "clone" && input.captureRunId) {
    const captureRun = await executionsOf(deps).getRun(input.captureRunId);
    const crawlOut = captureRun ? stageOutput(captureRun, "capture_crawl") : undefined;
    sourceUrl = typeof crawlOut?.sourceUrl === "string" && crawlOut.sourceUrl.trim() ? crawlOut.sourceUrl.trim() : sourceUrl;
  }

  const store = templateLibraryOf(deps);
  for (const candidate of candidates) {
    try {
      const result: { outcome: "minted" | "unchanged"; record: TemplateLibraryRecord } = await store.publish({
        templateId: candidate.templateId,
        objectType: candidate.objectType,
        name: candidate.name,
        recipe: candidate.recipe,
        sourceProjectId: input.sourceProjectId,
        provenance:
          input.driven === "clone"
            ? { sourceUrl, captureRunId: input.captureRunId, driven: "clone" }
            : { sourceUrl, driven: "demand" }
      });
      const row = { templateId: result.record.templateId, version: result.record.version, objectId: candidate.objectId };
      if (result.outcome === "minted") ledger.deposited.push(row);
      else ledger.unchanged.push(row);
    } catch (error) {
      const refusal = error instanceof TemplateLibraryRefusal
        ? { code: error.code, reason: error.message }
        : { code: "template_deposit_failed", reason: error instanceof Error ? error.message : String(error) };
      ledger.refused.push({ objectId: candidate.objectId, requestedId: candidate.requestedId, ...refusal });
    }
  }
  return ledger;
}

// ---------------------------------------------------------------------------------------------
// Stage: report (pure assembly — the workflow's terminal REPORT over what the whole run, including
// the shared publishing tail, did). No wire calls of its own.
export type CloneRunReportEnvelope = {
  artifact: typeof CLONE_ARTIFACTS.report;
  summary: string;
  mint: unknown;
  theme: unknown;
  restamp: unknown;
  // T13.4 PART B/C: the whole-run substitution ledger, folding mint's/theme's own entries with
  // fit_adjudicator's RE-VALIDATED resolution (never its raw claim) — see buildCloneRunReport's own
  // doc comment. Surfaced here as its own top-level field, never buried inside `mint`/`theme`/
  // `restamp`, exactly as PART B item 4 requires.
  substitutions: CloneSubstitution[];
  capabilityBacklog: Record<string, unknown[]>;
  // T15.33 (#209; ADR-2026-08-25-structure-studio §6.3) — the SAME capabilityBacklog map, turned
  // into a structured, evidenced request per missing section type (capabilityBacklogRequest.ts's
  // buildCapabilityRequests: pure, deterministic, never re-judged here). Steps 1+2 of the ADR's loop
  // ("the unmet need recorded with evidence"; "a structured capability request naming the proposed
  // section type, its fields, and the evidence"). Steps 3/4 (a human initiates the platform release;
  // the type appears in REGISTERED_SECTION_TYPES) are outside this workflow by design — ADR §6.4.
  capabilityRequests: CapabilityRequest[];
  reviewQueue: Array<Record<string, unknown>>;
  humanSummary: string;
  // T15.10 (#189, ADR-2026-08-25-publish-autonomy §6.2, ADR-2026-08-25-structure-studio §1) — was
  // `humanGate: { publishedByThisRun: false, note: "..." }`, unconditionally, because nothing
  // upstream of the vendored engine could publish. That is no longer true: clone_conductor composes
  // the shared publishing tail, so this block reports what the TAIL actually did — mirroring
  // capture_run_report.v1's own `publication` field (captureEngine.ts) exactly, including its
  // `attempted:false` honesty case for a run whose publish_executor never ran (operator veto, policy
  // gate, or an upstream controller no-go).
  publication: {
    attempted: boolean;
    published: unknown[];
    failed: unknown[];
    withheld: unknown[];
    release: Record<string, unknown> | null;
    note: string;
  };
  // T15.31 (#207) — the cross-tenant library deposits this run's publish_executor stage already
  // performed, read back verbatim (never re-derived) exactly as `publication` reads publish_executor's
  // own record. Absent (rather than an empty ledger) when publish_executor never ran or deposited
  // nothing to read, so a reader can tell "nothing was published" apart from "nothing to report".
  library?: LibraryDepositLedger;
  // T15.34 (#210; ADR-2026-08-25-structure-studio §7) — DELIBERATELY separate from `publication`
  // and `library` above: a pdf_template is not a CMS governed object, pdf_template_publish never
  // composes the shared publishing tail, and a pdf_template "published" means live in pdf-tool's own
  // store, never a CMS site release. Absent when this run briefed no pdf template at all (not an
  // empty ledger), so a reader can tell "no pdf-template work this run" apart from "briefed and
  // nothing survived".
  pdfTemplates?: {
    intake: { entries: number; rejectedEntries: unknown[] };
    mint: { applied: unknown[]; rejected: unknown[] };
    publish: { published: unknown[]; failed: unknown[] };
    library?: LibraryDepositLedger;
  };
};

export function buildCloneReportStep(input: {
  intake: CloneIntakeEnvelope;
  mint: CloneMintEnvelope;
  themeBind: CloneThemeBindEnvelope;
  restamp: CloneRestampEnvelope;
  design?: Record<string, unknown>;
  adjudication?: unknown;
  /** The shared tail's publish_execution.v1 record, when publish_executor ran. Absent = it was
   * refused (operator veto, autonomy policy gate, or an upstream controller no-go) or has not run yet. */
  publishExecution?: Record<string, unknown>;
  /** The shared tail's release_execution.v1 record, when release_executor ran. */
  releaseExecution?: Record<string, unknown>;
  /** T15.33 (#209) — this run's own id, stated on every capabilityRequests evidence row when the
   *  caller has one (cloneConductorRoutes.ts's dispatch does). Optional and defaulted to `null`
   *  rather than required, so this function stays callable from a unit test or a fixture with no run
   *  behind it at all. */
  runId?: string;
  // T15.34 (#210) — the pdf-template branch's own stage outputs, read back verbatim exactly as
  // publishExecution/releaseExecution are. All three are optional/tolerant: a run that briefed no
  // pdf template still reaches this node normally (see cloneConductorNodes.ts's clone_report header).
  pdfTemplateIntake?: Record<string, unknown>;
  pdfTemplateMint?: Record<string, unknown>;
  pdfTemplatePublish?: Record<string, unknown>;
  pdfTemplateLibrary?: LibraryDepositLedger;}): CloneRunReportEnvelope {
  // T15.31 (#207) — read back, never re-derived: publish_executor's own dispatch
  // (cloneConductorRoutes.ts) stamps `library` onto publish_execution.v1 exactly as it stamps
  // `objectPublish`, right below.
  const libraryLedger = isRecord(input.publishExecution?.library) ? (input.publishExecution!.library as unknown as LibraryDepositLedger) : undefined;
  const adjudication = isRecord(input.adjudication) ? (input.adjudication as CloneAdjudication) : undefined;
  let report: ReturnType<typeof buildCloneRunReport>;
  try {
    report = buildCloneRunReport({
      intake: input.intake,
      // T13.4 PART C — THE SAME NARROWING BUG, a second site: this used to read
      // `{ createdObjects: input.mint.applied }` alone, which drops `mint.substitutions` just as
      // cloneRestampStep's own narrowing did (see the comment there) — and `{ restamp:
      // input.restamp.restamped }` alone, which drops restamp's `appliedSubstitutions` /
      // `substitutionRejections`, the GROUND TRUTH of what this run actually resolved that
      // buildCloneRunReport needs to fold the ledger correctly. `themeReport: input.themeBind` was
      // already the whole envelope (unnarrowed) and stays that way.
      mintReport: { createdObjects: input.mint.applied, substitutions: input.mint.substitutions },
      themeReport: input.themeBind,
      restampReport: { restamp: input.restamp.restamped, appliedSubstitutions: input.restamp.appliedSubstitutions, substitutionRejections: input.restamp.substitutionRejections },
      design: input.design ?? {},
      adjudication
    });
  } catch (error) {
    throw new CloneRefusal("clone_report_invalid", error instanceof CloneError || error instanceof Error ? error.message : String(error));
  }

  // T15.10 — what actually went live, read from the shared tail's OWN records, never re-derived or
  // guessed. objectPublish is the custom field clone's publish_executor dispatch
  // (cloneConductorRoutes.ts) stamps onto the shared publish_execution.v1 shape, mirroring capture's.
  const objectPublish = isRecord(input.publishExecution?.objectPublish) ? (input.publishExecution!.objectPublish as Record<string, unknown>) : undefined;
  const releaseExecution = isRecord(input.releaseExecution) ? input.releaseExecution : undefined;
  const publication: CloneRunReportEnvelope["publication"] = objectPublish
    ? {
        attempted: true,
        published: Array.isArray(objectPublish.published) ? objectPublish.published : [],
        failed: Array.isArray(objectPublish.failed) ? objectPublish.failed : [],
        withheld: Array.isArray(objectPublish.withheld) ? objectPublish.withheld : [],
        release: releaseExecution
          ? { status: releaseExecution.status, releaseId: releaseExecution.releaseId, deployedSha: releaseExecution.deployedSha, verification: releaseExecution.verification }
          : null,
        note: "clone_conductor (the structure studio) publishes by default (T15.10: through the shared publishing tail's publish_executor/release_executor — the same machinery every workflow uses). A minted recipe, the bound theme, or the site singleton went live when this run's own validation of it passed and nothing quarantined it and its type is inside the studio's charter (publishableTypeCharter.ts); a restamped page stays a draft even on success — clone is not chartered to publish pages, only structure. Everything held back is named above with its reason. trigger_netlify_build and deploy remain unreachable from every clone path."
      }
    : {
        attempted: false,
        published: [],
        failed: [],
        withheld: [],
        release: null,
        note: "The tail's publish_executor did not run or was refused for this run (operator veto, the project's autonomy policy, or an upstream controller no-go), so everything this run wrote is still an unreleased draft. The run record's publish_executor node carries the refusal code."
      };

  // T15.34 (#210) — assembled ONLY when this run actually did pdf-template work (an intake envelope
  // is present and named at least one entry, whether or not any survived to mint/publish) — a run
  // that briefed no pdf template gets `pdfTemplates` absent entirely, per this envelope's own field
  // comment, never an all-zeros ledger that reads as "we tried and everything failed".
  const pdfIntake = isRecord(input.pdfTemplateIntake) ? input.pdfTemplateIntake : undefined;
  const pdfMint = isRecord(input.pdfTemplateMint) ? input.pdfTemplateMint : undefined;
  const pdfPublish = isRecord(input.pdfTemplatePublish) ? input.pdfTemplatePublish : undefined;
  const pdfTemplates: CloneRunReportEnvelope["pdfTemplates"] =
    pdfIntake && Array.isArray(pdfIntake.entries) && (pdfIntake.entries.length > 0 || (Array.isArray(pdfIntake.rejectedEntries) && pdfIntake.rejectedEntries.length > 0))
      ? {
          intake: { entries: pdfIntake.entries.length, rejectedEntries: Array.isArray(pdfIntake.rejectedEntries) ? pdfIntake.rejectedEntries : [] },
          mint: { applied: Array.isArray(pdfMint?.applied) ? pdfMint!.applied : [], rejected: Array.isArray(pdfMint?.rejected) ? pdfMint!.rejected : [] },
          publish: { published: Array.isArray(pdfPublish?.published) ? pdfPublish!.published : [], failed: Array.isArray(pdfPublish?.failed) ? pdfPublish!.failed : [] },
          ...(input.pdfTemplateLibrary ? { library: input.pdfTemplateLibrary } : {})
        }
      : undefined;

  const humanSummary = `Clone run for ${input.intake.target}: ${report.reviewQueue.length} object(s) to review (${input.mint.applied.length} recipe(s) minted, ${input.mint.reused.length} reused, ${input.mint.rejected.length} rejected; ${input.restamp.restamped.length} page(s) restamped, ${input.restamp.skipped.length} skipped, ${input.restamp.quarantined.length} quarantined; theme ${Object.keys(input.themeBind.applied.colors).length + Object.keys(input.themeBind.applied.fonts).length} token(s) applied). ${publication.attempted ? `Publication: ${publication.published.length} object(s) LIVE, ${publication.withheld.length} withheld (named below with reasons).` : "Publication was not attempted on this run (see the publication block for why); everything written is still a draft."}${pdfTemplates ? ` PDF templates (a SEPARATE ledger, not a CMS release): ${pdfTemplates.publish.published.length} published to pdf-tool, ${pdfTemplates.mint.rejected.length + pdfTemplates.intake.rejectedEntries.length + pdfTemplates.publish.failed.length} withheld/rejected (named in pdfTemplates with their reasons).` : ""}`;

  // T15.33 (#209; ADR §6.3) — sourceUrl is intake's OWN stated value (populated on a demand-driven
  // run from the structureBrief; `undefined` on a clone-driven run at intake time — this stage does
  // not re-resolve it from the capture run the way depositPublishedTemplatesStep does, so a
  // clone-driven request states `sourceUrl: null` here rather than a value this stage never actually
  // read). Honest-absence, never a guessed URL.
  const intakeSourceUrl = typeof input.intake.sourceUrl === "string" && input.intake.sourceUrl.trim() ? input.intake.sourceUrl.trim() : null;
  const capabilityRequests = buildCapabilityRequests(report.capabilityBacklog, { sourceUrl: intakeSourceUrl, runId: input.runId ?? null });

  return {
    artifact: CLONE_ARTIFACTS.report,
    summary: `Clone run report for ${input.intake.target}: ${report.reviewQueue.length} reviewable object(s), ${Object.keys(report.capabilityBacklog).length} capability gap group(s).`,
    mint: report.mint,
    theme: report.theme,
    restamp: report.restamp,
    substitutions: report.substitutions,
    capabilityBacklog: report.capabilityBacklog,
    capabilityRequests,
    reviewQueue: report.reviewQueue,
    humanSummary,
    publication,
    ...(libraryLedger ? { library: libraryLedger } : {}),
    ...(pdfTemplates ? { pdfTemplates } : {})
  };
}

// Test-only seam, following captureEngine's __test__ precedent: the guarded transport (with its
// pre-transport forbidden-verb and policy refusals) is internal to callProjectTool but its refusal
// semantics are load-bearing and test-pinned.
export const __test__ = { callProjectTool, resolveEmittedThemeId, FORBIDDEN_VERBS };
