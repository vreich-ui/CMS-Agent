// Operator-facing MCP surface over the fleet credential reconciler
// (src/agent/capture/siteCredentialReconciler.ts). Today the reconciler can only be run by a human
// typing `gcloud run jobs execute site-credential-reconciler` — no operator screen can show them
// what would change or fire an apply, and nothing schedules it. These three tools close that gap:
//
//   site_credentials_plan             — read-only dry run, in-process, no Cloud Run involved.
//   site_credentials_apply            — fires the Cloud Run Job and returns immediately.
//   site_credentials_execution_status — polls one fired execution.
//
// WHY apply FIRES A JOB INSTEAD OF RUNNING THE RECONCILER IN-PROCESS. A live apply mints
// credentials, writes Netlify secrets, and waits out a full production deploy per rotated tenant
// (NetlifyGenesisClient.rebuildAndWaitForPublishedDeploy — minutes, not seconds). That is exactly
// the class of work RUN_DRIVER_TIME_BUDGET_CEILING_MS exists to keep out of an MCP tool call: doing
// it here would either time out mid-rotation or hold an HTTP request open for minutes. The Cloud Run
// Job already exists, is already the audited execution surface (scripts/deploy-site-credential-
// reconciler.sh), and returns quickly once started — so apply's whole job is to start it and hand
// back an execution name the caller polls.
//
// WHY THIS NEEDS NO NEW DEPENDENCY. Both Google calls here — the metadata-server access token and
// the Cloud Run Jobs REST API — are plain `fetch`, the same zero-dependency shape
// projects/secretManager.ts already uses for the identical metadata-server handshake. Pulling in
// @google-cloud/run would be the first GCP client library in this deliberately dependency-light
// repo for a job this small.
//
// SECRET DISCIPLINE, unchanged from every other genesis/reconciler surface in this codebase: no
// bearer, Netlify token, or GCP access token is ever placed in a return value, an error message, or
// a log line. Cloud Run error bodies are Google's own structured {error:{code,message,status}} and
// carry operational detail (which permission is missing, which resource was not found) — never a
// credential — so surfacing `error.message` verbatim is safe and is what makes the 403 guidance
// below possible without inventing a parallel error taxonomy.
import { z } from "zod";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import { planeAccessToken } from "../../projects/secretManager.js";
import { reconcileSiteClientManagerCredentials } from "../../capture/siteCredentialReconciler.js";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";

export class SiteCredentialOpsRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SiteCredentialOpsRefusal";
  }
}

// Env contract, named and validated the way siteGenesis.ts names and validates NETLIFY_API_TOKEN_ENV
// / CMS_AGENT_PUBLIC_MCP_ENDPOINT_ENV: one exported constant per variable, and a missing value is a
// catalogued refusal (never an unhandled throw, never a silent default for the GCP identity itself).
export const SITE_CREDENTIAL_RECONCILER_GCP_PROJECT_ENV = "SITE_CREDENTIAL_RECONCILER_GCP_PROJECT";
export const SITE_CREDENTIAL_RECONCILER_REGION_ENV = "SITE_CREDENTIAL_RECONCILER_REGION";
export const SITE_CREDENTIAL_RECONCILER_JOB_ENV = "SITE_CREDENTIAL_RECONCILER_JOB";
export const DEFAULT_SITE_CREDENTIAL_RECONCILER_JOB = "site-credential-reconciler";

// The Cloud Run Job's fixed container command, repeated in full on every apply. Cloud Run REPLACES
// (never merges) the configured args list on a containerOverride — the same warning lives in
// docs/mcp-scoped-bearer-auth.md next to the equivalent gcloud invocation. Passing only ["--apply"]
// here would silently drop `--import tsx src/agent/entrypoints/reconcileSiteCredentialsMain.ts`, so
// the job would exec `node` with no script: it exits 0, reports nothing, and rotates nothing, and an
// operator watching only the exit code would see success. Keep this array in lockstep with the
// --args the deploy script configures (scripts/deploy-site-credential-reconciler.sh) and the
// schedule script fires (scripts/deploy-site-credential-reconciler-schedule.sh).
export const SITE_CREDENTIAL_RECONCILER_APPLY_ARGS = [
  "--import",
  "tsx",
  "src/agent/entrypoints/reconcileSiteCredentialsMain.ts",
  "--apply"
];

