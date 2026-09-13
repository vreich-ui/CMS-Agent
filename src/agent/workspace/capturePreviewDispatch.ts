// W2.1/G6-T2 — the capture_score stage's draft-preview leg.
//
// ## What was missing, and why it is not fixed here
//
// `scoreVisuals` resolves BOTH sides of every visual pair to local files. cms-agent has neither
// side: its Cloud Run image carries no Chromium, no Astro and no `sharp`, and the source
// screenshots live in pdf-tool's own Blob store. So the conductor called `captureScoreStep` with no
// `previewManifest` and no `screenshotRoot`, every pair read `unavailable`, and the run reported
// `visual 0 scored / N unavailable` while completing normally.
//
// The rendering and the pixel diff therefore happen on the platform repo's CI (W2.1/G6-T1), which
// already has all four of those things plus `preview.mjs` and `score.mjs`. THIS module is only the
// dispatch and the collection: it starts that job, waits across advances the way `capture_crawl`
// and `capture_emit_live` already wait, and brings back one small document — the fidelity report
// the CI run produced.
//
// ## Why the run comes back through GitHub rather than a callback
//
// A callback would mean a new inbound cms-agent endpoint that CI may write run state through. This
// pulls instead: cms-agent is the only party that writes cms-agent state, and the trust boundary
// stays one-directional.
//
// ## Why documents travel as git blobs
//
// A workflow_dispatch payload is capped near 64 KB; Zilberman's snapshot alone is 187 KB and its
// mapping 120 KB. Each document is written as an unreferenced git blob (no commit, no branch, no
// tree — a transport, not history) and only its 40-character sha travels as a dispatch input. The
// CI job reads them back with its own GITHUB_TOKEN. The report returns the same way: the job writes
// it as a blob and names a marker artifact after the sha, so collection is a JSON read rather than
// downloading and unzipping an artifact archive.
//
// ## Degrading honestly
//
// Every failure mode here — no token configured, no site directory derivable, a dispatch refused, a
// CI run that never appears or never finishes — resolves to `unavailable` with a NAMED reason, and
// the score stage then scores exactly as it did before with `visualEvidence.evidenceComplete:
// false` (W2.1/G6-T3) saying so out loud. A capture run must not be blocked because a preview job
// could not be started; it must not silently claim the evidence is fine either.
import type { WorkflowExecutionRecord } from "./executionTypes.js";

/** The run's cross-advance bookkeeping for the preview dispatch. ":"-suffixed like its siblings so
 * it can never collide with a node id in run.stageOutputs. */
export const CAPTURE_SCORE_PREVIEW_STAGE_KEY = "capture_score:preview";

/** Artifact-name prefix the CI job uses to publish the report blob's sha. */
export const CAPTURE_PREVIEW_REPORT_BLOB_ARTIFACT_PREFIX = "capture-fidelity-report-blob-";

/** How long a dispatched preview may stay unfinished before the stage stops waiting for it. The CI
 * job's own `timeout-minutes` is 45; this is that plus queueing slack. */
export const CAPTURE_PREVIEW_MAX_WAIT_MS = 60 * 60 * 1000;

export type CapturePreviewState = {
  status: "dispatched" | "collected" | "unavailable";
  /** Matches the CI run's `run-name`, which is how a dispatch is tied to the run it produced —
   * GitHub does not return a workflow run's inputs. */
  correlationId: string;
  dispatchedAt: string;
  updatedAt: string;
  attempts: number;
  workflowRunId?: number;
  reportBlobSha?: string;
  /** Present on `unavailable`: the named reason the stage reports instead of a score. */
  reason?: string;
};

export type CapturePreviewOutcome =
  | { kind: "pending"; state: CapturePreviewState; note: string }
  | { kind: "collected"; state: CapturePreviewState; report: Record<string, unknown> }
  | { kind: "unavailable"; state: CapturePreviewState; reason: string };

export type CapturePreviewConfig = {
  token: string;
  repository: string;
  workflow: string;
  ref: string;
  apiBaseUrl: string;
};

