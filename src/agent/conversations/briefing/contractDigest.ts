// CMP-W1.2 — a per-object-type CONTRACT DIGEST for the chat prompt.
//
// WHY. Rev 8 tells Client Manager "never guess the shape of a governed object — read it and read its
// contract" before every write. That instruction is right about the danger and wrong about the cost:
// the tenant's contract changes when the tenant's schema changes, which is approximately never
// inside one conversation, so re-reading it per turn buys nothing and spends an editor's patience.
// The digest below carries the four facts a writer actually needs — the ops it may use, the order
// the workflow runs in, the ids the server mints (so it must NOT send them), and which constraints
// refuse a write versus refuse a publish — into the prompt, and the prompt's "verify, don't
// discover" rule (W3.2) then makes the dry-run, not the read, the thing that protects the write.
//
// THE CACHE IS THE ONE THE ENGINE ALREADY HAS. The plan called for a new blob at
// `briefing/<projectId>/contracts.json` keyed by the contract's content hash. That cache already
// exists, one layer down: `getReducedContract` (contractPrefetch.ts) fingerprints the RAW payload
// (`stableHash(raw):r<CONTRACT_REDUCER_VERSION>`) and reads/writes
// `WorkspaceRepository.{get,put}ReducedContractCacheEntry` under exactly that key. Adding a second,
// separately-invalidated copy of the same bytes would give this repo two caches to keep honest and
// one more place for a stale contract to survive a schema change. So: reuse it, and cache only the
// RENDERED text in process, keyed by the fingerprint the reduction already carries.
//
// NEVER A MODEL CALL. Everything here is a fetch and string work.
import { getReducedContract } from "../../workspace/contractPrefetch.js";
import type { ReducedContract } from "../../workspace/contractReduction.js";
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import type { ProjectRepository } from "../../repository/interfaces/ProjectRepository.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import { promptSafe, safeReadFailure } from "./safeReason.js";
import type { RunScopedCache } from "../../workspace/conductor.js";

// The plan's ceiling, enforced rather than hoped for: whatever a tenant's contract grows into, its
// digest stays a thing a reader can hold in their head.
export const MAX_DIGEST_LINES_PER_TYPE = 12;
// A rendered digest is kept for a day even when the fingerprint is unchanged, so a long-lived
// instance re-reads the tenant's contract daily rather than trusting a process that has been up for
// a week. Shorter than the object's real change cadence, longer than any conversation.
export const DIGEST_TTL_MS = 24 * 60 * 60 * 1000;

const bullet = (text: string): string => `- ${text}`;

// Contract ids, constraint notes, op names and workflow steps are all TENANT-authored strings
// reaching a block outside the untrusted-JSON marker — same boundary, same rule, same review
// finding as objectDossier.ts and tenantBaseline.ts. `safe` is that rule applied once here.
const safe = (value: string, max = 160): string => promptSafe(value, max);

/**
 * Pure. `reduced` in, at most MAX_DIGEST_LINES_PER_TYPE lines out.
 *
 * What is deliberately NOT here: the body schema. It is the single largest thing in a contract (the
 * live dr-lurie one is ~18KB) and a writer does not need it to decide WHAT to do — only to fill a
 * body in, which is what `object_validate`'s dry-run checks for real. Naming the ops and the
 * blocking constraints tells the model when it is about to be refused; pasting 18KB of JSON Schema
 * into every turn of every conversation would not.
 */
export const renderContractDigest = (reduced: ReducedContract): string => {
  const lines: string[] = [];

  const ops = reduced.validationSurface.map((entry) => entry.requiredFields.length ? `${safe(entry.op, 64)}(${entry.requiredFields.map((field) => safe(field, 64)).join(", ")})` : safe(entry.op, 64));
  if (ops.length) lines.push(bullet(`Ops: ${ops.join(" · ")}`));

  if (reduced.workflowSequence.length) lines.push(bullet(`Workflow order: ${reduced.workflowSequence.map((step) => safe(step, 64)).join(" → ")}. Follow it in this order.`));

  // The server mints these. Sending one back is the classic refusal this digest exists to prevent.
  const minted = reduced.idConventions.map((entry) => safe(entry.id, 64));
  if (minted.length) lines.push(bullet(`Server-minted ids — omit them from a create: ${minted.join(", ")}`));

  // Severity is carried VERBATIM from the tenant's own contract rather than re-graded here. This
  // module has no way to know what a given tenant means by a severity string, and a constraint
  // silently promoted or demoted in the briefing would teach the model a rule the enforcing code
  // does not hold.
  const blocking = reduced.constraints.filter((entry) => entry.severity === "error" || entry.enforcedLive === true);
  for (const entry of blocking.slice(0, 4)) {
    lines.push(bullet(`Blocks a write: ${safe(entry.id, 64)}${entry.note ? ` — ${safe(entry.note)}` : ""}`));
  }
  if (blocking.length > 4) lines.push(bullet(`…and ${blocking.length - 4} further blocking constraints; dry-run rather than guessing which one applies.`));

  if (reduced.taxonomy.blockingConstraints.length) {
    lines.push(bullet(`Taxonomy terms must resolve before the write lands: ${reduced.taxonomy.blockingConstraints.map((entry) => safe(entry.id, 64)).join(", ")}`));
  }

  // publishPolicy is what refuses a PUBLISH (as opposed to a write) — kept as a single compact line
  // because its interesting half is a handful of booleans, and its uninteresting half (denial code
  // catalogues) is already stripped by contractReduction.extractPublishPolicy.
  if (reduced.publishPolicy && typeof reduced.publishPolicy === "object") {
    const summary = JSON.stringify(reduced.publishPolicy);
    lines.push(bullet(`Blocks a publish: ${summary.length > 200 ? `${summary.slice(0, 199)}…` : summary}`));
  }

  if (!lines.length) lines.push(bullet("This tenant's contract declares no ops, workflow or blocking constraints for this type. Read it before the first write rather than assuming it is permissive."));

  const kept = lines.slice(0, MAX_DIGEST_LINES_PER_TYPE);
  if (lines.length > MAX_DIGEST_LINES_PER_TYPE) kept[MAX_DIGEST_LINES_PER_TYPE - 1] = bullet("…digest truncated; call `object_contract` for this type before a write you are unsure of.");
  return [`**${safe(reduced.clientObjectType, 128)}**`, ...kept].join("\n");
};

