// G2 — the scaffold half of tenant birth, dispatched to CI.
//
// ## The gap this closes
//
// Genesis mints a tenant end to end — Netlify site, deploy binding (G7), bearer custody, env
// defaults, registry record — and then stops, because the tenant's CODE has to exist in the platform
// repo and this Cloud Run image has no checkout of it. `sites/<slug>/` is produced by
// `create-site.mjs` running against a real working tree, and a new site is a new npm workspace, so
// the root lockfile has to be rebuilt by a real `npm install`. Neither is reproducible from an API
// call. So `scaffold_site_tree` and `commit_scaffold` have been human since the first tenant, and a
// mint has always ended with a Netlify site whose repo contains no tenant.
//
// The platform repo's `genesis-scaffold.yaml` does that work under a charter its own CI enforces
// (`scripts/ci/genesis-scaffold-guard.mjs`: one new tenant tree, the lockfile, the inventory, and
// nothing else). THIS module only starts it and reads the result.
//
// ## Why there is no state machine here
//
// A CI job takes minutes; `site.duplicate` is one call. The obvious design is a polled stage with
// persisted cross-advance state, which is what capture's preview leg needs. Genesis does not need
// it, because #354 already made a mint RESUMABLE: every step reads before it writes, so re-running
// the identical `site.duplicate` adopts everything that exists and completes only what is missing.
// The scaffold fits that model exactly —
//
//   run 1: no tenant tree in the repo  →  dispatch, and report a resumable blockage
//   run 2: the tree is there           →  the step reads it, records executed, moves on
//
// — so the ground truth is THE REPOSITORY, not the job, and nothing new has to be persisted. The
// correlation id is derived from the slug rather than stored for the same reason.
//
// ## Why this duplicates capture's GitHub helpers instead of importing them
//
// The house precedent is platform's object-git-committer, which duplicates ~60 lines of the article
// publisher deliberately so "a change to one publish path can never silently break the other". The
// same reasoning holds with more force here: a change to the capture preview's dispatch must not be
// able to break tenant birth, and the two want different failure semantics — capture degrades to an
// unscored run, genesis degrades to a resumable blockage.

import { GENESIS_ARTIFACT_INPUT_FIELDS } from "./genesisPolicy.js";

export const GENESIS_SCAFFOLD_GITHUB_TOKEN_ENV = "GENESIS_SCAFFOLD_GITHUB_TOKEN";
export const GENESIS_SCAFFOLD_REPOSITORY_ENV = "GENESIS_SCAFFOLD_REPOSITORY";
export const GENESIS_SCAFFOLD_WORKFLOW_ENV = "GENESIS_SCAFFOLD_WORKFLOW";
export const GENESIS_SCAFFOLD_REF_ENV = "GENESIS_SCAFFOLD_REF";
export const GENESIS_SCAFFOLD_API_BASE_URL_ENV = "GENESIS_SCAFFOLD_GITHUB_API_BASE_URL";

/** Artifact-name prefix the CI job publishes its result blob's sha under. */
export const GENESIS_SCAFFOLD_RESULT_BLOB_ARTIFACT_PREFIX = "genesis-scaffold-result-blob-";

/** The file whose presence at `ref` means the tenant's tree is in the repo. */
export const tenantTreeProbePath = (slug: string): string => `sites/${slug}/site.config.ts`;

/**
 * Derived, never stored. A resumed mint has to find the run its previous attempt started, and the
 * slug is the one identifier both attempts share — the registry record may not even exist yet on
 * the first. `project_exists` refuses a second mint of the same slug, so this cannot collide.
 *
 * TERMINATED with "#", which is not legal in a slug, because the match against a run's NAME is a
 * substring test: without the terminator "genesis-scaffold:acme" matches acme-labs' run, and the
 * acme mint would sit waiting for a job that is scaffolding a different tenant.
 */
export const scaffoldCorrelationId = (slug: string): string => `genesis-scaffold:${slug}#`;

export type GenesisScaffoldConfig = {
  token: string;
  repository: string;
  workflow: string;
  ref: string;
  apiBaseUrl: string;
};

export type GenesisScaffoldDeps = { fetchImpl?: typeof fetch; now?: () => Date };

/**
 * How long a SUCCEEDED run may go on explaining an absent tenant tree.
 *
 * The window it covers is the contents API catching up with a commit that landed — seconds. Past it
 * the successful run is stale evidence (the scaffold was reverted, or the slug was reused after a
 * tenant was deleted) and the honest move is to dispatch again rather than to keep answering
 * "completed, re-run to adopt it" forever.
 */
