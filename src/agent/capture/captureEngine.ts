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
//   - The capture plane is reached ONLY through the TARGET site's own capture bridge (T12.13). CMS-Agent
//     never calls pdf-tool directly and never handles a storage credential: under Wolf's 2026-08-14
//     ruling ("option A, same-site writes") pdf-tool persists the crawl output into its OWN store, the
//     tenant's bridge mints nothing, and a new tenant needs no per-site Netlify PAT to be captured.
//     The radioactivity discipline is kept as belt-and-braces anyway — every bridge response is
//     scrubbed of credential-shaped fields before it can reach run state or a stage artifact.
//   - Validation failures quarantine, never loosen: the mapper's confidence threshold can be raised
//     but never lowered below the engine default, and emission quarantine paths are passed through
//     verbatim.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { resolveProjectCapturePolicy, type ProjectConnectionConfig } from "../projects/projectTypes.js";
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
import { augmentMappingWithEmbeds } from "./embeds.js";
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
// T15.7 (ADR-2026-08-25-publish-autonomy §6/§9) — the T14.5 side publish path (./engine/publish.mjs,
// and this module's own capturePublishStep/buildPublishTransport that drove it) is DELETED. capture no
// longer publishes or releases itself: it composes onto the shared publishing tail
// (workspace/publishingTail.ts) via workspace/captureConductorNodes.ts, and the object-scoped publish
// plan/execution that used to live here is workspace/objectPublishExecution.ts (the canonical TS port
// #186 built expressly to receive this deletion) plus workspace/releaseExecution.ts for the one
// governed release. Nothing in THIS module reaches object_publish or release_to_production any more.

