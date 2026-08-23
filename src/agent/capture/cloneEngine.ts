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
//   - Validation failures quarantine or skip, never loosen: a rejected recipe design stays rejected
//     (never coerced into something that would validate), and a page whose recipe was rejected at
//     mint is SKIPPED at restamp — never half-restamped.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { effectiveToolPermission, type ProjectConnectionConfig, type ToolPermission } from "../projects/projectTypes.js";
import { findLockToken } from "../projects/toolResultSearch.js";
import { findRecordVersion } from "../projects/objectDialect.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import { describeMcpErrorResult } from "./captureEngine.js";
import {
  buildCloneIntake,
  buildCloneRunReport,
  buildRecipeMintPlan,
  buildRestampOps,
  buildThemeApplyPlan,
  CloneError,
  validateThemeProposal,
  type CloneIntake,
  type CloneMintPlan,
  type CloneRestampEntry,
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

export type CloneDeps = { projectRepository?: ProjectRepository; executionRepository?: ExecutionRepository };
const projectsOf = (deps: CloneDeps = {}): ProjectRepository => deps.projectRepository ?? repositoryManager.getProjectRepository();
const executionsOf = (deps: CloneDeps = {}): ExecutionRepository => deps.executionRepository ?? repositoryManager.getExecutionRepository();

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
async function callProjectTool(projectId: string, tool: string, args: Record<string, unknown>, deps: CloneDeps = {}): Promise<Record<string, unknown>> {
  if (FORBIDDEN_VERBS.has(tool)) throw new CloneRefusal("forbidden_verb", `Forbidden clone verb: ${tool}. object_publish / release_to_production / trigger_netlify_build / deploy are unreachable from clone_conductor.`);
  const config = await projectsOf(deps).get(projectId);
  if (!config) throw new CloneRefusal("unknown_project", `Unknown projectId: ${projectId}`);
  const adapter = new ProjectMcpAdapter(config);
  const call = await adapter.callTool(tool, args);
  if (!call.ok) throw new CloneRefusal("project_tool_call_failed", `${tool} on ${projectId} failed: ${call.error ?? "unknown error"}`);
  const raw = call.result as Record<string, unknown> | undefined;
  if (isRecord(raw) && raw.isError) {
    throw new CloneRefusal("project_tool_call_failed", `${tool} on ${projectId} returned an MCP error result: ${describeMcpErrorResult(raw)}`);
  }
  const structured = isRecord(raw) && isRecord(raw.structuredContent) ? (raw.structuredContent as Record<string, unknown>) : (isRecord(raw) ? raw : {});
  return isRecord(structured.data) ? (structured.data as Record<string, unknown>) : structured;
}

const stageOutput = (run: { stageOutputs: Record<string, unknown> }, nodeId: string): Record<string, unknown> | undefined => {
  const value = run.stageOutputs[nodeId];
  return isRecord(value) ? value : undefined;
};

// ---------------------------------------------------------------------------------------------
// Stage: intake — resolves the finished capture run's artifacts plus the target's CURRENT inventory
// and LIVE registries, and builds the clone-intake.v1 workspace envelope (clone.mjs, pure).
export type CloneIntakeEnvelope = CloneIntake & { artifact: typeof CLONE_ARTIFACTS.intake; summary: string; policy: ClonePolicyView };

const isCloneIntakeEnvelope = (value: unknown): value is CloneIntakeEnvelope => isRecord(value) && value.artifact === CLONE_ARTIFACTS.intake;

export function assertCloneIntakeEnvelope(value: unknown): CloneIntakeEnvelope {
  if (!isCloneIntakeEnvelope(value)) {
    throw new CloneRefusal("clone_upstream_artifact_invalid", `Expected clone_intake's stage output to be a ${CLONE_ARTIFACTS.intake} envelope; found ${isRecord(value) ? `artifact "${String(value.artifact)}"` : "nothing"}. A placeholder or malformed upstream artifact is never built upon.`);
  }
  return value;
}

const INVENTORY_TYPES = ["page", "template", "section_template", "theme", "navigation", "site"] as const;

export async function cloneIntakeStep(input: { targetProjectId: string; captureRunId: string }, deps: CloneDeps = {}): Promise<CloneIntakeEnvelope> {
  const { projectId, config } = await resolveCloneAuthority(input.targetProjectId, deps);
  const captureRunId = typeof input.captureRunId === "string" ? input.captureRunId.trim() : "";
  if (!captureRunId) throw new CloneRefusal("clone_source_run_missing", "A captureRunId is required; clone_intake needs a finished capture run to clone from.");

  const captureRun = await executionsOf(deps).getRun(captureRunId);
  if (!captureRun) throw new CloneRefusal("clone_source_run_missing", `No run found for captureRunId ${captureRunId}.`);
  if (typeof captureRun.projectId === "string" && captureRun.projectId.trim() && captureRun.projectId.trim() !== projectId) {
    throw new CloneRefusal("clone_source_run_project_mismatch", `Capture run ${captureRunId} belongs to project "${captureRun.projectId}", not this clone run's own target "${projectId}"; a clone may never graft one tenant's captured content onto another's site.`);
  }

  const crawlOut = stageOutput(captureRun, "capture_crawl");
  const mapOut = stageOutput(captureRun, "capture_map_refine") ?? stageOutput(captureRun, "capture_map");
  const themeOut = stageOutput(captureRun, "capture_theme");
  const emitOut = stageOutput(captureRun, "capture_emit_live");
  if (!crawlOut || !isRecord(crawlOut.snapshot)) {
    throw new CloneRefusal("clone_source_snapshot_missing", `Capture run ${captureRunId} carries no capture_crawl snapshot; there is nothing to clone from.`);
  }
  if (!mapOut || !isRecord(mapOut.mapping)) {
    throw new CloneRefusal("clone_source_mapping_missing", `Capture run ${captureRunId} carries neither a capture_map nor a capture_map_refine mapping.`);
  }

  const componentRegistry = await callProjectTool(projectId, "registry_get", { registry: "component" }, deps);
  const pageTypeRegistry = await callProjectTool(projectId, "registry_get", { registry: "page_type" }, deps);
  const inventory: Record<string, unknown[]> = {};
  for (const objectType of INVENTORY_TYPES) {
    const rows = await callProjectTool(projectId, "object_inventory", { object_type: objectType }, deps);
    inventory[objectType] = Array.isArray(rows.objects) ? (rows.objects as unknown[]) : [];
  }

  let intake: CloneIntake;
  try {
    intake = buildCloneIntake({
      captureRunId,
      target: projectId,
      snapshot: crawlOut.snapshot,
      mapping: mapOut.mapping,
      theme: themeOut?.theme ?? null,
      emissionReport: emitOut?.report ?? null,
      inventory,
      componentRegistry,
      pageTypeRegistry,
      policy: clonePolicyView(config)
    });
  } catch (error) {
    if (error instanceof CloneError) throw new CloneRefusal("clone_intake_invalid", error.message);
    throw error;
  }

  return {
    ...intake,
    artifact: CLONE_ARTIFACTS.intake,
    summary: `Clone intake assembled for ${projectId} from capture run ${captureRunId}: ${intake.emitted.pages.length} emitted page(s), ${Object.keys(intake.registry.sectionTypes).length} registered section type(s), ${Object.keys(intake.registry.pageTypes).length} page type(s).`,
    policy: clonePolicyView(config)
  };
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
      const result = await callProjectTool(projectId, create.verb, { object_type: create.objectType, requested_id: create.requestedId, body: create.body }, deps);
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
  published: false;
  policy: ClonePolicyView;
};

const siteObjectIdOf = (siteRow: Record<string, unknown>): string | undefined => {
  const value = siteRow.object_id ?? siteRow.objectId;
  return typeof value === "string" && value ? value : undefined;
};

// The already-emitted theme object's id, correlated from the capture run's OWN emission report the
// same way clone.mjs's pagesEmitted() correlates pages: the report's `creates` entry for objectType
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

  const siteId = siteObjectIdOf(intake.inventory.site);
  if (!siteId) throw new CloneRefusal("clone_site_missing", "clone_intake's inventory carries no active site object id.");
  const themeId = resolveEmittedThemeId(intake.emitted.report);
  if (!themeId) throw new CloneRefusal("clone_theme_missing", "No theme object was found in the capture run's emission report; theme_bind needs the theme capture already created to write its reconciled tokens onto.");

  const themeProposal = isRecord(input.themeProposal) ? input.themeProposal : {};
  const siteGet = await callProjectTool(projectId, "object_get", { object_type: "site", object_id: siteId }, deps);
  const siteRecord = isRecord(siteGet.record) ? (siteGet.record as Record<string, unknown>) : siteGet;
  const siteBody = (isRecord(siteRecord.body) ? (siteRecord.body as Record<string, unknown>) : siteRecord) as Record<string, unknown> & { brandTokens: { colors?: Record<string, unknown>; fonts?: Record<string, unknown> } };
  const themeGet = await callProjectTool(projectId, "object_get", { object_type: "theme", object_id: themeId }, deps);
  const themeRecord = isRecord(themeGet.record) ? (themeGet.record as Record<string, unknown>) : themeGet;

  let validated: ReturnType<typeof validateThemeProposal>;
  try {
    validated = validateThemeProposal({ proposal: { colors: themeProposal.colors as Record<string, unknown> | undefined, fonts: themeProposal.fonts as Record<string, unknown> | undefined }, siteBody });
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
      if (step.verb === "object_checkout" && objectType && typeof args.object_id === "string") {
        const lockToken = findLockToken(result);
        if (!lockToken) throw new CloneRefusal("clone_theme_apply_checkout_failed", `object_checkout(${objectType}) returned no lock_token.`);
        openLocks.set(objectType, { objectId: args.object_id, lockToken, recordVersion: findRecordVersion(result) });
      }
      if (step.verb === "object_checkin" && objectType) openLocks.delete(objectType);
    }
  } finally {
    // Belt-and-braces: release any lock this run still holds, even on an error/refusal thrown
    // mid-sequence — a leaked site or theme lock is worse than a failed clone run.
    for (const [objectType, held] of openLocks) {
      try {
        await callProjectTool(projectId, "object_checkin", { object_type: objectType, object_id: held.objectId, lock_token: held.lockToken }, deps);
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
    published: false,
    policy: clonePolicyView(config)
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: restamp — re-assembles each mint survivor's pages onto the captured section list
// (clone.mjs, pure planner) and executes each page's ops under its own checkout/checkin pair. A page
// whose plan step fails at the wire is QUARANTINED, never partially patched; its lock is still
// released in a finally.
export type CloneRestampEnvelope = {
  artifact: typeof CLONE_ARTIFACTS.restamp;
  summary: string;
  restamped: CloneRestampEntry[];
  skipped: Array<Record<string, unknown>>;
  quarantined: Array<Record<string, unknown>>;
  policy: ClonePolicyView;
};

export async function cloneRestampStep(input: { targetProjectId: string; intake: unknown; mint: unknown }, deps: CloneDeps = {}): Promise<CloneRestampEnvelope> {
  const { projectId, config } = await resolveCloneAuthority(input.targetProjectId, deps);
  const intake = assertCloneIntakeEnvelope(input.intake);
  if (intake.target !== projectId) {
    throw new CloneRefusal("clone_target_mismatch", `clone_intake was built for target "${intake.target}", not this run's own target "${projectId}".`);
  }
  const mintReport = isRecord(input.mint) ? { rejected: (input.mint.rejected as Array<{ sourceCandidateIds?: string[] }> | undefined) ?? [] } : { rejected: [] };

  let built: { restamp: CloneRestampEntry[]; skipped: Array<Record<string, unknown>> };
  try {
    built = buildRestampOps({ intake, mintReport });
  } catch (error) {
    throw new CloneRefusal("clone_restamp_plan_invalid", error instanceof CloneError || error instanceof Error ? error.message : String(error));
  }

  const restamped: CloneRestampEntry[] = [];
  const quarantined: Array<Record<string, unknown>> = [];
  for (const page of built.restamp) {
    let lockToken: string | undefined;
    let recordVersion: string | number | undefined;
    try {
      const checkout = await callProjectTool(projectId, "object_checkout", { object_type: "page", object_id: page.objectId }, deps);
      lockToken = findLockToken(checkout);
      recordVersion = findRecordVersion(checkout);
      if (!lockToken) throw new CloneRefusal("clone_restamp_checkout_failed", `object_checkout(page ${page.objectId}) returned no lock_token.`);
      await callProjectTool(projectId, "object_patch", { object_type: "page", object_id: page.objectId, lock_token: lockToken, expected_record_version: recordVersion, ops: page.ops }, deps);
      restamped.push(page);
    } catch (error) {
      quarantined.push({ objectId: page.objectId, reason: "restamp_patch_failed", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      if (lockToken) {
        try {
          await callProjectTool(projectId, "object_checkin", { object_type: "page", object_id: page.objectId, lock_token: lockToken }, deps);
        } catch { /* best-effort; the lease expires naturally */ }
      }
    }
  }

  return {
    artifact: CLONE_ARTIFACTS.restamp,
    summary: `Restamp for ${projectId}: ${restamped.length} page(s) restamped, ${built.skipped.length} skipped, ${quarantined.length} quarantined.`,
    restamped,
    skipped: built.skipped,
    quarantined,
    policy: clonePolicyView(config)
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: report (pure assembly — the workflow's END; the human gate begins here). No wire calls.
export type CloneRunReportEnvelope = {
  artifact: typeof CLONE_ARTIFACTS.report;
  summary: string;
  mint: unknown;
  theme: unknown;
  restamp: unknown;
  capabilityBacklog: Record<string, unknown[]>;
  reviewQueue: Array<Record<string, unknown>>;
  humanSummary: string;
  humanGate: { publishedByThisRun: false; note: string };
};

export function buildCloneReportStep(input: {
  intake: CloneIntakeEnvelope;
  mint: CloneMintEnvelope;
  themeBind: CloneThemeBindEnvelope;
  restamp: CloneRestampEnvelope;
  design?: Record<string, unknown>;
}): CloneRunReportEnvelope {
  let report: ReturnType<typeof buildCloneRunReport>;
  try {
    report = buildCloneRunReport({
      intake: input.intake,
      mintReport: { createdObjects: input.mint.applied },
      themeReport: input.themeBind,
      restampReport: { restamp: input.restamp.restamped },
      design: input.design ?? {}
    });
  } catch (error) {
    throw new CloneRefusal("clone_report_invalid", error instanceof CloneError || error instanceof Error ? error.message : String(error));
  }

  const humanSummary = `Clone run for ${input.intake.target}: ${report.reviewQueue.length} object(s) to review (${input.mint.applied.length} recipe(s) minted, ${input.mint.reused.length} reused, ${input.mint.rejected.length} rejected; ${input.restamp.restamped.length} page(s) restamped, ${input.restamp.skipped.length} skipped, ${input.restamp.quarantined.length} quarantined; theme ${Object.keys(input.themeBind.applied.colors).length + Object.keys(input.themeBind.applied.fonts).length} token(s) applied). Everything written is a draft; publishing remains a separate, human-gated act.`;

  return {
    artifact: CLONE_ARTIFACTS.report,
    summary: `Clone run report for ${input.intake.target}: ${report.reviewQueue.length} reviewable object(s), ${Object.keys(report.capabilityBacklog).length} capability gap group(s).`,
    mint: report.mint,
    theme: report.theme,
    restamp: report.restamp,
    capabilityBacklog: report.capabilityBacklog,
    reviewQueue: report.reviewQueue,
    humanSummary,
    humanGate: report.humanGate
  };
}

// Test-only seam, following captureEngine's __test__ precedent: the guarded transport (with its
// pre-transport forbidden-verb and policy refusals) is internal to callProjectTool but its refusal
// semantics are load-bearing and test-pinned.
export const __test__ = { callProjectTool, resolveEmittedThemeId, FORBIDDEN_VERBS };
