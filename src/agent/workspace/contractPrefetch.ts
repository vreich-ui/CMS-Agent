// F1 (T-2, run_1785352838155_l544ye): fetches a client's object contract deterministically — a plain
// function call the conductor makes before dispatching contract_intelligence, not a tool the model
// invokes from inside its own agent loop — and reduces it via contractReduction.ts. Cached per
// (runId, projectId, objectType) through the SAME RunScopedCache getRunContext already uses, so a run
// that (re)dispatches contract_intelligence more than once never re-fetches the client's server.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { getProjectHooks } from "../projects/projectHooks.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { conductorCache, type RunScopedCache } from "./conductor.js";
import { reduceContract, type ReducedContract } from "./contractReduction.js";

export type ContractPrefetchResult = { ok: true; reduced: ReducedContract } | { ok: false; error: string; code?: "prefetch_object_type_unresolved" };
export type ContractPrefetchParams = { runId: string; projectId: string; requestedObjectType?: string };
export type ContractPrefetchDeps = { projectRepository: ProjectRepository; cache?: RunScopedCache };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// MCP tool-call results carry structuredContent (preferred) and/or a content[] text block (a few
// clients/transports only populate the latter). Prefer structuredContent; parse the text block only
// when structuredContent is absent. Most contract responses nest the payload under a "contract" key
// (confirmed against a real platform response); fall back to the structured value itself for a
// server that returns the contract unnested — never assumed, always the shape THIS call returned.
function extractContractPayload(result: unknown): unknown {
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
    const call = await adapter.callReadTool("object_contract", arguments_);
    if (!call.ok) return { ok: false, error: call.error ?? `object_contract failed for project ${params.projectId}` };
    const raw = extractContractPayload(call.result);
    const reduced = reduceContract(raw, { tool: "object_contract", fetchedAtISO: new Date().toISOString() }, objectType);
    return { ok: true, reduced };
  });
}