export type CapturePreviewDeps = { fetchImpl?: typeof fetch; now?: () => Date };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Configuration, or undefined when this deployment is not wired to a platform CI. Undefined is a
 * legitimate state (local runs, a fresh environment), not an error — the caller degrades.
 */
export function capturePreviewConfig(env: NodeJS.ProcessEnv = process.env): CapturePreviewConfig | undefined {
  const token = env.CAPTURE_PREVIEW_GITHUB_TOKEN?.trim();
  if (!token) return undefined;
  return {
    token,
    repository: env.CAPTURE_PREVIEW_REPOSITORY?.trim() || "vreich-ui/platform",
    workflow: env.CAPTURE_PREVIEW_WORKFLOW?.trim() || "capture-preview.yaml",
    ref: env.CAPTURE_PREVIEW_REF?.trim() || "main",
    apiBaseUrl: env.CAPTURE_PREVIEW_GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
  };
}

/**
 * The tenant's site directory in the platform repo.
 *
 * Derived from the registry's own `objectDialect.siteObjectId` by the convention the fleet has used
 * since the first tenant (`site_zilberman` ⇄ `sites/zilberman`). A project that declares no site
 * object id, or one that does not follow the convention, yields undefined — and the caller reports
 * a named `unavailable` rather than guessing a directory and previewing the wrong tenant.
 */
export function previewSiteDirFor(siteObjectId: string | undefined): string | undefined {
  const trimmed = siteObjectId?.trim() ?? "";
  if (!trimmed.startsWith("site_")) return undefined;
  const slug = trimmed.slice("site_".length);
  return /^[a-z0-9][a-z0-9-]*$/i.test(slug) ? `sites/${slug}` : undefined;
}

export function readCapturePreviewState(run: WorkflowExecutionRecord): CapturePreviewState | undefined {
  const value = run.stageOutputs[CAPTURE_SCORE_PREVIEW_STAGE_KEY];
  if (!isRecord(value) || typeof value.correlationId !== "string" || !value.correlationId) return undefined;
  const status = value.status;
  if (status !== "dispatched" && status !== "collected" && status !== "unavailable") return undefined;
  return {
    status,
    correlationId: value.correlationId,
    dispatchedAt: typeof value.dispatchedAt === "string" ? value.dispatchedAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    attempts: typeof value.attempts === "number" ? value.attempts : 0,
    ...(typeof value.workflowRunId === "number" ? { workflowRunId: value.workflowRunId } : {}),
    ...(typeof value.reportBlobSha === "string" ? { reportBlobSha: value.reportBlobSha } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {})
  };
}

class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