/**
 * Which object types this tenant's dialect actually names.
 *
 * Only what the RECORD says — never a guessed literal. contractPrefetch.ts learned this the
 * expensive way (it once guessed "content_item", was accidentally right for one tenant, and had no
 * way to tell that from being wrong). A tenant with no `defaultObjectType` therefore contributes no
 * content type here, and the briefing says so instead of inventing one.
 */
export const dialectObjectTypes = (config: Pick<ProjectConnectionConfig, "objectDialect">): string[] => {
  const dialect = config.objectDialect;
  if (!dialect) return [];
  const types = [
    ...(dialect.defaultObjectType ? [dialect.defaultObjectType] : []),
    ...(dialect.voiceObjectId ? ["editorial_voice"] : []),
    ...(dialect.strategyObjectId ? ["editorial_strategy"] : [])
  ];
  return [...new Set(types)];
};

export type ContractDigestDeps = {
  projectRepository: ProjectRepository;
  workspaceRepository?: WorkspaceRepository;
  // The briefing passes its OWN RunScopedCache, never the shared `conductorCache`. That cache is
  // keyed by runId and has no expiry at all — a chat, whose "run id" is the project, would have
  // memoized a tenant's contract for the life of the process, so a schema change would never have
  // reached the admin chat until the instance restarted. assembleBriefing.ts owns the expiry.
  cache?: RunScopedCache;
  now?: () => number;
};

type CacheEntry = { fingerprint: string; rendered: string; renderedAtMs: number };
const renderedDigestCache = new Map<string, CacheEntry>();

/** Test seam — the process-lifetime cache would otherwise leak between cases. */
export const __resetContractDigestCacheForTests = (): void => { renderedDigestCache.clear(); };

export type ContractDigestResult = { objectType: string; digest: string; source: "contract" | "unavailable" };

/**
 * One digest per type, resolved through the engine's own contract prefetch.
 *
 * A type that cannot be read degrades to a named line rather than to silence or to an omitted
 * entry: "unavailable" in the prompt keeps rev 8's read-before-you-write behaviour as the fallback,
 * whereas an absent block would read to the model as "this type has no constraints".
 *
 * `runId` is the RunScopedCache key contractPrefetch uses. A chat turn is not a run, so callers pass
 * a conversation-scoped key; the in-process rendered cache below, not that one, is what makes the
 * second turn of a conversation free.
 */
export const resolveContractDigests = async (
  params: { projectId: string; runId: string; objectTypes: string[] },
  deps: ContractDigestDeps
): Promise<ContractDigestResult[]> => {
  const now = deps.now ?? Date.now;
  const results: ContractDigestResult[] = [];
  for (const objectType of params.objectTypes) {
    const cacheKey = `${params.projectId} ${objectType}`;
    const prefetch = await getReducedContract({ runId: params.runId, projectId: params.projectId, requestedObjectType: objectType }, deps)
      .catch((error: unknown) => ({ ok: false as const, error, authFailed: undefined, httpStatus: undefined }));
    if (!prefetch.ok) {
      // A previously rendered digest is better than nothing when the tenant is briefly unreachable —
      // it is the same contract the last successful read returned, and it is labelled as cached, so
      // a reader is never told a stale digest is fresh.
      const stale = renderedDigestCache.get(cacheKey);
      results.push(stale
        ? { objectType, digest: `${stale.rendered}\n- (last read ${new Date(stale.renderedAtMs).toISOString()}; the tenant did not answer this turn — re-read before a write)`, source: "contract" }
        // The REASON is classified, never quoted (safeReason.ts): a prefetch failure's own message
        // names the deployment's env vars and the tenant's endpoint.
        : { objectType, digest: `**${objectType}**\n- Contract unavailable this turn (${safeReadFailure(prefetch.error, { authFailed: prefetch.authFailed, httpStatus: prefetch.httpStatus })}). Read \`object_contract\` for this type before you write to it.`, source: "unavailable" });
      continue;
    }
    const fingerprint = prefetch.reduced.contractSource.fingerprint;
    const cached = renderedDigestCache.get(cacheKey);
    if (cached && cached.fingerprint === fingerprint && now() - cached.renderedAtMs < DIGEST_TTL_MS) {
      results.push({ objectType, digest: cached.rendered, source: "contract" });
      continue;
    }
    const rendered = renderContractDigest(prefetch.reduced);
    renderedDigestCache.set(cacheKey, { fingerprint, rendered, renderedAtMs: now() });
    results.push({ objectType, digest: rendered, source: "contract" });
  }
  return results;
};

export const renderContractDigestBlock = (digests: ContractDigestResult[]): string => {
  if (!digests.length) {
    return "### Object contracts\nThis tenant's record names no object types (its publishing dialect is unconfigured), so nothing could be digested. Read `object_contract` before touching a governed object.";
  }
  return ["### Object contracts", "What each governed type here allows, in the order its workflow runs. Verify a write against it; do not re-read it to learn it.", ...digests.map((entry) => entry.digest)].join("\n\n");
};
