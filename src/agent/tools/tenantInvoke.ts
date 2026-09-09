// W3.2.1 (2026-09-09) — THE ONE DOOR TO A TENANT.
//
// THE HOLE THIS CLOSES. Two unrelated things are called "tool" in this system, and only one of them
// was ever audited:
//
//   1. CONTROLLED REGISTRY TOOLS. A model turn naming one passes evaluateToolPolicy, a risk check and
//      an approval gate, and lands in the tool execution ledger.
//   2. TENANT MCP VERBS. Around twenty engine modules construct a ProjectMcpAdapter and call the
//      tenant directly. No node grant is consulted, no risk level is checked, and — until this file —
//      nothing was written anywhere. `tool.list_executions` structurally could not show a publish, a
//      release, a crawl, a mint or a theme apply, because none of them passed through the executor.
//
// W3.1 made that knowable (routeRegistry's requiredTools, nodeCapabilityAudit). This makes it
// ACCOUNTABLE: every tenant call — model-invoked or engine-invoked — goes through one function that
// resolves the project's own permission exactly as before, evaluates one shared rule set, and writes
// one durable record naming the caller, the route and the outcome.
//
// WHAT IT DOES NOT DO, DELIBERATELY.
//
//   - It does not change what any tenant call returns. `invokeTenantTool` hands back the adapter's
//     own CallToolResult, unmodified and un-wrapped, because those results are embedded verbatim in
//     run records; a wrapper or an extra field would move bytes in the run snapshot and this wave is
//     required to be behaviour-identical.
//   - It does not block an engine call whose route manifest fails to list the verb. The manifests are
//     six weeks old and a manifest that is merely incomplete must never be able to stop a publish.
//     The mismatch is RECORDED (`engineVerbUnlisted`) and readable from the ledger; it is not a gate.
//   - It never throws for a ledger failure. The store is best-effort by construction: a tenant call
//     that succeeded and an audit write that failed is one bad outcome, not two.
//
// WHAT IT DOES ENFORCE. FORBIDDEN_PROJECT_VERBS, on both callers, from one place. The model path
// already enforced it (toolRegistry's project.call_tool handler) and keeps enforcing it identically.
// The engine path never did — and is now checked ON THE SAME RULE, but only when the caller states a
// nodeId: an engine call that cannot say which node it is speaking for is allowed and recorded, never
// refused, because fail-open on missing information is this programme's standing rule. Today this is
// a no-op in both directions — AGENTS.md invariant 4 says in engine code `release_to_production` is
// called only by `release_executor`, `object_publish` only by `publish_executor`, and both node ids
// are in PROJECT_VERB_AUTHORIZED_NODE_IDS — which is exactly the property the acceptance test pins,
// so a future route that starts speaking a publish verb from a third node fails a test here rather
// than publishing quietly.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import type { CallToolResult, ProjectAdapterDeps, ReadToolCallResult } from "../projects/projectMcpAdapter.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";
import { repositoryManager } from "../runtime/repositories.js";
import { routeManifest, routeRequiredToolsFor } from "../workspace/routeRegistry.js";
import { FORBIDDEN_PROJECT_VERBS, PROJECT_VERB_AUTHORIZED_NODE_IDS, forbiddenProjectVerbRefusal } from "./forbiddenProjectVerbs.js";
import { recordToolExecution, summarizeForLedger } from "./toolExecutionLedger.js";
import type { ToolCaller, ToolExecutionRecord } from "./toolTypes.js";

// The run/node a tenant call is made for. Both are optional because not every caller has them:
// site_duplicate and the monetizer ingest job reach a tenant outside any run. An unattributed call is
// recorded under these sentinels rather than dropped — "we could not say" is data, and a ledger that
// silently omits the calls it could not attribute is the hole this file exists to close, reopened.
export const UNATTRIBUTED_RUN_ID = "(no-run)";
export const UNATTRIBUTED_NODE_ID = "(no-node)";

export type TenantInvocation = {
  projectId: string;
  toolId: string;
  caller: ToolCaller;
  runId?: string;
  nodeId?: string;
  routeId?: string;
  // The stage of a staged route (capture/clone), so the manifest check asks the same per-stage
  // question the audit does rather than the route's union — see routeRequiredToolsFor.
  phaseId?: string;
  args?: Record<string, unknown>;
  signal?: AbortSignal;
  // An already-resolved project record. Every engine call site has one in hand; passing it keeps this
  // choke point from re-reading the registry on a path that had no read before.
  project?: ProjectConnectionConfig;
  // The adapter's own deps (env / transport / secrets). Forwarded untouched to ProjectMcpAdapter, so a
  // migrated call site that already injected a transport keeps its seam and a test can drive this
  // function without a network.
  adapterDeps?: ProjectAdapterDeps;
};

