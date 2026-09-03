// F1 (T-2, run_1785352838155_l544ye): fetches a client's object contract deterministically — a plain
// function call the conductor makes before dispatching contract_intelligence, not a tool the model
// invokes from inside its own agent loop — and reduces it via contractReduction.ts. Cached per
// (runId, projectId, objectType) through the SAME RunScopedCache getRunContext already uses, so a run
// that (re)dispatches contract_intelligence more than once never re-fetches the client's server.
//
// §2.20 (cross-run reduced-contract cache): the RunScopedCache above only ever helps a run that
// dispatches contract_intelligence more than once — a fresh run re-fetches AND re-reduces even when
// the client's contract has not changed since the last run. When `deps.workspaceRepository` is
// supplied, the raw payload's content fingerprint (§2.21) is checked against a small persisted cache
// (projectId, objectType, fingerprint) -> ReducedContract before reduceContract runs, and the result
// is stored there after. Optional and best-effort: a caller that omits workspaceRepository, or a
// store that errors on the lookup/write, gets exactly today's behavior — the raw fetch and reduction
// still happen, just without cross-run reuse.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { getProjectHooks } from "../projects/projectHooks.js";
import { stableHash } from "../improvement/improvementTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import { conductorCache, type RunScopedCache } from "./conductor.js";
import { reduceContract, type ReducedContract } from "./contractReduction.js";

// T2: `authFailed` separates "the client rejected THIS driver's credential" from every other reason a
// prefetch can fail. The distinction is load-bearing: every other failure is a degradation the node
// is designed to work around (it receives `prefetchError` and emits its own blocker), whereas an auth
// failure means nothing downstream in this run can read or write the client at all — so continuing
// can only manufacture an expensive, unpublishable artifact.
export type ContractPrefetchFailure = { ok: false; error: string; code?: "prefetch_object_type_unresolved"; authFailed?: true; httpStatus?: number };
export type ContractPrefetchResult = { ok: true; reduced: ReducedContract } | ContractPrefetchFailure;
export type ContractPrefetchParams = { runId: string; projectId: string; requestedObjectType?: string };
export type ContractPrefetchDeps = { projectRepository: ProjectRepository; cache?: RunScopedCache; workspaceRepository?: WorkspaceRepository };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// This call bypasses executeTool (the controlled-tool gateway) entirely — it is deterministic
// conductor code, not a model-invoked tool — so it never inherited executeTool's per-tool timeout or
// its AbortController wiring, and previously had NO timeout at all: a hung remote MCP server here
// would hang the node dispatch indefinitely. 15s matches the other short, single-call project reads
// (project.list_tools/test_connection) rather than project.call_tool's 30s: this is one read call,
// not a write that may need to reach a slower operation on the remote.
const CONTRACT_PREFETCH_TIMEOUT_MS = 15_000;

// MCP tool-call results carry structuredContent (preferred) and/or a content[] text block (a few
// clients/transports only populate the latter). Prefer structuredContent; parse the text block only
// when structuredContent is absent. Most contract responses nest the payload under a "contract" key
// (confirmed against a real platform response); fall back to the structured value itself for a
// server that returns the contract unnested — never assumed, always the shape THIS call returned.
// Exported so sitePrefetch.ts's object_contract('site') call (BRIEF §3.7's overridePolicy read path)
// can reuse the same tolerant envelope descent instead of re-deriving it.
export function extractContractPayload(result: unknown): unknown {
  if (!isObject(result)) return result;
  const structured = result.structuredContent;
  if (isObject(structured)) return isObject(structured.contract) ? structured.contract : structured;
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.find((block): block is { text: string } => isObject(block) && typeof block.text === "string")?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  return result;
}