export const SUCCEEDED_RUN_TRUST_WINDOW_MS = 10 * 60 * 1000;

/**
 * No token, no config — and the caller then reports the scaffold as the human step it has always
 * been, rather than pretending it dispatched something. Deliberately does NOT fall back to
 * CAPTURE_PREVIEW_GITHUB_TOKEN: that token needs only blob write, this one commits to `main`, and
 * silently borrowing a credential for a more privileged purpose is how a blast radius grows without
 * anyone deciding to grow it.
 */
export function genesisScaffoldConfig(env: NodeJS.ProcessEnv = process.env): GenesisScaffoldConfig | undefined {
  const token = env[GENESIS_SCAFFOLD_GITHUB_TOKEN_ENV]?.trim();
  if (!token) return undefined;
  return {
    token,
    repository: env[GENESIS_SCAFFOLD_REPOSITORY_ENV]?.trim() || "vreich-ui/platform",
    workflow: env[GENESIS_SCAFFOLD_WORKFLOW_ENV]?.trim() || "genesis-scaffold.yaml",
    ref: env[GENESIS_SCAFFOLD_REF_ENV]?.trim() || "main",
    apiBaseUrl: env[GENESIS_SCAFFOLD_API_BASE_URL_ENV]?.trim() || "https://api.github.com"
  };
}