// An execution resource name always has this shape: projects/{p}/locations/{l}/jobs/{j}/executions/{e}.
// Validating it before use keeps a caller-supplied executionName from steering the GET anywhere but
// a Cloud Run execution resource on the fixed run.googleapis.com host.
const EXECUTION_NAME_RE = /^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+\/executions\/[^/]+$/;

export type CloudRunFetchResponse = { ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string> };
export type CloudRunFetch = (input: string, init?: Record<string, unknown>) => Promise<CloudRunFetchResponse>;

const resolveReconcilerJobConfig = (env: NodeJS.ProcessEnv): { project: string; region: string; job: string } => {
  const project = env[SITE_CREDENTIAL_RECONCILER_GCP_PROJECT_ENV]?.trim();
  if (!project) {
    throw new SiteCredentialOpsRefusal(
      "site_credential_reconciler_project_missing",
      `${SITE_CREDENTIAL_RECONCILER_GCP_PROJECT_ENV} must name the GCP project hosting the ${DEFAULT_SITE_CREDENTIAL_RECONCILER_JOB} Cloud Run Job; apply cannot address a job with no project.`
    );
  }
  const region = env[SITE_CREDENTIAL_RECONCILER_REGION_ENV]?.trim();
  if (!region) {
    throw new SiteCredentialOpsRefusal(
      "site_credential_reconciler_region_missing",
      `${SITE_CREDENTIAL_RECONCILER_REGION_ENV} must name the Cloud Run region hosting the job (e.g. us-central1).`
    );
  }
  const job = env[SITE_CREDENTIAL_RECONCILER_JOB_ENV]?.trim() || DEFAULT_SITE_CREDENTIAL_RECONCILER_JOB;
  return { project, region, job };
};

// The plane's own OAuth access token, via secretManager.ts's shared planeAccessToken.
//
// Deliberately NOT a second metadata-server handshake. There is one correct metadata path (the
// account segment is not optional — omitting it 404s on a real metadata server, which cost a
// dedicated fix commit), one host-fallback order, and one token cache. A hand-rolled copy here
// would be a second place for that exact bug to reappear, and would miss the 169.254.169.254
// fallback and the GCE_METADATA_HOST override the shared helper already handles.
async function fetchCloudRunAccessToken(
  env: NodeJS.ProcessEnv,
  fetchImpl: CloudRunFetch,
  useAmbientCredentials: boolean
): Promise<string> {
  // planeAccessToken takes the platform fetch signature; CloudRunFetch is the same call shape
  // narrowed to the fields used here (ok/status/json), so the injected stub a test supplies works
  // unchanged and the metadata handshake stays exercisable without a real metadata server.
  //
  // T12.20 added `useAmbientCredentials`: ADC is tried before the metadata handshake, which is the
  // correct production path but reaches the HOST's real gcloud credentials. Passing `!deps.fetchImpl`
  // — the same discriminator secretManager.ts's own caller uses — keeps that off whenever a test has
  // injected a fetch stub, so these tools stay hermetic instead of silently depending on whoever
  // happens to be logged in.
  const result = await planeAccessToken(fetchImpl as unknown as typeof fetch, () => Date.now(), env, useAmbientCredentials);
  if ("error" in result) {
    throw new SiteCredentialOpsRefusal(
      "cloud_run_identity_unavailable",
      `This plane could not obtain a Google access token, so it cannot reach the Cloud Run Jobs API (${result.error}). site_credentials_apply and site_credentials_execution_status only work from a Google Cloud plane running under a service account.`
    );
  }
  return result.token;
}

// Google's error body for a denied API call is {error:{code,message,status}} — operational detail
// (which permission, which resource), never a credential. Safe to surface verbatim; still bounded to
// just the message field so an unexpected non-JSON body (a proxy error page, say) can never leak
// wholesale into a tool result.
async function safeErrorDetail(response: CloudRunFetchResponse): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } } | undefined;
    const message = typeof body?.error?.message === "string" ? body.error.message : undefined;
    return message ? ` ${message}` : "";
  } catch {
    return "";
  }
}

