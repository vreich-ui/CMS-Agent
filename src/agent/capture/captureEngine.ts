// T12.9 — the capture engine's CMS-Agent seam: one module that (a) resolves the SINGLE operational
// source of capture bounds (R-C2 v2: the project registry's ProjectCapturePolicy, deny-all by
// default) and (b) invokes the vendored platform capture stages (see ./provenance.ts) against stage
// artifacts. Both consumers — the capture.* controlled tools in toolRegistry.ts and the
// capture_conductor deterministic node routes in workspace/captureConductorRoutes.ts — go through
// these functions, so the policy gate cannot be enforced in one place and forgotten in the other.
//
// LAWS CARRIED HERE, not left to callers:
//   - Every step resolves resolveProjectCapturePolicy server-side and refuses when the policy denies
//     capture (maxPages 0, no origins — the registry's fail-closed default). A caller cannot widen a
//     bound by shaping its own arguments; the policy is read fresh from the repository each step.
//   - Emission is DRAFTS-ONLY: the vendored emitter's forbidden-verb set is additionally enforced in
//     the adapter-backed transport below, before any wire call, so publish/release/build/deploy are
//     unreachable even if a plan were hand-tampered.
//   - Crawled content is data, never instructions: nothing here interprets snapshot text; the only
//     model-facing surfaces (the three AI nodes) receive it as structured JSON with prompts that say
//     the same.
//   - The pdf-tool capture plane is grant-gated: every call carries the TARGET project's short-lived
//     Netlify Blobs grant as its `storage` argument, fetched fresh per call from that project's own
//     bridge. Forwarding a grant in-request is the designed mechanism; PERSISTING or LOGGING one is
//     not — the token never reaches run state, a stage artifact, a warning, or an error string.
//   - Validation failures quarantine, never loosen: the mapper's confidence threshold can be raised
//     but never lowered below the engine default, and emission quarantine paths are passed through
//     verbatim.
import { createHash } from "node:crypto";
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { resolveProjectCapturePolicy } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  mapSnapshot,
  type CaptureMapAssistanceSuggestion,
  type CaptureMapGap,
  type CaptureMapping
} from "./engine/map.mjs";
import { extractTheme, type ThemeExtraction } from "./engine/theme.mjs";
import {
  EmissionError,
  buildDryRunReport,
  buildEmissionPlan,
  executeEmission,
  type EmissionPlan,
  type EmissionReport,
  type EmissionTransport
} from "./engine/emit.mjs";
import { scoreCaptureFidelity, type FidelityReport } from "./engine/score.mjs";
import { isUrlWithinPolicy, validateCapturePolicy, type ValidatedCapturePolicy } from "./engine/snapshot-v1.mjs";

// The pdf-tool capture job plane (T12.8, R-C1 v2): CMS-Agent creates the crawl job there and polls
// it — it never crawls locally. The tool names are the T12.8 contract; the result payload shapes
// below are read tolerantly.
export const CAPTURE_JOB_PLANE_PROJECT_ID = "pdf-tool";
export const CREATE_CAPTURE_JOB_TOOL = "create_capture_job";
export const GET_CAPTURE_JOB_STATUS_TOOL = "get_capture_job_status";

// The TARGET project's grant tool — the "artifact bridge" pdf-tool's STORAGE_GRANT_REQUIRED error
// names. pdf-tool holds no storage credentials of its own (the server-side CLIENT_*/PDF_TOOL_* env
// fallbacks were removed), so EVERY storage-touching pdf-tool call must carry the caller's
// short-lived Netlify Blobs grant as the `storage` argument. The grant belongs to the TARGET
// project's site (its blob stores are where the capture job's records and snapshot land), so it is
// fetched from the target project's own MCP — never from pdf-tool, never from CMS-Agent's env.
export const GET_STORAGE_GRANT_TOOL = "get_pdf_tool_storage_grant";

// pdf-tool's ArtifactJobStatus vocabulary ("pending" | "running" | "complete" | "failed" |
// "blocked"), read case-insensitively with "completed"/"queued" tolerated.
const TERMINAL_SUCCESS_STATUSES = new Set(["complete", "completed", "succeeded", "success"]);
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "blocked", "cancelled", "error"]);

export const CAPTURE_ARTIFACTS = {
  snapshot: "capture_snapshot.v1",
  map: "capture_map.v1",
  classification: "block_classification.v1",
  mapRefined: "capture_map_refined.v1",
  theme: "capture_theme.v1",
  regeneration: "capture_copy_regeneration.v1",
  emissionPlan: "capture_emission_plan.v1",
  emissionRun: "capture_emission_run.v1",
  fidelity: "capture_fidelity.v1",
  adjudication: "gap_adjudication.v1",
  report: "capture_run_report.v1"
} as const;

export class CaptureRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CaptureRefusal";
  }
}

export type CaptureDeps = { projectRepository?: ProjectRepository };
const projectsOf = (deps: CaptureDeps = {}): ProjectRepository => deps.projectRepository ?? repositoryManager.getProjectRepository();

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------
// Policy resolution — the ONE gate every capture step passes through.
export type ResolvedCapture = { policy: ValidatedCapturePolicy; projectId: string };