export class ForbiddenTenantVerbError extends Error {
  constructor(readonly nodeId: string | undefined, readonly verb: string) {
    super(forbiddenProjectVerbRefusal(nodeId, verb));
    this.name = "ForbiddenTenantVerbError";
  }
}

const now = () => new Date().toISOString();
const makeId = () => `tool_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Whether this call's route manifest claims the verb. Three-valued on purpose:
//   true  — the manifest lists it.
//   false — the manifest exists and does not list it (recorded as engineVerbUnlisted).
//   undefined — no routeId, no manifest for it, or a stage whose verbs are not attributed. Nothing to
//               say, so nothing is said: an absent manifest is not evidence of an unlisted verb.
const manifestListsVerb = (routeId: string | undefined, phaseId: string | undefined, verb: string): boolean | undefined => {
  const manifest = routeId ? routeManifest(routeId) : undefined;
  if (!manifest) return undefined;
  // A phase the manifest does not declare is UNKNOWN, not empty. capture_conductor and
  // clone_conductor dispatch the shared publishing tail's nodes through their own stage switch, so a
  // stage value like "publish_executor" reaches here against the capture_stage manifest, which has no
  // such phase and no route-level verb list either. Falling through to routeRequiredToolsFor there
  // would answer [] and flag object_publish as unlisted on every real publish — a false alarm on the
  // one path that must never cry wolf.
  if (phaseId !== undefined && !manifest.phases.some((phase) => phase.id === phaseId)) return undefined;
  const declared = routeRequiredToolsFor(routeId!, phaseId);
  if (declared === undefined) return undefined;
  return declared.some((tool) => tool.verb === verb);
};

// The shared body of both entry points. `perform` is the adapter method to run; everything around it
// — the forbidden-verb rule, the manifest check, timing and the durable record — is identical for a
// read and a write, which is the whole point of having one door.
async function invoke<T extends { ok: boolean; error?: string }>(
  invocation: TenantInvocation,
  perform: (adapter: ProjectMcpAdapter) => Promise<T>,
  // The forbidden-verb rule applies to the WRITE entry point only, and that is not a gap: the read
  // entry point's authority is ProjectMcpAdapter's fixed READ_TOOL_ALLOWLIST, which is strictly
  // narrower — it contains none of FORBIDDEN_PROJECT_VERBS, and an acceptance test pins that the two
  // sets stay disjoint. Applying the rule there as well would only change a refusal that already
  // happens into a differently-shaped one: project.call_read_tool answers a disallowed operation with
  // ok:true carrying an inner `read_tool_operation_not_permitted`, and this wave may not move that.
  enforceForbiddenVerbs = true
): Promise<T> {
  const { projectId, toolId, caller, routeId, phaseId, nodeId, args = {} } = invocation;
  const runId = invocation.runId ?? UNATTRIBUTED_RUN_ID;
  const ledgerNodeId = nodeId ?? UNATTRIBUTED_NODE_ID;
  const startedAt = now();
  const toolExecutionId = makeId();

  // ONE rule, both callers. The model path's exemption list is the engine path's exemption list.
  if (enforceForbiddenVerbs && FORBIDDEN_PROJECT_VERBS.has(toolId) && nodeId !== undefined && !PROJECT_VERB_AUTHORIZED_NODE_IDS.has(nodeId)) {
    const completedAt = now();
    await recordToolExecution({
      toolExecutionId, runId, nodeId: ledgerNodeId, toolId, projectId, caller, ...(routeId ? { routeId } : {}),
      startedAt, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      status: "denied", errorCode: "publish_verb_not_permitted", inputSummary: summarizeForLedger(args),
      riskLevel: "publish", approvalStatus: "missing"
    });
    throw new ForbiddenTenantVerbError(nodeId, toolId);
  }

  const listed = caller === "engine" ? manifestListsVerb(routeId, phaseId, toolId) : undefined;

  const config = invocation.project ?? await repositoryManager.getProjectRepository().get(projectId);
  if (!config) {
    // Same failure the call sites produced before: an unknown project is the caller's problem to
    // name, and it is recorded rather than swallowed.
    const completedAt = now();
    await recordToolExecution({
      toolExecutionId, runId, nodeId: ledgerNodeId, toolId, projectId, caller, ...(routeId ? { routeId } : {}),
      startedAt, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      status: "error", errorCode: "unknown_project", inputSummary: summarizeForLedger(args),
      riskLevel: "read", approvalStatus: "not_required"
    });
    throw new Error(`unknown_project: ${projectId}`);
  }

  let result: T;
  let thrown: unknown;
  try {
    result = await perform(new ProjectMcpAdapter(config, invocation.adapterDeps));
  } catch (error) {
    thrown = error;
    result = undefined as unknown as T;
  }
  const completedAt = now();
  const base: ToolExecutionRecord = {
    toolExecutionId, runId, nodeId: ledgerNodeId, toolId, projectId, caller,
    ...(routeId ? { routeId } : {}),
    ...(listed === false ? { engineVerbUnlisted: true as const } : {}),
    startedAt, completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    status: thrown ? "error" : result.ok ? "success" : "error",
    inputSummary: summarizeForLedger(args),
    ...(thrown
      ? { errorCode: "tenant_call_threw" }
      : result.ok
        ? { outputSummary: summarizeForLedger(result) }
        : { errorCode: "tenant_call_failed", outputSummary: summarizeForLedger({ error: result.error }) }),
    // The tenant's own permission model is what actually gates the call, and it has already run by
    // here. `not_required` states this record's own claim honestly: the choke point required no
    // approval of its own.
    riskLevel: FORBIDDEN_PROJECT_VERBS.has(toolId) ? "publish" : "write",
    approvalStatus: "not_required"
  };
  await recordToolExecution(base);
  if (thrown) throw thrown;
  return result;
}

/** Every WRITE-side tenant verb, from either caller. Returns the adapter's own result, unchanged. */
export function invokeTenantTool(invocation: TenantInvocation): Promise<CallToolResult> {
  return invoke<CallToolResult>(invocation, (adapter) => adapter.callTool(invocation.toolId, invocation.args ?? {}, invocation.signal));
}

/** The read-only counterpart. The adapter's fixed server-side allowlist still decides what qualifies. */
export function invokeTenantReadTool(invocation: TenantInvocation): Promise<ReadToolCallResult> {
  return invoke<ReadToolCallResult>(invocation, (adapter) => adapter.callReadTool(invocation.toolId, invocation.args ?? {}, invocation.signal), false);
}

/**
 * The adapter-shaped closure the migrated engine routes take. Several routes (publisher.ts,
 * artifactMaterialization.ts, releaseExecution.ts, the capture/clone conductor routes) already accept
 * an injectable `callTool(tool, args)`; handing them this instead of a bare
 * `new ProjectMcpAdapter(config).callTool` routes them through the choke point without touching their
 * own logic or their test seams.
 */
export const tenantCallToolFor = (context: Omit<TenantInvocation, "toolId" | "args">) =>
  (tool: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
    invokeTenantTool({ ...context, toolId: tool, args });

/**
 * ADAPTER-SHAPED FACADE, for the migration (W3.2.2).
 *
 * Around twenty modules hold a `ProjectMcpAdapter` and call `.callTool(name, args, signal)` or
 * `.callReadTool(...)` on it, often several times, sometimes behind their own timeout/abort
 * plumbing. Rewriting each of those call expressions into an `invokeTenantTool({...})` object
 * literal would be twenty chances to drop an argument on a path that reaches a live tenant.
 *
 * So the migration is a swap of the CONSTRUCTOR, not of the calls: `new ProjectMcpAdapter(config)`
 * becomes `tenantAdapterFor(config, context)`, and every call expression underneath it is left
 * exactly as it was — same method names, same three arguments, same returned object. What changes is
 * that the call now carries who made it and lands in the ledger.
 *
 * Deliberately NOT a subclass of ProjectMcpAdapter: this exposes the two calling methods and nothing
 * else, so a site that also needs testConnection/listTools/discoverContract keeps its real adapter
 * and is migrated by hand rather than silently acquiring an audited half and an unaudited half.
 */
/** Everything about a tenant call EXCEPT which verb and which arguments: who is calling, for which
 *  run/node, under which route and stage. This is the shape the migrated call sites carry around. */
export type TenantCallContext = Omit<TenantInvocation, "projectId" | "toolId" | "args" | "signal" | "project">;

export type TenantAdapter = {
  callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
  callReadTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<ReadToolCallResult>;
};

export const tenantAdapterFor = (
  config: ProjectConnectionConfig,
  context: TenantCallContext
): TenantAdapter => ({
  callTool: (name, args = {}, signal) =>
    invokeTenantTool({ ...context, projectId: config.projectId, project: config, toolId: name, args, signal }),
  callReadTool: (name, args = {}, signal) =>
    invokeTenantReadTool({ ...context, projectId: config.projectId, project: config, toolId: name, args, signal })
});