async function runReconcilerJob(
  config: { project: string; region: string; job: string },
  accessToken: string,
  fetchImpl: CloudRunFetch
): Promise<{ executionName: string; jobName: string }> {
  const jobName = `projects/${config.project}/locations/${config.region}/jobs/${config.job}`;
  const runUrl = `https://run.googleapis.com/v2/${jobName}:run`;
  let response: CloudRunFetchResponse;
  try {
    response = await fetchImpl(runUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: { containerOverrides: [{ args: SITE_CREDENTIAL_RECONCILER_APPLY_ARGS }] } })
    });
  } catch (error) {
    throw new SiteCredentialOpsRefusal("cloud_run_run_failed", `Cloud Run Jobs API was unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    if (response.status === 403) {
      throw new SiteCredentialOpsRefusal(
        "cloud_run_run_forbidden",
        `Cloud Run refused to run job "${config.job}" (HTTP 403) — most likely this plane's service account is missing the run.jobs.run IAM permission on that job (grant it via roles/run.invoker or roles/run.developer), then retry.`
      );
    }
    throw new SiteCredentialOpsRefusal("cloud_run_run_failed", `Cloud Run Jobs API refused the run request for "${config.job}": HTTP ${response.status}${await safeErrorDetail(response)}`);
  }
  // POST .../jobs/{job}:run returns a long-running Operation whose `metadata` is the in-progress
  // Execution resource being created; its `name` is the full execution resource name callers poll.
  const body = (await response.json().catch(() => ({}))) as { metadata?: { name?: unknown } };
  const executionName = typeof body.metadata?.name === "string" ? body.metadata.name : undefined;
  if (!executionName) throw new SiteCredentialOpsRefusal("cloud_run_execution_name_missing", "Cloud Run accepted the run request but the response carried no execution resource name.");
  return { executionName, jobName };
}

type CloudRunExecutionBody = {
  startTime?: unknown;
  completionTime?: unknown;
  succeededCount?: unknown;
  failedCount?: unknown;
  conditions?: unknown;
};

// The Execution resource has no single `state` enum field — Cloud Run reports progress through a
// `conditions` array (a top-level "Completed" condition whose `state` is one of
// CONDITION_SUCCEEDED/CONDITION_FAILED/CONDITION_PENDING/CONDITION_RECONCILING) and separately
// through timestamps/counts. Prefer the condition when present; fall back to timestamps so a
// partial or older-shaped response still yields a sensible answer instead of "unknown" for every
// caller.
const deriveExecutionState = (body: CloudRunExecutionBody): string => {
  const conditions = Array.isArray(body.conditions) ? (body.conditions as Array<{ type?: unknown; state?: unknown }>) : [];
  const completed = conditions.find((condition) => condition.type === "Completed");
  const rawState = typeof completed?.state === "string" ? completed.state : undefined;
  if (rawState === "CONDITION_SUCCEEDED") return "succeeded";
  if (rawState === "CONDITION_FAILED") return "failed";
  if (rawState === "CONDITION_PENDING" || rawState === "CONDITION_RECONCILING") return "running";
  if (typeof body.completionTime === "string") {
    const failedCount = typeof body.failedCount === "number" ? body.failedCount : 0;
    return failedCount > 0 ? "failed" : "succeeded";
  }
  if (typeof body.startTime === "string") return "running";
  return "pending";
};