// The capture plane, reached through the TARGET SITE'S CAPTURE BRIDGE (T12.13). The crawl still runs
// in pdf-tool (R-C1 v2 — CMS-Agent never crawls locally), but the tenant's own /mcp is the only door:
// its bridge resolves the canonical pdf-tool project AND the crawl's idempotency scope server-side,
// forwards the call, and never returns a grant, a token, or a Netlify site id to anyone.
//
// Why this replaced the direct pdf-tool call (the T12.9 dead end): pdf-tool refuses a storage-less
// call on its credentialed tools, and the grant RPC that used to hand CMS-Agent one was DELETED from
// platform core on 2026-08-02 (commit 7d1640ce) in favour of a server-side bridge that mints the
// grant internally and never returns it. Wolf's 2026-08-14 ruling closed the question the other way
// round: under "option A, same-site writes" pdf-tool writes its own store, so there is no grant to
// fetch, forward, or leak — on either side.
//
// The tool names are the bridge contract (identical on every tenant, because they live in platform
// core); the result payload shapes below are read tolerantly.
export const CREATE_CAPTURE_JOB_TOOL = "create_capture_job";
export const GET_CAPTURE_JOB_STATUS_TOOL = "get_capture_job_status";
export const GET_CAPTURE_SNAPSHOT_TOOL = "get_capture_snapshot";

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
  // T15.7 — capture_publish_run.v1 (the T14.5 side-path envelope) is retired along with publish.mjs.
  // The tail's own artifacts (dry_run_publish_payload.v1, publication_decision.v1,
  // publish_execution.v1, release_execution.v1 — publishingTail.ts) carry what went live now.
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
// `config` is the registry record the policy came from — carried so a step that needs another
// registry-owned fact (T12.13: the owning site id the target's capture bridge is scoped to) reads it
// from the SAME read rather than a second one, and so that fact is resolved in the step that needs it
// rather than gating every step on it.
export type ResolvedCapture = { policy: ValidatedCapturePolicy; projectId: string; config: ProjectConnectionConfig };

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
  return { policy, projectId: trimmed, config };
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
// T12.18 — what a CLIENT said when it refused, made legible.
//
// THE RULING THIS REVISES, and why. T12.13 wrote down "the remote's own error text is untrusted, so
// the remedy is NAMED, not quoted", and every isError result collapsed to the constant string
// "returned an MCP error result". On 2026-08-19 that cost a full diagnosis cycle: run
// run_1787060978987_06v19b quarantined 29 assets with 29 byte-identical messages carrying no fact
// about any of them, and the cause was only found by hand-replaying create_artifact_from_url
// through project.call_tool — where the client answered, immediately and precisely,
// {statusCode: 400, error: "request_id must match req_<flow>_<topic>_<yyyymmdd>_<nn> ..."}.
// A refusal a machine cannot act on and a human cannot read is not safety, it is a blind spot.
//
// WHAT THE ORIGINAL RULING WAS ACTUALLY PROTECTING, and how that survives. The danger is remote
// text becoming an instruction: a capture run's state is read downstream by gap_adjudicator, a
// MODEL node. That danger belongs to CRAWLED THIRD-PARTY CONTENT ("crawled content is data, never
// instructions") — the open internet. This string is not that. It is a first-party governed
// service's own structured refusal, reached over an authenticated endpoint from the project
// registry. So it is quoted, but never trusted: STRUCTURED fields are preferred over prose,
// the result is length-capped so no remote party can flood run state, newlines are flattened so
// nothing can forge log or prompt structure, and credential-shaped runs are redacted — the same
// discipline stripCredentialShapedFields already applies to bridge payloads.
//
// Hex digests are deliberately NOT redacted: a sha256 mismatch is one of the failures this exists
// to explain, and blanking the digest would recreate the blind spot in the exact case that most
// needs it.
const MCP_ERROR_DETAIL_MAX = 300;
const CREDENTIAL_SHAPED_TEXT_RE =
  // The labelled branch must swallow an optional `bearer ` PREFIX as part of its value. Without
  // that, `Authorization: Bearer <secret>` matches the label branch, whose `\S+` stops at the
  // space after "Bearer" — consuming the trigger word and leaving the secret itself in the clear,
  // while the standalone bearer branch never gets to re-scan the text already consumed.
  /\b(?:bearer\s+[\w.\-~+/]+=*|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|(?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*(?:bearer\s+)?\S+)/gi;

/** Bounded, scrubbed, single-line rendering of a client's MCP error result. Exported for tests. */
export function describeMcpErrorResult(raw: Record<string, unknown>): string {
  const structured = isRecord(raw.structuredContent) ? raw.structuredContent : undefined;
  const nested = structured && isRecord(structured.error) ? structured.error : undefined;
  const firstString = (...values: unknown[]): string | undefined =>
    values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();

  // A typed code is worth more than prose and is listed first; statusCode is a number, so it can
  // never carry text at all.
  // Both spellings are in the wild: the site MCP's own catalog uses `error_code` (the vendored
  // engine's errorCode() reader agrees), while the capture bridge answers with `errorCode`.
  const code = firstString(structured?.error_code, structured?.errorCode, nested?.code, structured?.code);
  const status = typeof structured?.statusCode === "number" ? structured.statusCode : undefined;
  const message =
    firstString(nested?.message, structured?.message, typeof structured?.error === "string" ? structured.error : undefined) ??
    (Array.isArray(raw.content)
      ? firstString(
          raw.content
            .filter(isRecord)
            .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
            .join(" ")
        )
      : undefined);

  const prefix = [status !== undefined ? `status ${status}` : undefined, code].filter(Boolean).join(" ");
  if (!message) return prefix || "the client returned no error detail";

  const scrubbed = message.replace(CREDENTIAL_SHAPED_TEXT_RE, "[redacted]").replace(/\s+/g, " ");
  const bounded = scrubbed.length > MCP_ERROR_DETAIL_MAX ? `${scrubbed.slice(0, MCP_ERROR_DETAIL_MAX)}…` : scrubbed;
  return prefix ? `${prefix}: ${bounded}` : bounded;
}

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
    throw new CaptureRefusal("project_tool_call_failed", `${tool} on ${projectId} returned an MCP error result: ${describeMcpErrorResult(raw)}`);
  }
  const structured = isRecord(raw) && isRecord(raw.structuredContent) ? (raw.structuredContent as Record<string, unknown>) : (isRecord(raw) ? raw : {});
  // Per-site MCP envelopes commonly nest the payload under `data` (the same convention the vendored
  // engine's own payload() reader unwraps); tolerate one such level here so both server shapes read
  // identically.
  return isRecord(structured.data) ? (structured.data as Record<string, unknown>) : structured;
}

// ---------------------------------------------------------------------------------------------
// Bridge plumbing (T12.13). There is NO credential here to guard any more — the capture bridge mints
// nothing and returns nothing credential-shaped, and pdf-tool writes its own store — so the module
// that used to fetch, forward, redact and scrub a Netlify Blobs grant is gone. What is KEPT from that
// discipline is the part that still earns its place: a bridge response is untrusted remote data that
// lands in run state (jobState) and in a stage artifact (the snapshot envelope), so credential-shaped
// fields are stripped from it once, here, rather than trusted to be absent.
export const CREDENTIAL_SHAPED_KEYS = ["storage", "storageGrant", "grant", "token", "blobsToken", "blobs_token", "materializationProof"] as const;