export class GenesisScaffoldError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GenesisScaffoldError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function github(
  config: GenesisScaffoldConfig,
  pathname: string,
  init: { method?: string; body?: unknown; notFoundIsAnswer?: boolean } = {},
  deps: GenesisScaffoldDeps = {}
): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.apiBaseUrl}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  });
  // 404 is an ANSWER for ONE caller — the contents probe, where it means "the tenant tree is not
  // there". For every other call it is a failure that must surface: POST /dispatches answers 404
  // when the workflow does not exist on the target ref (the state during any rollout) or the token
  // cannot see the repo, and swallowing that reports a dispatch that never happened, forever.
  if (response.status === 404 && init.notFoundIsAnswer) return undefined;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GenesisScaffoldError(response.status, `GitHub ${init.method ?? "GET"} ${pathname} failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }
  if (response.status === 204) return undefined;
  return await response.json().catch(() => undefined);
}

/** THE ground truth: is this tenant's tree in the repo? Not "did a job run", which is a proxy. */
export async function tenantTreeExists(config: GenesisScaffoldConfig, slug: string, deps: GenesisScaffoldDeps = {}): Promise<boolean> {
  const found = await github(
    config,
    `/repos/${config.repository}/contents/${tenantTreeProbePath(slug)}?ref=${encodeURIComponent(config.ref)}`,
    { notFoundIsAnswer: true },
    deps
  );
  return isRecord(found) && found.type === "file";
}

/** The genesis artifacts, as the one document the CI job unpacks. Absent bodies are simply absent —
 *  the fleet policy decides which are required, and create-site is what refuses. */
export function scaffoldArtifactsDocument(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const document: Record<string, unknown> = {};
  for (const field of Object.values(GENESIS_ARTIFACT_INPUT_FIELDS)) {
    if (input[field] !== undefined && input[field] !== null) document[field] = input[field];
  }
  return Object.keys(document).length ? document : undefined;
}

/** One unreferenced blob: no commit, no tree, no ref. A transport, not history. */
export async function writeScaffoldArtifactsBlob(config: GenesisScaffoldConfig, document: unknown, deps: GenesisScaffoldDeps = {}): Promise<string> {
  const created = await github(
    config,
    `/repos/${config.repository}/git/blobs`,
    { method: "POST", body: { content: Buffer.from(JSON.stringify(document), "utf8").toString("base64"), encoding: "base64" } },
    deps
  );
  const sha = isRecord(created) && typeof created.sha === "string" ? created.sha : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GenesisScaffoldError(502, "GitHub accepted the artifacts blob but returned no sha.");
  return sha;
}

export type ScaffoldRunOutcome =
  | { status: "none" }
  | { status: "running"; runId?: number }
  | { status: "succeeded"; runId: number; updatedAt?: string }
  /** The job ran and REFUSED. Re-dispatching repeats it, so the caller must say so. */
  | { status: "failed"; runId: number; reason: string; refusal?: Record<string, unknown> }
  /** The job was cancelled, timed out, or never started. Nothing was decided, so re-dispatching is
   *  the fix — the opposite advice from `failed`, which is why they are different states. */
  | { status: "abandoned"; runId: number; reason: string };

/**
 * Find the run this slug's dispatch produced, and what became of it.
 *
 * GitHub does not return a workflow run's INPUTS, so the correlation travels in the run NAME, which
 * the workflow sets from the same input. Matching by name is the whole contract.
 */
export async function findScaffoldRun(config: GenesisScaffoldConfig, slug: string, deps: GenesisScaffoldDeps = {}): Promise<ScaffoldRunOutcome> {
  const listed = await github(
    config,
    `/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?event=workflow_dispatch&per_page=50`,
    {},
    deps
  );
  const runs = isRecord(listed) && Array.isArray(listed.workflow_runs) ? listed.workflow_runs : [];
  const correlationId = scaffoldCorrelationId(slug);
  const match = runs.find((run) => isRecord(run) && typeof run.name === "string" && run.name.includes(correlationId));
  if (!isRecord(match) || typeof match.id !== "number") return { status: "none" };

  const runId = match.id;
  if (match.status !== "completed") return { status: "running", runId };
  if (match.conclusion === "success") {
    return { status: "succeeded", runId, ...(typeof match.updated_at === "string" ? { updatedAt: match.updated_at } : {}) };
  }
  // Nothing was decided by these, so they must not read as a refusal.
  if (match.conclusion === "cancelled" || match.conclusion === "timed_out" || match.conclusion === "stale" || match.conclusion === null) {
    return { status: "abandoned", runId, reason: `the scaffold job ended as "${String(match.conclusion ?? "no conclusion")}" without deciding anything` };
  }

  // A FAILED job is the outcome that matters most: without it a resumed mint re-dispatches forever
  // against a refusal that will never resolve on its own.
  const refusal = await readScaffoldResult(config, runId, deps).catch(() => undefined);
  const named = isRecord(refusal?.refusal) ? (refusal!.refusal as Record<string, unknown>) : undefined;
  return {
    status: "failed",
    runId,
    reason: typeof named?.error_code === "string" ? String(named.error_code) : `the scaffold job concluded "${String(match.conclusion)}"`,
    ...(named ? { refusal: named } : {})
  };
}

/** The job's own result document, pulled via the blob sha it published as a marker artifact's NAME. */
export async function readScaffoldResult(config: GenesisScaffoldConfig, runId: number, deps: GenesisScaffoldDeps = {}): Promise<Record<string, unknown> | undefined> {
  const listed = await github(config, `/repos/${config.repository}/actions/runs/${runId}/artifacts?per_page=100`, {}, deps);
  const artifacts = isRecord(listed) && Array.isArray(listed.artifacts) ? listed.artifacts : [];
  let blobSha: string | undefined;
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact.name !== "string") continue;
    if (!artifact.name.startsWith(GENESIS_SCAFFOLD_RESULT_BLOB_ARTIFACT_PREFIX)) continue;
    const candidate = artifact.name.slice(GENESIS_SCAFFOLD_RESULT_BLOB_ARTIFACT_PREFIX.length).trim();
    if (/^[0-9a-f]{40}$/.test(candidate)) blobSha = candidate;
  }
  if (!blobSha) return undefined;
  const blob = await github(config, `/repos/${config.repository}/git/blobs/${blobSha}`, {}, deps);
  if (!isRecord(blob) || typeof blob.content !== "string") return undefined;
  const text = blob.encoding === "base64" || blob.encoding === undefined ? Buffer.from(blob.content, "base64").toString("utf8") : blob.content;
  const parsed = JSON.parse(text) as unknown;
  return isRecord(parsed) ? parsed : undefined;
}

export type GenesisScaffoldDispatchInput = {
  slug: string;
  brandName?: string;
  canonicalHost?: string;
  niche?: string;
  artifacts?: Record<string, unknown>;
};

export async function dispatchGenesisScaffold(config: GenesisScaffoldConfig, input: GenesisScaffoldDispatchInput, deps: GenesisScaffoldDeps = {}): Promise<void> {
  const artifactsBlob = input.artifacts ? await writeScaffoldArtifactsBlob(config, input.artifacts, deps) : undefined;
  await github(
    config,
    `/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`,
    {
      method: "POST",
      body: {
        ref: config.ref,
        inputs: {
          slug: input.slug,
          cms_run_id: scaffoldCorrelationId(input.slug),
          ...(input.brandName ? { brand_name: input.brandName } : {}),
          ...(input.canonicalHost ? { canonical_host: input.canonicalHost } : {}),
          ...(input.niche ? { niche: input.niche } : {}),
          ...(artifactsBlob ? { artifacts_blob: artifactsBlob } : {})
        }
      }
    },
    deps
  );
}

export type GenesisScaffoldStep =
  /** The tree is in the repo. Whether this mint put it there or a previous attempt did is the same fact. */
  | { kind: "present" }
  /** Dispatched (or already running). The mint stops here with a RESUMABLE blockage. */
  | { kind: "dispatched"; detail: string }
  | { kind: "running"; detail: string }
  /** The job ran and refused. Re-running would repeat it, so the caller must say so out loud. */
  | { kind: "failed"; detail: string; refusal?: Record<string, unknown> }
  /** No dispatch configured, or the attempt itself broke. The scaffold stays the human step it was. */
  | { kind: "unavailable"; reason: string };

/**
 * Advance the scaffold by exactly one step: probe, then dispatch at most once.
 *
 * The probe comes FIRST and is the only thing that can return `present`, so a mint resumed after the
 * job landed needs no job history at all — and a tree scaffolded by hand, or by an earlier
 * PLATFORM_REPO_ROOT run, is adopted just the same.
 */
export async function advanceGenesisScaffold(
  config: GenesisScaffoldConfig,
  input: GenesisScaffoldDispatchInput,
  deps: GenesisScaffoldDeps = {}
): Promise<GenesisScaffoldStep> {
  try {
    if (await tenantTreeExists(config, input.slug, deps)) return { kind: "present" };

    const run = await findScaffoldRun(config, input.slug, deps);
    if (run.status === "running") {
      return { kind: "running", detail: `The genesis-scaffold job for "${input.slug}" is still running (run ${run.runId ?? "?"}). Re-run the identical site.duplicate call once it lands and this step adopts the tree it commits.` };
    }
    if (run.status === "failed") {
      return {
        kind: "failed",
        detail: `The genesis-scaffold job for "${input.slug}" (run ${run.runId}) did not land the tenant tree: ${run.reason}. Re-running site.duplicate will not fix it — resolve the cause first.`,
        ...(run.refusal ? { refusal: run.refusal } : {})
      };
    }
    if (run.status === "abandoned") {
      // Re-dispatch. Nothing was decided, so the previous run is not evidence of anything.
      await dispatchGenesisScaffold(config, input, deps);
      return { kind: "dispatched", detail: `The previous genesis-scaffold job for "${input.slug}" (run ${run.runId}) ${run.reason}, so it was dispatched again on ${config.repository}@${config.ref}. Re-run the identical site.duplicate call once it lands.` };
    }
    // `succeeded` with no tree is the contents API catching up with a commit that landed — seconds,
    // so it is trusted for a bounded window and no longer. Past that the run is stale evidence and
    // the tenant needs a new job, not a permanent "re-run to adopt it".
    if (run.status === "succeeded") {
      const completedAt = run.updatedAt ? Date.parse(run.updatedAt) : Number.NaN;
      const nowMs = (deps.now?.() ?? new Date()).getTime();
      const stale = Number.isFinite(completedAt) && nowMs - completedAt > SUCCEEDED_RUN_TRUST_WINDOW_MS;
      if (!stale) {
        return { kind: "running", detail: `The genesis-scaffold job for "${input.slug}" (run ${run.runId}) completed; the tenant tree is not visible at ${config.repository}@${config.ref} yet. Re-run site.duplicate to adopt it.` };
      }
      await dispatchGenesisScaffold(config, input, deps);
      return { kind: "dispatched", detail: `The last successful genesis-scaffold job for "${input.slug}" (run ${run.runId}) completed at ${run.updatedAt}, but sites/${input.slug}/ is not in ${config.repository}@${config.ref} — the scaffold was reverted, or this slug is being reused. Dispatched a fresh job; re-run the identical site.duplicate call once it lands.` };
    }

    await dispatchGenesisScaffold(config, input, deps);
    return {
      kind: "dispatched",
      detail: `Dispatched ${config.workflow} on ${config.repository}@${config.ref} to scaffold sites/${input.slug}/, regenerate the root lockfile and the inventory, and commit them. Genesis is resumable: re-run the identical site.duplicate call once the job lands and every remaining step completes.`
    };
  } catch (error) {
    // Never fatal. A mint that got a Netlify site, a bearer and a record must not lose them because
    // GitHub was unreachable for one call.
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