export async function getReducedContract(params: ContractPrefetchParams, deps: ContractPrefetchDeps): Promise<ContractPrefetchResult> {
  const cache = deps.cache ?? conductorCache;
  const cacheKey = `contract:${params.projectId}:${params.requestedObjectType ?? "(default)"}`;
  // T3: only a SUCCESSFUL prefetch is memoized for the life of the run. A failure — an expired
  // token, a timed-out client, an unresolved object type an operator can fix mid-run — is returned
  // to this caller and re-attempted by the next one, instead of being replayed from cache for every
  // remaining node in the run (including after workflow.retry_node).
  return cache.getOrLoad(params.runId, cacheKey, async (): Promise<ContractPrefetchResult> => {
    const config = await deps.projectRepository.get(params.projectId);
    if (!config) return { ok: false, error: `Unknown projectId: ${params.projectId}` };
    // Resolution order: an explicit per-call override, then the project's own configured convention
    // (ProjectObjectDialect.defaultObjectType). There is deliberately NO further fallback to a guessed
    // literal (T-2 re-run, run_1785405350649_9u5mjz): platform had no defaultObjectType configured, so
    // an earlier version of this function silently guessed "content_item" — which happened to be
    // correct for platform, but a cost optimization that quietly degrades when its assumption is wrong
    // is worse than no optimization at all, and there is no way to tell "guessed right" from "guessed
    // wrong" from outside this function. Fail loudly and by name instead, so a project onboarded
    // without its dialect configured is a visible defect, not a silent cost regression discovered only
    // by a full live run.
    const objectType = params.requestedObjectType ?? config.objectDialect?.defaultObjectType;
    if (!objectType) {
      return {
        ok: false,
        code: "prefetch_object_type_unresolved",
        error: `Cannot resolve an object type for project "${params.projectId}": no requestedObjectType was given and its ProjectObjectDialect declares no defaultObjectType. Configure objectDialect.defaultObjectType for this project (see projectTypes.ts) rather than relying on a guess.`
      };
    }
    const arguments_ = { object_type: objectType };
    // Mirrors project.call_read_tool's own handler ordering (toolRegistry.ts): the project's
    // executable policy runs before any transport, so a client-specific block still applies even
    // though this call never goes through the controlled-tool/model-facing gate at all.
    const policyFindings = getProjectHooks(params.projectId)?.enforceCallToolPolicy?.({ tool: "object_contract", arguments: arguments_ }) ?? [];
    const blocking = policyFindings.filter((finding) => finding.severity === "error");
    if (blocking.length) return { ok: false, error: `Blocked by executable project policy: ${blocking.map((finding) => finding.code).join(", ")}` };
    const adapter = new ProjectMcpAdapter(config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTRACT_PREFETCH_TIMEOUT_MS);
    let call: Awaited<ReturnType<typeof adapter.callReadTool>>;
    try {
      call = await adapter.callReadTool("object_contract", arguments_, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!call.ok) {
      const error = call.error ?? `object_contract failed for project ${params.projectId}`;
      return { ok: false, error, ...(call.authFailed ? { authFailed: true as const, httpStatus: call.httpStatus } : {}) };
    }
    const raw = extractContractPayload(call.result);
    // §2.21: a stable content hash of the RAW payload, computed before any reduction — this is what
    // makes a contract that changed between fetch and publish detectable, and is the cache key below.
    const fingerprint = stableHash(raw);
    if (deps.workspaceRepository) {
      const cached = await deps.workspaceRepository.getReducedContractCacheEntry(params.projectId, objectType, fingerprint).catch(() => undefined);
      if (cached) return { ok: true, reduced: cached.reduced };
    }
    const reduced = reduceContract(raw, { tool: "object_contract", fetchedAtISO: new Date().toISOString(), fingerprint }, objectType);
    if (deps.workspaceRepository) {
      await deps.workspaceRepository.putReducedContractCacheEntry({ projectId: params.projectId, objectType, fingerprint, reduced }).catch(() => undefined);
    }
    return { ok: true, reduced };
  }, { shouldCache: (result) => result.ok });
}