/** Recursively drops credential-shaped keys from anything a bridge handed back. Mirrors platform's own
 * sanitizePdfToolPayload: a remote that echoed a credential — inside a job record, a status string, or
 * captured page text — can never make us persist it, even though under option A there is nothing on
 * either side to echo. */
export const stripCredentialShapedFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripCredentialShapedFields);
  if (!isRecord(value)) return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((CREDENTIAL_SHAPED_KEYS as readonly string[]).includes(key)) continue;
    safe[key] = stripCredentialShapedFields(child);
  }
  return safe;
};

// One call to the TARGET site's capture bridge. The bridge is the ONLY door to the capture plane: it
// resolves site ownership, the canonical pdf-tool project and the crawl's request scope server-side,
// so the only things worth sending are the owning site id, the seed URL and the registry policy the
// bounds come from.
async function callCaptureBridge(
  targetProjectId: string,
  tool: string,
  args: Record<string, unknown>,
  deps: CaptureDeps = {}
): Promise<Record<string, unknown>> {
  const payload = await callProjectTool(targetProjectId, tool, args, deps);
  return stripCredentialShapedFields(payload) as Record<string, unknown>;
}

// The owning site object id, sent to the bridge as an OPTIONAL CROSS-CHECK. It comes from the project
// record's own objectDialect (the same seam object_create's `site` argument uses) — never from a
// caller argument, so a caller cannot aim a crawl at another tenant. When the record declares none
// (project.create cannot set objectDialect at all, so a freshly registered duplication target has
// none), it is simply omitted: the bridge then answers for its own site, resolved server-side from that
// deployment's committed site-identity seam, which is the authoritative value anyway. Guessing one
// here would be strictly worse than letting the owner answer.
export function captureSiteObjectId(config: { projectId: string; objectDialect?: { siteObjectId?: string } }): string | undefined {
  const siteObjectId = config.objectDialect?.siteObjectId?.trim();
  return siteObjectId ? siteObjectId : undefined;
}

/** The site scope argument, present only when the registry actually declares one. */
const captureSiteScope = (siteObjectId: string | undefined): Record<string, unknown> =>
  siteObjectId ? { site_id: siteObjectId } : {};

// The two things T12.9 had to send by hand — pdf-tool's `projectId` (which tenant's stores are opened)
// and its `requestId` (the {projectId, requestId} idempotency scope, so a re-driven create RE-ATTACHES
// to the running crawl and continues from its frontier instead of starting a parallel one) — are now
// both DERIVED SERVER-SIDE by the bridge, from the owning site and the normalized seed URL. That is
// strictly stronger than deriving them here: a caller cannot name either, and two tenants cannot
// collide. The property T12.9 was protecting is unchanged, and the crawl step no longer has to know
// pdf-tool's tenancy model at all.

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
  const { policy, projectId, config } = await resolveCaptureAuthority(input.targetProjectId, deps);
  const url = assertSourceWithinPolicy(input.sourceUrl, policy);
  const siteObjectId = captureSiteObjectId(config);
  const now = new Date().toISOString();

  if (!input.jobState?.jobId) {
    // Ceilings are enforced on EVERY side: the validated policy travels with the job VERBATIM (the
    // frozen T12.7 shape — rights/designReferences/fidelity included, which is what T12.9 had to fix
    // and what the bridge now refuses a subset of) and it came from THIS registry read, never from the
    // caller's arguments. The bridge re-checks the invariants and clamps maxPages before forwarding;
    // pdf-tool's worker re-validates from the stored record on every invocation.
    const created = await callCaptureBridge(projectId, CREATE_CAPTURE_JOB_TOOL, {
      ...captureSiteScope(siteObjectId),
      url: url.href,
      policy: structuredClone(policy)
    }, deps);
    const jobId = readJobId(created);
    if (!jobId) throw new CaptureRefusal("capture_job_id_missing", `${CREATE_CAPTURE_JOB_TOOL} returned no job id; cannot poll a job that cannot be named.`);
    return {
      phase: "pending",
      jobState: { jobId, status: readJobStatus(created) || "pending", attempts: 0, createdAt: now, updatedAt: now },
      note: `Capture job ${jobId} created through ${projectId}'s capture bridge; completion is awaited by the long-run planes (conductor job / run-continuation tick) re-driving this node until the poll is terminal — never by spinning inside one call window.`
    };
  }

  const polled = await callCaptureBridge(projectId, GET_CAPTURE_JOB_STATUS_TOOL, {
    ...captureSiteScope(siteObjectId),
    job_id: input.jobState.jobId
  }, deps);
  const status = readJobStatus(polled) || "pending";
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    throw new CaptureRefusal("capture_job_failed", `Capture job ${input.jobState.jobId} reached terminal status "${status}" on the capture plane.`);
  }
  if (!TERMINAL_SUCCESS_STATUSES.has(status)) {
    return {
      phase: "pending",
      jobState: { ...input.jobState, status, attempts: input.jobState.attempts + 1, updatedAt: now },
      note: `Capture job ${input.jobState.jobId} is "${status}"; the long-run plane re-drives this node until the poll is terminal.`
    };
  }

  // THE SNAPSHOT READ PATH (T12.13 part 3). A completed job's status payload carries the snapshot.v1
  // ArtifactReference, never the document — the bytes live in pdf-tool's own store under option A, and
  // handing out a credential to read them is exactly what this task removed. So the document comes
  // through the bridge's own read tool: one extra site-scoped, read-only call, no credential anywhere.
  // A payload that DOES carry an inline snapshot (a future plane, or a test double) is used as-is
  // rather than re-fetched.
  const snapshot = assertCaptureSnapshot(readJobSnapshot(polled) ?? (await readSnapshotThroughBridge(projectId, siteObjectId, input.jobState.jobId, deps)));
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
      summary: `Captured ${snapshot.pages.length} page(s) from ${url.href} via capture job ${input.jobState.jobId} on ${projectId}'s capture bridge.`,
      targetProjectId: projectId,
      sourceUrl: url.href,
      jobId: input.jobState.jobId,
      policy: policyView(policy),
      snapshot
    }
  };
}