export async function resolveCaptureAuthority(targetProjectId: string, deps: CaptureDeps = {}): Promise<ResolvedCapture> {
  const trimmed = typeof targetProjectId === "string" ? targetProjectId.trim() : "";
  if (!trimmed) throw new CaptureRefusal("capture_target_missing", "A target projectId is required; capture bounds are per-project and there is no global default.");
  const config = await projectsOf(deps).get(trimmed);
  if (!config) throw new CaptureRefusal("unknown_project", `Unknown projectId: ${trimmed}. Register the target via project.create (with an explicit capturePolicy) before any capture step.`);
  if (config.status === "disabled") throw new CaptureRefusal("project_disabled", `Project ${trimmed} is disabled; no capture step may run against it.`);
  const declared = resolveProjectCapturePolicy(config);
  let policy: ValidatedCapturePolicy;
  try {
    // validateCapturePolicy is the vendored engine's own crawl gate: shape-valid AND authorizing
    // (maxPages >= 1, at least one origin/prefix, same-origin, robots, no auth). The registry's
    // deny-all default fails here BY DESIGN — a project must explicitly raise the floor.
    policy = validateCapturePolicy(declared);
  } catch (error) {
    throw new CaptureRefusal("capture_policy_denies", `Project ${trimmed}'s capture policy does not authorize capture: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { policy, projectId: trimmed };
}

export function assertSourceWithinPolicy(sourceUrl: string, policy: ValidatedCapturePolicy): URL {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new CaptureRefusal("capture_source_invalid", `sourceUrl is not a valid URL: ${sourceUrl}`);
  }
  if (url.protocol !== "https:") throw new CaptureRefusal("capture_source_invalid", "sourceUrl must be HTTPS.");
  if (!isUrlWithinPolicy(url.href, policy, url.origin) || !policy.allowedCrawlOrigins.includes(url.origin)) {
    throw new CaptureRefusal(
      "capture_source_out_of_policy",
      `sourceUrl ${url.href} is outside the target project's capture policy (allowed origins: ${policy.allowedCrawlOrigins.join(", ") || "none"}; path prefixes: ${policy.allowedPathPrefixes.join(", ") || "none"}).`
    );
  }
  return url;
}

// The non-secret policy view stamped onto stage envelopes so downstream nodes (and the
// copy-regeneration skip predicate) read policy FACTS from run artifacts instead of re-fetching.
export type CapturePolicyView = {
  rights: ValidatedCapturePolicy["rights"];
  fidelity: ValidatedCapturePolicy["fidelity"];
  maxPages: number;
  allowedCrawlOrigins: string[];
  allowedPathPrefixes: string[];
  sameOriginOnly: boolean;
  respectRobots: boolean;
  concurrency: number;
  delayMs: number;
};

export const policyView = (policy: ValidatedCapturePolicy): CapturePolicyView => ({
  rights: structuredClone(policy.rights),
  fidelity: structuredClone(policy.fidelity),
  maxPages: policy.maxPages,
  allowedCrawlOrigins: [...policy.allowedCrawlOrigins],
  allowedPathPrefixes: [...policy.allowedPathPrefixes],
  sameOriginOnly: policy.sameOriginOnly,
  respectRobots: policy.respectRobots,
  concurrency: policy.concurrency,
  delayMs: policy.delayMs
});

// ---------------------------------------------------------------------------------------------
// Guarded project MCP call. Uses the SAME adapter + per-project tool permissions project.call_tool
// uses; a tool the project's policy blocks is refused before any transport.
async function callProjectTool(projectId: string, tool: string, args: Record<string, unknown>, deps: CaptureDeps = {}): Promise<Record<string, unknown>> {
  const config = await projectsOf(deps).get(projectId);
  if (!config) throw new CaptureRefusal("unknown_project", `Unknown projectId: ${projectId}`);
  const adapter = new ProjectMcpAdapter(config);
  const call = await adapter.callTool(tool, args);
  if (!call.ok) throw new CaptureRefusal("project_tool_call_failed", `${tool} on ${projectId} failed: ${call.error ?? "unknown error"}`);
  const raw = call.result as Record<string, unknown> | undefined;
  if (isRecord(raw) && raw.isError) {
    throw new CaptureRefusal("project_tool_call_failed", `${tool} on ${projectId} returned an MCP error result.`);
  }
  const structured = isRecord(raw) && isRecord(raw.structuredContent) ? (raw.structuredContent as Record<string, unknown>) : (isRecord(raw) ? raw : {});
  // Per-site MCP envelopes commonly nest the payload under `data` (the same convention the vendored
  // engine's own payload() reader unwraps); tolerate one such level here so both server shapes read
  // identically.
  return isRecord(structured.data) ? (structured.data as Record<string, unknown>) : structured;
}

// ---------------------------------------------------------------------------------------------
// Storage grant plumbing — the pdf-tool capture plane's PRECONDITION, not an optional extra.
//
// THE TOKEN IS RADIOACTIVE. It lives only inside one in-request call frame: fetched from the target
// project immediately before a pdf-tool call, forwarded as that call's `storage` argument, then
// dropped. It is never logged, never put in a warning string, never written into run state or a
// stage artifact, never returned from a tool, and never included in an error message — the same
// discipline pdf-tool's own storage-grant.ts keeps with redactGrant(). Two mechanisms hold it here:
// nothing derived from a grant is placed on any returned envelope/jobState (only redactStorageGrant
// may ever describe one), and every error out of a grant-carrying call is passed through
// scrubGrantToken() before it can reach a caller.
export const GRANT_TOKEN_MASK = "[REDACTED]";

export type ForwardedStorageGrant = {
  grantType?: string;
  projectId?: string;
  siteId: string;
  token: string;
  stores?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  expiresAt?: string;
};

/** The ONLY shape of a grant that may leave this module — mirrors pdf-tool's redactGrant(). */
export const redactStorageGrant = (grant: ForwardedStorageGrant): Record<string, unknown> => ({
  ...(grant.grantType ? { grantType: grant.grantType } : {}),
  ...(grant.projectId ? { projectId: grant.projectId } : {}),
  siteId: grant.siteId,
  token: GRANT_TOKEN_MASK,
  ...(grant.stores ? { stores: grant.stores } : {}),
  ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {})
});

const scrubGrantToken = (text: string, token: string): string => (token ? text.split(token).join(GRANT_TOKEN_MASK) : text);

// Re-raises anything thrown out of a grant-carrying call with the token masked, preserving the typed
// refusal code. Defense in depth: a remote that echoed the grant back inside an error can never turn
// that into a leak through a run's node error/warning surface.
const rethrowWithoutGrantToken = (error: unknown, token: string): never => {
  if (error instanceof CaptureRefusal) {
    const prefix = `${error.code}: `;
    const detail = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
    throw new CaptureRefusal(error.code, scrubGrantToken(detail, token));
  }
  throw new CaptureRefusal("project_tool_call_failed", scrubGrantToken(error instanceof Error ? error.message : String(error), token));
};