async function github(
  config: CapturePreviewConfig,
  pathname: string,
  init: { method?: string; body?: unknown } = {},
  deps: CapturePreviewDeps = {}
): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.apiBaseUrl}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${config.token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GitHubError(response.status, `GitHub ${init.method ?? "GET"} ${pathname} failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }
  if (response.status === 204) return undefined;
  return await response.json().catch(() => undefined);
}

/** One unreferenced blob per document. Returns its sha. */
export async function writeGitBlob(config: CapturePreviewConfig, document: unknown, deps: CapturePreviewDeps = {}): Promise<string> {
  const created = await github(
    config,
    `/repos/${config.repository}/git/blobs`,
    { method: "POST", body: { content: Buffer.from(JSON.stringify(document), "utf8").toString("base64"), encoding: "base64" } },
    deps
  );
  const sha = isRecord(created) && typeof created.sha === "string" ? created.sha : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubError(502, "GitHub accepted the blob but returned no sha.");
  return sha;
}

export async function readGitBlobJson(config: CapturePreviewConfig, sha: string, deps: CapturePreviewDeps = {}): Promise<Record<string, unknown>> {
  const blob = await github(config, `/repos/${config.repository}/git/blobs/${sha}`, {}, deps);
  if (!isRecord(blob) || typeof blob.content !== "string") throw new GitHubError(502, `Blob ${sha} carries no content.`);
  const encoding = typeof blob.encoding === "string" ? blob.encoding : "base64";
  const text = encoding === "base64" ? Buffer.from(blob.content, "base64").toString("utf8") : blob.content;
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new GitHubError(502, `Blob ${sha} is not a JSON object.`);
  return parsed;
}

/**
 * Find the workflow run this dispatch produced. GitHub does not return a run's inputs, so the
 * correlation travels in the workflow's `run-name`, which the CI job sets from the same input.
 */
export async function findDispatchedRun(config: CapturePreviewConfig, correlationId: string, deps: CapturePreviewDeps = {}) {
  const listed = await github(
    config,
    `/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?event=workflow_dispatch&per_page=50`,
    {},
    deps
  );
  const runs = isRecord(listed) && Array.isArray(listed.workflow_runs) ? listed.workflow_runs : [];
  for (const candidate of runs) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.name === "string" && candidate.name.includes(correlationId)) {
      return {
        id: typeof candidate.id === "number" ? candidate.id : undefined,
        status: typeof candidate.status === "string" ? candidate.status : "unknown",
        conclusion: typeof candidate.conclusion === "string" ? candidate.conclusion : null
      };
    }
  }
  return undefined;
}

/** The report blob's sha, published by the CI job as a marker artifact's NAME. */
export async function findReportBlobSha(config: CapturePreviewConfig, workflowRunId: number, deps: CapturePreviewDeps = {}): Promise<string | undefined> {
  const listed = await github(config, `/repos/${config.repository}/actions/runs/${workflowRunId}/artifacts?per_page=100`, {}, deps);
  const artifacts = isRecord(listed) && Array.isArray(listed.artifacts) ? listed.artifacts : [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact.name !== "string") continue;
    if (!artifact.name.startsWith(CAPTURE_PREVIEW_REPORT_BLOB_ARTIFACT_PREFIX)) continue;
    const sha = artifact.name.slice(CAPTURE_PREVIEW_REPORT_BLOB_ARTIFACT_PREFIX.length).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return undefined;
}

export type CapturePreviewDispatchInput = {
  runId: string;
  nodeId: string;
  targetProjectId: string;
  siteDir: string;
  captureJobId?: string;
  captureRequestId?: string;
  documents: { snapshot: unknown; mapping: unknown; plan: unknown; theme: unknown };
};

/**
 * Advance the preview leg by exactly one step, the way every other pending stage in this file's
 * neighbourhood does: never spin, never block, return what the route should persist.
 */
export async function advanceCapturePreview(
  input: CapturePreviewDispatchInput & { config: CapturePreviewConfig; state?: CapturePreviewState },
  deps: CapturePreviewDeps = {}
): Promise<CapturePreviewOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const { config, state } = input;

  if (!state) {
    const correlationId = `${input.runId}:${input.nodeId}:${now.getTime().toString(36)}`;
    let blobs: { snapshot: string; mapping: string; plan: string; theme: string };
    try {
      const [snapshot, mapping, plan, theme] = await Promise.all([
        writeGitBlob(config, input.documents.snapshot, deps),
        writeGitBlob(config, input.documents.mapping, deps),
        writeGitBlob(config, input.documents.plan, deps),
        writeGitBlob(config, input.documents.theme, deps)
      ]);
      blobs = { snapshot, mapping, plan, theme };
    } catch (error) {
      return unavailable(correlationId, now, `capture_preview_inputs_not_transferable: ${message(error)}`);
    }
    try {
      await github(
        config,
        `/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`,
        {
          method: "POST",
          body: {
            ref: config.ref,
            inputs: {
              target: input.targetProjectId,
              site: input.siteDir,
              snapshot_blob: blobs.snapshot,
              mapping_blob: blobs.mapping,
              plan_blob: blobs.plan,
              theme_blob: blobs.theme,
              cms_run_id: correlationId,
              ...(input.captureJobId ? { capture_job_id: input.captureJobId } : {}),
              ...(input.captureRequestId ? { capture_request_id: input.captureRequestId } : {})
            }
          }
        },
        deps
      );
    } catch (error) {
      return unavailable(correlationId, now, `capture_preview_dispatch_refused: ${message(error)}`);
    }
    const dispatched: CapturePreviewState = {
      status: "dispatched",
      correlationId,
      dispatchedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      attempts: 0
    };
    return { kind: "pending", state: dispatched, note: `capture_score_preview_dispatched:${correlationId}` };
  }

  if (state.status === "unavailable") return { kind: "unavailable", state, reason: state.reason ?? "capture_preview_unavailable" };

  const waited = now.getTime() - Date.parse(state.dispatchedAt);
  const next: CapturePreviewState = { ...state, attempts: state.attempts + 1, updatedAt: now.toISOString() };

  let workflowRunId = state.workflowRunId;
  if (workflowRunId === undefined) {
    let found;
    try {
      found = await findDispatchedRun(config, state.correlationId, deps);
    } catch (error) {
      // A transient GitHub read is not evidence the run is gone; keep waiting until the ceiling.
      return waitOrGiveUp(next, waited, `capture_preview_run_lookup_failed: ${message(error)}`);
    }
    if (!found?.id) return waitOrGiveUp(next, waited, "capture_preview_run_not_found_yet");
    workflowRunId = found.id;
    next.workflowRunId = workflowRunId;
    if (found.status !== "completed") return { kind: "pending", state: next, note: `capture_score_preview_running:${workflowRunId}` };
  }

  let run;
  try {
    run = (await github(config, `/repos/${config.repository}/actions/runs/${workflowRunId}`, {}, deps)) as Record<string, unknown>;
  } catch (error) {
    return waitOrGiveUp(next, waited, `capture_preview_run_read_failed: ${message(error)}`);
  }
  if (run?.status !== "completed") return { kind: "pending", state: next, note: `capture_score_preview_running:${workflowRunId}` };

  let sha = state.reportBlobSha;
  if (!sha) {
    try {
      sha = await findReportBlobSha(config, workflowRunId, deps);
    } catch (error) {
      return waitOrGiveUp(next, waited, `capture_preview_report_lookup_failed: ${message(error)}`);
    }
  }
  if (!sha) {
    // The job finished without publishing a report. That is a real, terminal outcome — the run's
    // conclusion says why — and it is reported, never retried into a loop.
    return {
      kind: "unavailable",
      state: { ...next, status: "unavailable", reason: `capture_preview_report_absent:${String(run.conclusion ?? "unknown")}` },
      reason: `capture_preview_report_absent:${String(run.conclusion ?? "unknown")}`
    };
  }
  next.reportBlobSha = sha;
  let report: Record<string, unknown>;
  try {
    report = await readGitBlobJson(config, sha, deps);
  } catch (error) {
    return waitOrGiveUp(next, waited, `capture_preview_report_unreadable: ${message(error)}`);
  }
  return { kind: "collected", state: { ...next, status: "collected" }, report };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

const unavailable = (correlationId: string, now: Date, reason: string): CapturePreviewOutcome => ({
  kind: "unavailable",
  state: { status: "unavailable", correlationId, dispatchedAt: now.toISOString(), updatedAt: now.toISOString(), attempts: 0, reason },
  reason
});

/** Waiting is bounded. Past the ceiling the stage stops waiting and says why, rather than re-queueing
 * a node forever behind a CI run that is never going to answer. */
function waitOrGiveUp(state: CapturePreviewState, waitedMs: number, note: string): CapturePreviewOutcome {
  if (waitedMs > CAPTURE_PREVIEW_MAX_WAIT_MS) {
    const reason = `capture_preview_timed_out_after_${Math.round(waitedMs / 1000)}s: ${note}`;
    return { kind: "unavailable", state: { ...state, status: "unavailable", reason }, reason };
  }
  return { kind: "pending", state, note: `capture_score_preview_pending:${note}` };
}