/** The bridge read: returns the snapshot.v1 document for a completed job, or a typed refusal naming the
 * tool a human would have to look at. Crawled content is DATA — nothing here interprets it. */
async function readSnapshotThroughBridge(
  projectId: string,
  siteObjectId: string | undefined,
  jobId: string,
  deps: CaptureDeps
): Promise<unknown> {
  const read = await callCaptureBridge(projectId, GET_CAPTURE_SNAPSHOT_TOOL, { ...captureSiteScope(siteObjectId), job_id: jobId }, deps);
  const snapshot = isRecord(read.snapshot) ? read.snapshot : isRecord(read.document) ? read.document : undefined;
  if (snapshot === undefined) {
    throw new CaptureRefusal(
      "capture_snapshot_unavailable",
      `Capture job ${jobId} completed but ${GET_CAPTURE_SNAPSHOT_TOOL} on ${projectId} returned no snapshot.v1 document. The snapshot artifact lives in pdf-tool's own store and is only readable through that bridge tool — check ${projectId}'s own error surface (a snapshot over the plane's inline ceiling is refused there with CAPTURE_SNAPSHOT_TOO_LARGE, and an incomplete job with CAPTURE_SNAPSHOT_NOT_READY).`
    );
  }
  return snapshot;
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

  const baseline = augmentMappingWithEmbeds(mapSnapshot(snapshot, { threshold }), snapshot);
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
  const refined = augmentMappingWithEmbeds(mapSnapshot(snapshot, { threshold, assistance: { suggestions: considered } }), snapshot);
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
// Stage: publish — DELETED (T14.5's side path, T15.7's deletion).
//
// capturePublishStep, buildPublishTransport and CapturePublishEnvelope used to live here, reading a
// finished emission's report and calling object_publish / release_to_production directly through a
// transport built in this module. That entire path is gone: capture's publish/release stages are now
// the shared publishing tail's OWN publish_payload -> publication_controller -> publish_executor ->
// release_executor nodes (workspace/publishingTail.ts), composed onto capture_conductor by
// workspace/captureConductorNodes.ts. The object-scoped plan/execution this stage used to build is
// workspace/objectPublishExecution.ts (buildObjectPublishPlan/executeObjectPublish — the canonical TS
// port #186 built expressly to receive this deletion, carrying every behaviour this stage's own header
// called out as load-bearing: per-object validation, quarantine exclusion, named withholding, a
// non-throwing per-object loop, and finally-released leases); the one release call is
// workspace/releaseExecution.ts. The dispatch glue that used to live in this stage now lives in
// workspace/captureConductorRoutes.ts's "publish_payload" / "publication_controller" / "publish_executor"
// cases, which is where a project's publishingPolicy.publishEnabled / *_PUBLISH_ENABLED kill-switch and
// the operator veto are now read (publisher.ts's isProjectPublishEnabled and
// publishDecision.ts's resolvePublishAuthority — the SAME functions the DTC tail already used, so
// capture and publishing_conductor can never drift on what "publishing is off" means again).

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
  // T14.5 — was `humanGate: { publishReachable: false }`, which is no longer true: capture publishes.
  // T15.7 — the source of truth for this block moved from the deleted capture_publish side-path node
  // to the shared tail's OWN publish_executor (published/failed/withheld) and release_executor
  // (release evidence) records. The report now states what the TAIL did, not what a capture-local
  // stage did — genuinely terminal over the tail's own outputs, per ADR-2026-08-25-publish-autonomy §6.2.
  publication: {
    attempted: boolean;
    published: unknown[];
    failed: unknown[];
    withheld: unknown[];
    release: Record<string, unknown> | null;
    note: string;
  };
};