const grantString = (record: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

// The historical platform/dr-lurie handler returns the grant's fields at the TOP LEVEL of the tool
// result; tolerate a `grant`/`storage` wrapper too so both server shapes read identically.
const readGrantRecord = (payload: Record<string, unknown>): Record<string, unknown> => {
  for (const key of ["grant", "storage", "storageGrant"]) {
    const nested = payload[key];
    if (isRecord(nested)) return nested;
  }
  return payload;
};

// Fetched FRESH per pdf-tool call. Grants are short-lived (the provider's TTL is an hour and pdf-tool
// rejects an expired one), so this is never cached across nodes and a grant is never read back out of
// persisted run state — there is nothing in run state to read.
async function fetchStorageGrant(targetProjectId: string, deps: CaptureDeps = {}): Promise<ForwardedStorageGrant> {
  const config = await projectsOf(deps).get(targetProjectId);
  if (!config) throw new CaptureRefusal("unknown_project", `Unknown projectId: ${targetProjectId}`);
  const call = await new ProjectMcpAdapter(config).callTool(GET_STORAGE_GRANT_TOOL, {});
  if (!call.ok) {
    if (call.permission === "blocked" || call.requiresApproval === true) {
      // A policy gate, not a transport failure — and NOT something capture may route around: the
      // remedy is a human allow-listing the tool on that project record.
      throw new CaptureRefusal(
        "capture_storage_grant_not_permitted",
        `Project ${targetProjectId}'s registration does not permit ${GET_STORAGE_GRANT_TOOL} (tool permission "${call.permission ?? "blocked"}"), so no pdf-tool capture call can carry that project's storage grant. Allow-list ${GET_STORAGE_GRANT_TOOL} on the ${targetProjectId} project record (project.update toolPolicies) — capture never widens a project's policy from code.`
      );
    }
    throw new CaptureRefusal(
      "capture_storage_grant_unavailable",
      `${GET_STORAGE_GRANT_TOOL} on ${targetProjectId} could not be reached: ${call.error ?? "unknown error"}. pdf-tool holds no storage credentials of its own, so capture cannot proceed without that project's grant.`
    );
  }
  const raw = call.result as Record<string, unknown> | undefined;
  if (isRecord(raw) && raw.isError) {
    // The target answered and REFUSED. Its own error text is untrusted (mcpClient never surfaces a
    // remote error string — it can echo credentials) so the remedy is named, not quoted: on a
    // Platform-family site this is the provider's own PDF_TOOL_STORAGE_TOKEN / PDF_TOOL_STORAGE_SITE_ID
    // pair, or a deployment that no longer exposes the tool at all.
    throw new CaptureRefusal(
      "capture_storage_grant_refused",
      `${targetProjectId} refused ${GET_STORAGE_GRANT_TOOL} (MCP error result). Read that project's own error surface: the grant provider needs its storage credential env vars set (names only — PDF_TOOL_STORAGE_TOKEN, PDF_TOOL_STORAGE_SITE_ID) and the tool has to be implemented by the deployment its MCP endpoint serves.`
    );
  }
  const structured = isRecord(raw) && isRecord(raw.structuredContent) ? (raw.structuredContent as Record<string, unknown>) : (isRecord(raw) ? raw : {});
  const payload = isRecord(structured.data) ? (structured.data as Record<string, unknown>) : structured;
  const record = readGrantRecord(payload);
  const siteId = grantString(record, "siteId", "siteID", "site_id");
  const token = grantString(record, "token", "blobsToken", "blobs_token");
  if (!siteId || !token) {
    // Field NAMES only — never a value, and never the partial payload.
    throw new CaptureRefusal(
      "capture_storage_grant_invalid",
      `${GET_STORAGE_GRANT_TOOL} on ${targetProjectId} returned a grant missing required field(s): ${[...(siteId ? [] : ["siteId"]), ...(token ? [] : ["token"])].join(", ")}. pdf-tool refuses a grant it cannot resolve to Blob credentials.`
    );
  }
  const expiresAt = grantString(record, "expiresAt", "expires_at");
  if (expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
      throw new CaptureRefusal(
        "capture_storage_grant_invalid",
        `${GET_STORAGE_GRANT_TOOL} on ${targetProjectId} returned a grant that already expired at ${expiresAt}; pdf-tool rejects expired grants and capture never retries with a stale one.`
      );
    }
  }
  return {
    ...(grantString(record, "grantType", "grant_type") ? { grantType: grantString(record, "grantType", "grant_type")! } : {}),
    ...(grantString(record, "projectId", "project_id") ? { projectId: grantString(record, "projectId", "project_id")! } : {}),
    siteId,
    token,
    ...(isRecord(record.stores) ? { stores: record.stores as Record<string, unknown> } : {}),
    ...(isRecord(record.limits) ? { limits: record.limits as Record<string, unknown> } : {}),
    ...(expiresAt ? { expiresAt } : {})
  };
}

// One pdf-tool capture call under one freshly fetched grant. `descriptor` is deliberately NOT sent:
// pdf-tool's own contract says a grant alone is a complete call (omitted descriptor fields use
// pdf-tool defaults), and a descriptor would be CMS-Agent asserting another tenant's project policy.
async function callCaptureJobTool(
  tool: string,
  args: Record<string, unknown>,
  grant: ForwardedStorageGrant,
  deps: CaptureDeps = {}
): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown>;
  try {
    payload = await callProjectTool(CAPTURE_JOB_PLANE_PROJECT_ID, tool, { ...args, storage: grant }, deps);
  } catch (error) {
    return rethrowWithoutGrantToken(error, grant.token);
  }
  // The response is the ONLY thing from a grant-carrying call that reaches run state (jobState) and a
  // stage artifact (the snapshot envelope). A remote that echoed the grant back — inside a job record,
  // a status string, or captured page text — would otherwise persist the token, so the whole payload
  // is scrubbed once here rather than at each of the several places it is read. One JSON round trip
  // per capture call is a negligible cost for a structural guarantee.
  return JSON.parse(scrubGrantToken(JSON.stringify(payload), grant.token)) as Record<string, unknown>;
}