async function getExecutionStatus(executionName: string, accessToken: string, fetchImpl: CloudRunFetch) {
  let response: CloudRunFetchResponse;
  try {
    response = await fetchImpl(`https://run.googleapis.com/v2/${executionName}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    throw new SiteCredentialOpsRefusal("cloud_run_status_failed", `Cloud Run Jobs API was unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    if (response.status === 403) {
      throw new SiteCredentialOpsRefusal(
        "cloud_run_status_forbidden",
        `Cloud Run refused to read execution "${executionName}" (HTTP 403) — this plane's service account needs the run.jobs.run IAM permission (roles/run.invoker or roles/run.developer) on the job that owns this execution.`
      );
    }
    throw new SiteCredentialOpsRefusal("cloud_run_status_failed", `Cloud Run Jobs API refused the status read for "${executionName}": HTTP ${response.status}${await safeErrorDetail(response)}`);
  }
  const body = (await response.json().catch(() => ({}))) as CloudRunExecutionBody;
  const succeededCount = typeof body.succeededCount === "number" ? body.succeededCount : undefined;
  const failedCount = typeof body.failedCount === "number" ? body.failedCount : undefined;
  return {
    state: deriveExecutionState(body),
    ...(typeof body.startTime === "string" ? { startedAt: body.startTime } : {}),
    ...(typeof body.completionTime === "string" ? { completedAt: body.completionTime } : {}),
    ...(succeededCount !== undefined ? { succeededCount } : {}),
    ...(failedCount !== undefined ? { failedCount } : {})
  };
}

const emptyInput = z.object({}).strict();
const emptyJsonSchema = objectSchema();
const executionStatusInput = z.object({ executionName: z.string().min(1) }).strict();
const executionStatusJsonSchema = objectSchema(
  { executionName: { type: "string", minLength: 1, description: "Full Cloud Run execution resource name returned by site_credentials_apply, e.g. projects/p/locations/r/jobs/site-credential-reconciler/executions/site-credential-reconciler-abcde." } },
  ["executionName"]
);

export type SiteCredentialToolDeps = {
  projectRepository: ProjectRepository;
  // Test/deployment seams only. Production always defaults to process.env / the global fetch;
  // no production call site should ever pass these.
  env?: NodeJS.ProcessEnv;
  fetchImpl?: CloudRunFetch;
};

export function createSiteCredentialTools(deps: SiteCredentialToolDeps): WorkspaceTool[] {
  const env = deps.env ?? process.env;
  const fetchImpl: CloudRunFetch = deps.fetchImpl ?? (fetch as unknown as CloudRunFetch);

  return [
    tool({
      name: "site_credentials_plan",
      description: "Read-only dry run of the fleet Client Manager credential reconciler: for every bearer_env project, reports whether its scoped chat bearer is current, would be rotated on an apply, or is unmanaged (no client-site binding, so the reconciler cannot act on it at all — see unmanagedCount). No Netlify or Cloud Run call — same in-process check reconcileSiteCredentialsMain.ts runs without --apply.",
      zodSchema: emptyInput,
      inputSchema: emptyJsonSchema,
      execute: async (input) => {
        emptyInput.parse(input);
        const results = await reconcileSiteClientManagerCredentials({ apply: false }, { projectRepository: deps.projectRepository });
        const staleCount = results.filter((result) => result.status === "planned").length;
        // Named and counted SEPARATELY from staleCount on purpose: "unmanaged" is not a project
        // waiting on an apply, it is one the reconciler cannot see a site for at all (see
        // siteCredentialReconciler.ts). Folding it into staleCount would let an existing reader who
        // only checks that one number silently misread "nothing to apply" when a tenant is actually
        // invisible to the reconciler — which is the exact incident this change exists to prevent.
        const unmanagedCount = results.filter((result) => result.status === "unmanaged").length;
        return ok({ mode: "dry_run", results, staleCount, unmanagedCount });
      }
    }),

    tool({
      name: "site_credentials_apply",
      description: "Fire the site-credential-reconciler Cloud Run Job with --apply and return immediately with its execution name. Never blocks: a live apply mints and installs credentials and waits out a production Netlify deploy per rotated tenant, which is minutes of work this MCP call cannot hold open. Poll progress with site_credentials_execution_status. Operator tool — not on any tenant's scoped chat allowlist.",
      zodSchema: emptyInput,
      inputSchema: emptyJsonSchema,
      execute: async (input) => {
        emptyInput.parse(input);
        const config = resolveReconcilerJobConfig(env);
        const accessToken = await fetchCloudRunAccessToken(env, fetchImpl, !deps.fetchImpl);
        const { executionName, jobName } = await runReconcilerJob(config, accessToken, fetchImpl);
        return ok({ executionName, jobName });
      }
    }),

    tool({
      name: "site_credentials_execution_status",
      description: "Poll one site_credentials_apply execution: state (succeeded/failed/running/pending), start/completion timestamps, and per-task succeeded/failed counts. Read-only. Operator tool — not on any tenant's scoped chat allowlist.",
      zodSchema: executionStatusInput,
      inputSchema: executionStatusJsonSchema,
      execute: async (input) => {
        const { executionName } = executionStatusInput.parse(input);
        if (!EXECUTION_NAME_RE.test(executionName)) {
          throw new SiteCredentialOpsRefusal("execution_name_invalid", `executionName must be a full Cloud Run execution resource name (projects/{project}/locations/{region}/jobs/{job}/executions/{execution}); got "${executionName}".`);
        }
        const accessToken = await fetchCloudRunAccessToken(env, fetchImpl, !deps.fetchImpl);
        return ok(await getExecutionStatus(executionName, accessToken, fetchImpl));
      }
    })
  ];
}