// Test-only seam, following the publisher.ts precedent: the adapter-backed transport (with its
// pre-transport forbidden-verb refusal) and the regeneration adapter are internal to captureEmitStep
// but their refusal semantics are load-bearing and test-pinned.
export const __test__ = { buildAdapterTransport, buildRegenerationAdapter, callProjectTool, callCaptureBridge, readSnapshotThroughBridge };

export function buildCaptureRunReport(input: {
  targetProjectId: string;
  fidelity: CaptureFidelityEnvelope;
  emission?: CaptureEmissionEnvelope;
  mapEnvelope?: CaptureMapEnvelope;
  adjudication?: Record<string, unknown>;
  /** The shared tail's publish_execution.v1 record, when publish_executor ran. Absent = it was refused
   * (operator veto, autonomy policy gate, or a controller no-go) or has not run yet. */
  publishExecution?: Record<string, unknown>;
  /** The shared tail's release_execution.v1 record, when release_executor ran. */
  releaseExecution?: Record<string, unknown>;
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
  // T15.7 — what went live, read from the TAIL's own records. `attempted: false` is a real answer and
  // is never rendered as silence: a run whose publish_executor refused (operator veto, autonomy policy
  // gate, or nothing publishable) must say so, because "no publication block" and "published nothing"
  // look identical to a reader otherwise. objectPublish is the custom field capture's publish_executor
  // dispatch (captureConductorRoutes.ts) stamps onto the shared publish_execution.v1 shape.
  const publishExecution = isRecord(input.publishExecution) ? input.publishExecution : undefined;
  const objectPublish = publishExecution && isRecord(publishExecution.objectPublish) ? publishExecution.objectPublish as Record<string, unknown> : undefined;
  const releaseExecution = isRecord(input.releaseExecution) ? input.releaseExecution : undefined;
  const publicationBlock = objectPublish
    ? {
        attempted: true,
        published: Array.isArray(objectPublish.published) ? objectPublish.published : [],
        failed: Array.isArray(objectPublish.failed) ? objectPublish.failed : [],
        withheld: Array.isArray(objectPublish.withheld) ? objectPublish.withheld : [],
        release: releaseExecution
          ? { status: releaseExecution.status, releaseId: releaseExecution.releaseId, deployedSha: releaseExecution.deployedSha, verification: releaseExecution.verification }
          : null,
        note: "Capture publishes by default (T15.7: through the shared publishing tail's publish_executor/release_executor — the same machinery publishing_conductor uses). An object went live when this run's own validation of it passed and nothing quarantined it; everything held back is named above with its reason. trigger_netlify_build and deploy remain unreachable from every capture path."
      }
    : {
        attempted: false,
        published: [],
        failed: [],
        withheld: [],
        release: null,
        note: "The tail's publish_executor did not run or was refused for this run (operator veto, the project's autonomy policy, or an upstream controller no-go), so everything written is still an unreleased draft. The run record's publish_executor node carries the refusal code."
      };
  const humanSummary = adjudicatorSummary
    ?? `Deterministic fallback summary (no adjudicator narrative on this run): verdict "${input.fidelity.rubric.verdict}", coverage ${(input.fidelity.rubric.coverage.score * 100).toFixed(2)}% against a ${(input.fidelity.rubric.coverage.minimum * 100).toFixed(0)}% bar, ${gapReport.entries.length} residual gap(s) across ${gapReport.byCapability.length} missing capabilit(ies). Every gap is enumerated in the W10 evidence feed below.`;
  return {
    artifact: CAPTURE_ARTIFACTS.report,
    summary: `Capture run report for ${input.targetProjectId}: ${emissionReport?.createdObjects?.length ?? 0} draft(s) created, verdict "${input.fidelity.rubric.verdict}", ${gapReport.entries.length} residual gap(s) fed to the W10 evidence backlog; ${publicationBlock.attempted ? `${publicationBlock.published.length} object(s) published live, ${publicationBlock.withheld.length} withheld` : "nothing published (publish stage did not run)"}.`,
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
    publication: publicationBlock
  };
}