// pdf-tool namespaces every capture job under a projectId and requires one on BOTH capture tools.
// The GRANT is the authority on which tenant's stores are being opened (pdf-tool itself refuses a
// request projectId that contradicts its grant), so the grant names it; the registry's target
// projectId is the fallback when a grant declares none. Never the caller's argument.
const captureJobProjectId = (grant: ForwardedStorageGrant, targetProjectId: string): string => grant.projectId ?? targetProjectId;

// pdf-tool's capture idempotency scope is {projectId, requestId}: while a job for that pair is
// non-terminal a repeated create RE-ATTACHES to it (continuing from the crawl frontier) instead of
// starting a parallel crawl. Deriving it deterministically from the target project + seed URL is what
// makes a re-driven crawl node safe when the job id did not survive (a long-run plane advance that
// lost stageOutputs must not start a second crawl of the same site).
export const captureJobRequestId = (targetProjectId: string, sourceUrl: string): string =>
  `capture_${createHash("sha256").update(`${targetProjectId}\n${sourceUrl}`).digest("hex").slice(0, 24)}`;

// ---------------------------------------------------------------------------------------------
// Snapshot / envelope types.
export type CaptureSnapshot = { schemaVersion: string; capture: Record<string, unknown>; pages: Array<Record<string, unknown>>; diagnostics?: Record<string, unknown> };

export function assertCaptureSnapshot(value: unknown): CaptureSnapshot {
  if (!isRecord(value) || value.schemaVersion !== "snapshot.v1" || !Array.isArray(value.pages) || !isRecord(value.capture)) {
    throw new CaptureRefusal("capture_snapshot_invalid", "Expected a snapshot.v1 document with capture metadata and pages.");
  }
  return value as unknown as CaptureSnapshot;
}

export type CaptureCoverage = { mappedBlocks: number; relevantBlocks: number; mappedBlockCoverage: number };

const NON_CONTENT_STATUSES = new Set(["duplicate", "merged", "ignored_noncontent"]);
const MAPPED_STATUSES = new Set(["mapped", "mapped_with_gap"]);

// The scorer's own coverage semantics (score.mjs pageStructure/rubricVerdict), aggregated — kept
// numerically identical so the harness's recorded delta and the fidelity report can never disagree.
export function aggregateMappedCoverage(mapping: CaptureMapping): CaptureCoverage {
  let relevant = 0;
  let mapped = 0;
  for (const page of mapping.pages ?? []) {
    for (const entry of page.blockAccounting ?? []) {
      if (NON_CONTENT_STATUSES.has(entry.status)) continue;
      relevant += 1;
      if (MAPPED_STATUSES.has(entry.status)) mapped += 1;
    }
  }
  return { mappedBlocks: mapped, relevantBlocks: relevant, mappedBlockCoverage: relevant ? Number((mapped / relevant).toFixed(4)) : 1 };
}

// Gaps whose block the heuristic mapper DECLINED outright (accounting status "gap") — the exact
// population block_classifier is allowed to judge. mapped_with_gap blocks are already mapped; their
// secondary gaps are capability backlog, not classification candidates.
export function declinedBlockGaps(mapping: CaptureMapping): CaptureMapGap[] {
  const declined: CaptureMapGap[] = [];
  for (const page of mapping.pages ?? []) {
    const declinedRefs = new Set((page.blockAccounting ?? []).filter((entry) => entry.status === "gap").map((entry) => entry.blockRef));
    for (const gap of page.gaps ?? []) if (declinedRefs.has(gap.blockRef)) declined.push({ ...gap });
  }
  return declined;
}

export type BlockTypeSuggestion = { blockRef: string; sectionType: string; rationale?: string };

// Suggestions are UNTRUSTED model output: only {blockRef, sectionType} string pairs survive, only
// for blocks the mapper actually declined, capped in count. The deterministic builder (mapSnapshot's
// assistance path) then re-validates each suggestion — an invalid or unregistered type is simply not
// applied, never coerced (map.mjs classifyBlock checks SUPPORTED_SECTION_TYPES and buildForType, and
// the PageType gate still runs after it).
export function sanitizeSuggestions(raw: unknown, declinedRefs: ReadonlySet<string>, cap = 200): BlockTypeSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockTypeSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= cap) break;
    if (!isRecord(entry)) continue;
    const blockRef = typeof entry.blockRef === "string" ? entry.blockRef.trim() : "";
    const sectionType = typeof entry.sectionType === "string" ? entry.sectionType.trim() : "";
    if (!blockRef || !sectionType || seen.has(blockRef) || !declinedRefs.has(blockRef)) continue;
    seen.add(blockRef);
    out.push({ blockRef, sectionType, ...(typeof entry.rationale === "string" ? { rationale: entry.rationale.slice(0, 500) } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stage: crawl (create/poll the pdf-tool capture job; the LONG-RUN PLANES own the waiting).
export type CaptureCrawlJobState = { jobId: string; status: string; attempts: number; createdAt: string; updatedAt: string };

export type CaptureSnapshotEnvelope = {
  artifact: typeof CAPTURE_ARTIFACTS.snapshot;
  summary: string;
  targetProjectId: string;
  sourceUrl: string;
  jobId: string;
  policy: CapturePolicyView;
  snapshot: CaptureSnapshot;
};

export type CaptureCrawlStep =
  | { phase: "pending"; jobState: CaptureCrawlJobState; note: string }
  | { phase: "completed"; envelope: CaptureSnapshotEnvelope };

const readJobRecord = (payload: Record<string, unknown>): Record<string, unknown> => (isRecord(payload.job) ? (payload.job as Record<string, unknown>) : payload);
const readJobId = (payload: Record<string, unknown>): string | undefined => {
  const job = readJobRecord(payload);
  for (const key of ["jobId", "job_id", "id"]) {
    const value = job[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};
const readJobStatus = (payload: Record<string, unknown>): string => {
  const job = readJobRecord(payload);
  const value = job.status;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
};
const readJobSnapshot = (payload: Record<string, unknown>): unknown => {
  const job = readJobRecord(payload);
  if (isRecord(job.snapshot)) return job.snapshot;
  if (isRecord(job.result) && isRecord((job.result as Record<string, unknown>).snapshot)) return (job.result as Record<string, unknown>).snapshot;
  if (isRecord(payload.snapshot)) return payload.snapshot;
  return undefined;
};

export async function captureCrawlStep(
  input: { targetProjectId: string; sourceUrl: string; jobState?: CaptureCrawlJobState },
  deps: CaptureDeps = {}
): Promise<CaptureCrawlStep> {
  const { policy, projectId } = await resolveCaptureAuthority(input.targetProjectId, deps);
  const url = assertSourceWithinPolicy(input.sourceUrl, policy);
  const now = new Date().toISOString();

  if (!input.jobState?.jobId) {
    // A FRESH grant per pdf-tool call — fetched here, forwarded as `storage`, then dropped.
    const grant = await fetchStorageGrant(projectId, deps);
    // Ceilings are enforced on BOTH sides: the validated policy travels with the job VERBATIM (the
    // frozen T12.7 shape the worker re-validates, rights/designReferences/fidelity included) and it
    // came from the registry here — never from the caller's arguments.
    const created = await callCaptureJobTool(CREATE_CAPTURE_JOB_TOOL, {
      projectId: captureJobProjectId(grant, projectId),
      requestId: captureJobRequestId(projectId, url.href),
      url: url.href,
      policy: structuredClone(policy),
      label: `capture_conductor:${projectId}`
    }, grant, deps);
    const jobId = readJobId(created);
    if (!jobId) throw new CaptureRefusal("capture_job_id_missing", `${CREATE_CAPTURE_JOB_TOOL} returned no job id; cannot poll a job that cannot be named.`);
    return {
      phase: "pending",
      jobState: { jobId, status: readJobStatus(created) || "pending", attempts: 0, createdAt: now, updatedAt: now },
      note: `Capture job ${jobId} created on ${CAPTURE_JOB_PLANE_PROJECT_ID}; completion is awaited by the long-run planes (conductor job / run-continuation tick) re-driving this node until the poll is terminal — never by spinning inside one call window.`
    };
  }

  // Polling is a storage-touching call too (the job record lives in the target site's Blob store), so
  // it carries its OWN fresh grant: the create-side grant is never persisted between advances, and a
  // grant read back out of run state is never a thing that could happen.
  const pollGrant = await fetchStorageGrant(projectId, deps);
  const polled = await callCaptureJobTool(GET_CAPTURE_JOB_STATUS_TOOL, {
    projectId: captureJobProjectId(pollGrant, projectId),
    jobId: input.jobState.jobId
  }, pollGrant, deps);
  const status = readJobStatus(polled) || "pending";
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    throw new CaptureRefusal("capture_job_failed", `Capture job ${input.jobState.jobId} reached terminal status "${status}" on the pdf-tool plane.`);
  }
  if (!TERMINAL_SUCCESS_STATUSES.has(status)) {
    return {
      phase: "pending",
      jobState: { ...input.jobState, status, attempts: input.jobState.attempts + 1, updatedAt: now },
      note: `Capture job ${input.jobState.jobId} is "${status}"; the long-run plane re-drives this node until the poll is terminal.`
    };
  }
  const rawSnapshot = readJobSnapshot(polled);
  if (rawSnapshot === undefined) {
    // The T12.8 brief says results land as ArtifactReferences; until that plane is deployed the
    // reference-fetch wiring cannot be built against reality, so an artifact-only result is a typed
    // refusal here and the LIVE wiring is an explicitly recorded pending item, never a guess.
    throw new CaptureRefusal(
      "capture_snapshot_unavailable",
      `Capture job ${input.jobState.jobId} completed but its status payload carried no inline snapshot.v1; retrieving the snapshot ArtifactReference is part of the pending LIVE T12.8 wiring.`
    );
  }
  const snapshot = assertCaptureSnapshot(rawSnapshot);
  const quarantined = Array.isArray((snapshot.diagnostics as Record<string, unknown> | undefined)?.quarantined)
    ? ((snapshot.diagnostics as Record<string, unknown>).quarantined as unknown[]).length
    : 0;
  if (quarantined > 0) {
    // The downstream mapper/theme extractor refuse quarantined snapshots anyway; refusing here keeps
    // the quarantine loud at the stage that owns it instead of three stages later.
    throw new CaptureRefusal("capture_snapshot_quarantined", `Capture job ${input.jobState.jobId} returned a snapshot with ${quarantined} quarantined page(s); quarantine is never loosened downstream.`);
  }
  return {
    phase: "completed",
    envelope: {
      artifact: CAPTURE_ARTIFACTS.snapshot,
      summary: `Captured ${snapshot.pages.length} page(s) from ${url.href} via pdf-tool capture job ${input.jobState.jobId}.`,
      targetProjectId: projectId,
      sourceUrl: url.href,
      jobId: input.jobState.jobId,
      policy: policyView(policy),
      snapshot
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: map (heuristic, deterministic; assistance is validated, never trusted).
export type CaptureMapEnvelope = {
  artifact: typeof CAPTURE_ARTIFACTS.map | typeof CAPTURE_ARTIFACTS.mapRefined;
  summary: string;
  targetProjectId: string;
  sourceUrl: string | null;
  mapping: CaptureMapping;
  coverage: CaptureCoverage;
  declinedBlocks: CaptureMapGap[];
  policy: CapturePolicyView;
  assistance?: {
    considered: number;
    applied: Array<{ blockRef: string; sectionType: string }>;
    rejected: Array<{ blockRef: string; sectionType: string; reason: string }>;
  };
  coverageDelta?: { baseline: CaptureCoverage; refined: CaptureCoverage; delta: number };
};

const clampThreshold = (threshold: number | undefined): number | undefined => {
  if (threshold === undefined) return undefined;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < DEFAULT_CONFIDENCE_THRESHOLD || threshold > 1) {
    throw new CaptureRefusal(
      "capture_threshold_below_default",
      `Mapping confidence threshold must be within [${DEFAULT_CONFIDENCE_THRESHOLD}, 1]; lowering it below the engine default would loosen acceptance, which capture policy never permits.`
    );
  }
  return threshold;
};

export async function captureMapStep(
  input: { targetProjectId: string; snapshot: unknown; suggestions?: unknown; threshold?: number },
  deps: CaptureDeps = {}
): Promise<CaptureMapEnvelope> {
  const { policy, projectId } = await resolveCaptureAuthority(input.targetProjectId, deps);
  const snapshot = assertCaptureSnapshot(input.snapshot);
  const threshold = clampThreshold(input.threshold);

  const baseline = mapSnapshot(snapshot, { threshold });
  const baselineCoverage = aggregateMappedCoverage(baseline);
  const baselineDeclined = declinedBlockGaps(baseline);

  const declinedRefs = new Set(baselineDeclined.map((gap) => gap.blockRef));
  const considered = sanitizeSuggestions(input.suggestions, declinedRefs);
  if (!considered.length) {
    return {
      artifact: CAPTURE_ARTIFACTS.map,
      summary: `Heuristic mapping: ${baseline.summary.sectionCandidates} candidate(s), ${baseline.summary.gaps} gap(s), coverage ${(baselineCoverage.mappedBlockCoverage * 100).toFixed(2)}% (${baselineCoverage.mappedBlocks}/${baselineCoverage.relevantBlocks}); ${baselineDeclined.length} declined block(s) eligible for classification.`,
      targetProjectId: projectId,
      sourceUrl: baseline.source?.targetUrl ?? null,
      mapping: baseline,
      coverage: baselineCoverage,
      declinedBlocks: baselineDeclined,
      policy: policyView(policy)
    };
  }

  // Assisted re-map: the deterministic builder re-validates every suggestion. Applied = the block is
  // now mapped AND its candidate's sectionType is the suggested one; anything else (unregistered
  // type, unbuildable data, PageType refusal) is REJECTED with the builder's own reason preserved.
  const refined = mapSnapshot(snapshot, { threshold, assistance: { suggestions: considered } });
  const refinedCoverage = aggregateMappedCoverage(refined);
  const applied: Array<{ blockRef: string; sectionType: string }> = [];
  const rejected: Array<{ blockRef: string; sectionType: string; reason: string }> = [];
  for (const suggestion of considered) {
    let verdict: { applied: boolean; reason: string } = { applied: false, reason: "block_not_found_in_refined_mapping" };
    for (const page of refined.pages ?? []) {
      const accounting = (page.blockAccounting ?? []).find((entry) => entry.blockRef === suggestion.blockRef);
      if (!accounting) continue;
      if (MAPPED_STATUSES.has(accounting.status)) {
        const candidate = (page.candidates ?? []).find((entry) => entry.candidateId === accounting.candidateId);
        verdict = candidate?.sectionType === suggestion.sectionType
          ? { applied: true, reason: "validated_assisted_type_choice" }
          : { applied: false, reason: `builder_mapped_as_${candidate?.sectionType ?? "unknown"}_not_${suggestion.sectionType}` };
      } else {
        const gap = (page.gaps ?? []).find((entry) => entry.blockRef === suggestion.blockRef);
        verdict = { applied: false, reason: gap?.why ?? "suggestion_not_applied" };
      }
      break;
    }
    if (verdict.applied) applied.push({ blockRef: suggestion.blockRef, sectionType: suggestion.sectionType });
    else rejected.push({ blockRef: suggestion.blockRef, sectionType: suggestion.sectionType, reason: verdict.reason });
  }
  const delta = Number((refinedCoverage.mappedBlockCoverage - baselineCoverage.mappedBlockCoverage).toFixed(4));
  return {
    artifact: CAPTURE_ARTIFACTS.mapRefined,
    summary: `Assisted re-map: ${applied.length}/${considered.length} suggestion(s) validated by the deterministic builder (${rejected.length} rejected, never coerced); coverage ${(baselineCoverage.mappedBlockCoverage * 100).toFixed(2)}% -> ${(refinedCoverage.mappedBlockCoverage * 100).toFixed(2)}% (delta ${(delta * 100).toFixed(2)}pp).`,
    targetProjectId: projectId,
    sourceUrl: refined.source?.targetUrl ?? null,
    mapping: refined,
    coverage: refinedCoverage,
    declinedBlocks: declinedBlockGaps(refined),
    policy: policyView(policy),
    assistance: { considered: considered.length, applied, rejected },
    coverageDelta: { baseline: baselineCoverage, refined: refinedCoverage, delta }
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: theme (bounded quantization; captured content never interpreted as instructions).
export type CaptureThemeEnvelope = {
  artifact: typeof CAPTURE_ARTIFACTS.theme;
  summary: string;
  targetProjectId: string;
  theme: ThemeExtraction["body"];
  report: ThemeExtraction["report"];
  policy: CapturePolicyView;
};

export async function captureThemeStep(input: { targetProjectId: string; snapshot: unknown }, deps: CaptureDeps = {}): Promise<CaptureThemeEnvelope> {
  const { policy, projectId } = await resolveCaptureAuthority(input.targetProjectId, deps);
  const snapshot = assertCaptureSnapshot(input.snapshot);
  const extraction = extractTheme(snapshot);
  const fallbacks = extraction.report.swatches.filter((swatch) => swatch.fallback).length;
  return {
    artifact: CAPTURE_ARTIFACTS.theme,
    summary: `Bounded theme draft extracted: ${extraction.report.swatches.length} swatches (${fallbacks} fallback), ${Object.keys(extraction.report.axes).length} quantized axes, ${extraction.report.gaps.length} recorded gap(s).`,
    targetProjectId: projectId,
    theme: extraction.body,
    report: extraction.report,
    policy: policyView(policy)
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: emit (drafts-only; forbidden-verb set enforced pre-transport; rights govern copy).
export type RegeneratedBody = { requestedId: string; objectType: string; body: Record<string, unknown> };

export type CaptureEmissionEnvelope = {
  artifact: typeof CAPTURE_ARTIFACTS.emissionPlan | typeof CAPTURE_ARTIFACTS.emissionRun;
  summary: string;
  targetProjectId: string;
  live: boolean;
  plan: EmissionPlan;
  report: Record<string, unknown>;
  policy: CapturePolicyView;
};

const buildAdapterTransport = (projectId: string, forbiddenVerbs: ReadonlySet<string>, deps: CaptureDeps): EmissionTransport => ({
  async call(verb: string, args: Record<string, unknown>) {
    // Enforced here IN ADDITION to the vendored emitter's own checks: publish/release/build/deploy
    // are unreachable from capture even if a plan document were hand-tampered.
    if (forbiddenVerbs.has(verb)) throw new EmissionError(`Forbidden emission verb: ${verb}`);
    return callProjectTool(projectId, verb, args, deps);
  }
});

function buildRegenerationAdapter(plan: EmissionPlan, regenerated: RegeneratedBody[]) {
  const byRequestedId = new Map(regenerated.filter((entry) => isRecord(entry?.body)).map((entry) => [entry.requestedId, entry]));
  return {
    async regenerateBody({ body, objectType }: { body: Record<string, unknown>; objectType: string; target: string; source: unknown }) {
      const serialized = JSON.stringify(body);
      const operation = plan.creates.find((create) => create.objectType === objectType && JSON.stringify(create.body) === serialized);
      const match = operation ? byRequestedId.get(operation.requestedId) : undefined;
      if (!match || match.objectType !== objectType) {
        // Quarantined per-operation by executeEmission's catch — a missing regeneration never falls
        // back to emitting extracted copy the rights prohibit.
        throw new EmissionError(`No regenerated body supplied for ${operation?.requestedId ?? `an unplanned ${objectType} operation`}; rights require regeneration, so the operation is quarantined rather than emitted with extracted copy.`);
      }
      return structuredClone(match.body);
    }
  };
}

export async function captureEmitStep(
  input: {
    targetProjectId: string;
    mapping: unknown;
    theme: unknown;
    live?: boolean;
    regenerated?: RegeneratedBody[];
    repeatThreshold?: number;
  },
  deps: CaptureDeps = {}
): Promise<CaptureEmissionEnvelope> {
  const { policy, projectId } = await resolveCaptureAuthority(input.targetProjectId, deps);
  let plan: EmissionPlan;
  try {
    plan = buildEmissionPlan({ target: projectId, mapping: input.mapping, theme: input.theme, repeatThreshold: input.repeatThreshold });
  } catch (error) {
    throw new CaptureRefusal("capture_emission_plan_invalid", error instanceof Error ? error.message : String(error));
  }
  if (input.live !== true) {
    const dryRun = buildDryRunReport(plan);
    return {
      artifact: CAPTURE_ARTIFACTS.emissionPlan,
      summary: `Emission dry-run plan: ${plan.creates.length} create(s) (${plan.creates.map((create) => create.kind).join(", ") || "none"}), ${plan.media.length} media binding(s), ${plan.gaps.length} gap(s). No MCP call was made; forbidden verbs: ${plan.forbiddenVerbs.join(", ")}.`,
      targetProjectId: projectId,
      live: false,
      plan,
      report: dryRun as unknown as Record<string, unknown>,
      policy: policyView(policy)
    };
  }
  const forbidden = new Set(plan.forbiddenVerbs);
  const modelAdapter = policy.rights.content === "retain_allowed_origin_content"
    ? null
    : buildRegenerationAdapter(plan, input.regenerated ?? []);
  let report: EmissionReport;
  try {
    report = await executeEmission({
      plan,
      transport: buildAdapterTransport(projectId, forbidden, deps),
      // R-C2 v2: the CMS-Agent project registry is the ONE operational policy home; the per-site MCP
      // deliberately does not expose capture policy, so the resolver answers from the registry read
      // this step already performed.
      projectPolicyResolver: async (target: string) => ({ project: { projectId: target, capturePolicy: policy } }),
      modelAdapter
    });
  } catch (error) {
    throw new CaptureRefusal("capture_emission_refused", error instanceof Error ? error.message : String(error));
  }
  const created = report.createdObjects ?? [];
  const quarantines = report.quarantines ?? [];
  const undrafted = created.filter((object) => object.draftVerified !== true);
  return {
    artifact: CAPTURE_ARTIFACTS.emissionRun,
    summary: `Live emission (drafts only): ${created.length} draft(s) created (${undrafted.length} failed draft verification), ${(report.reusedObjects ?? []).length} reused, ${quarantines.length} quarantined, ${report.validationStates.filter((state) => state.valid).length}/${report.validationStates.length} validations clean. Publish/release remain unreachable (forbidden verbs enforced pre-transport).`,
    targetProjectId: projectId,
    live: true,
    plan,
    report: report as unknown as Record<string, unknown>,
    policy: policyView(policy)
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: score (governed rubric; visual evidence explains, never authorizes).
export type CaptureFidelityEnvelope = {
  artifact: typeof CAPTURE_ARTIFACTS.fidelity;
  summary: string;
  targetProjectId: string;
  rubric: FidelityReport["rubric"];
  report: FidelityReport;
  policy: CapturePolicyView;
};

export async function captureScoreStep(
  input: { targetProjectId: string; snapshot: unknown; mapping: unknown; theme: unknown; previewManifest?: unknown; screenshotRoot?: string },
  deps: CaptureDeps = {}
): Promise<CaptureFidelityEnvelope> {
  const { policy, projectId } = await resolveCaptureAuthority(input.targetProjectId, deps);
  const snapshot = assertCaptureSnapshot(input.snapshot);
  let report: FidelityReport;
  try {
    report = await scoreCaptureFidelity({
      snapshot,
      mapping: input.mapping,
      theme: input.theme,
      target: projectId,
      projectPolicy: { project: { projectId, capturePolicy: policy } },
      previewManifest: input.previewManifest ?? null,
      ...(input.screenshotRoot ? { screenshotRoot: input.screenshotRoot } : {})
    });
  } catch (error) {
    throw new CaptureRefusal("capture_score_failed", error instanceof Error ? error.message : String(error));
  }
  return {
    artifact: CAPTURE_ARTIFACTS.fidelity,
    summary: `Fidelity verdict "${report.rubric.verdict}": coverage ${(report.rubric.coverage.score * 100).toFixed(2)}% (${report.rubric.coverage.mappedBlocks}/${report.rubric.coverage.relevantBlocks}, minimum ${(report.rubric.coverage.minimum * 100).toFixed(0)}%), tokens ${report.rubric.tokensComplete.met ? "complete" : "incomplete"}, gaps ${report.rubric.gapsEnumerated.met ? "enumerated" : "NOT enumerated"}; visual ${report.visual.scoredCount} scored / ${report.visual.unavailableCount} unavailable.`,
    targetProjectId: projectId,
    rubric: report.rubric,
    report,
    policy: policyView(policy)
  };
}

// ---------------------------------------------------------------------------------------------
// Stage: report (pure assembly — the workflow's END; the human gate begins here).
export type CaptureRunReportEnvelope = {
  artifact: typeof CAPTURE_ARTIFACTS.report;
  summary: string;
  targetProjectId: string;
  sourceUrl: string | null;
  rubric: FidelityReport["rubric"];
  coverage: { baseline?: CaptureCoverage; refined?: CaptureCoverage; delta?: number };
  drafts: { created: unknown[]; reused: unknown[]; quarantines: unknown[]; validationStates: unknown[]; live: boolean };
  gapsByCapability: FidelityReport["gapReport"]["byCapability"];
  w10EvidenceFeed: Array<Record<string, unknown>>;
  humanSummary: string;
  humanGate: { publishReachable: false; note: string };
};

// Test-only seam, following the publisher.ts precedent: the adapter-backed transport (with its
// pre-transport forbidden-verb refusal) and the regeneration adapter are internal to captureEmitStep
// but their refusal semantics are load-bearing and test-pinned.
export const __test__ = { buildAdapterTransport, buildRegenerationAdapter, callProjectTool, fetchStorageGrant, scrubGrantToken };

export function buildCaptureRunReport(input: {
  targetProjectId: string;
  fidelity: CaptureFidelityEnvelope;
  emission?: CaptureEmissionEnvelope;
  mapEnvelope?: CaptureMapEnvelope;
  adjudication?: Record<string, unknown>;
}): CaptureRunReportEnvelope {
  const gapReport = input.fidelity.report.gapReport;
  const adjudications = Array.isArray(input.adjudication?.adjudications) ? (input.adjudication!.adjudications as Array<Record<string, unknown>>) : [];
  const adjudicationByGap = new Map(
    adjudications.filter((entry) => typeof entry.gapId === "string").map((entry) => [entry.gapId as string, entry])
  );
  const w10EvidenceFeed = gapReport.entries.map((entry) => ({
    evidenceType: "capture_gap",
    ...entry,
    ...(adjudicationByGap.has(entry.gapId as string) ? { adjudication: adjudicationByGap.get(entry.gapId as string) } : {})
  }));
  const adjudicatorSummary = typeof input.adjudication?.humanSummary === "string" && input.adjudication.humanSummary.trim()
    ? input.adjudication.humanSummary.trim()
    : undefined;
  const emissionReport = input.emission?.report as { createdObjects?: unknown[]; reusedObjects?: unknown[]; quarantines?: unknown[]; validationStates?: unknown[] } | undefined;
  const humanSummary = adjudicatorSummary
    ?? `Deterministic fallback summary (no adjudicator narrative on this run): verdict "${input.fidelity.rubric.verdict}", coverage ${(input.fidelity.rubric.coverage.score * 100).toFixed(2)}% against a ${(input.fidelity.rubric.coverage.minimum * 100).toFixed(0)}% bar, ${gapReport.entries.length} residual gap(s) across ${gapReport.byCapability.length} missing capabilit(ies). Every gap is enumerated in the W10 evidence feed below.`;
  return {
    artifact: CAPTURE_ARTIFACTS.report,
    summary: `Capture run report for ${input.targetProjectId}: ${emissionReport?.createdObjects?.length ?? 0} never-released draft(s), verdict "${input.fidelity.rubric.verdict}", ${gapReport.entries.length} residual gap(s) fed to the W10 evidence backlog. The workflow ends here; publish/release require the human gate.`,
    targetProjectId: input.targetProjectId,
    sourceUrl: input.mapEnvelope?.sourceUrl ?? null,
    rubric: input.fidelity.rubric,
    coverage: input.mapEnvelope?.coverageDelta ?? (input.mapEnvelope ? { refined: input.mapEnvelope.coverage } : {}),
    drafts: {
      created: emissionReport?.createdObjects ?? [],
      reused: emissionReport?.reusedObjects ?? [],
      quarantines: emissionReport?.quarantines ?? [],
      validationStates: emissionReport?.validationStates ?? [],
      live: input.emission?.live ?? false
    },
    gapsByCapability: gapReport.byCapability,
    w10EvidenceFeed,
    humanSummary,
    humanGate: {
      publishReachable: false,
      note: "Everything this run wrote is a never-released draft. No capture node can reach object_publish / release_to_production / trigger_netlify_build / deploy (forbidden-verb set enforced pre-transport), and the workflow's terminal node is this report. Publication is a separate, explicitly human-gated act."
    }
  };
}
