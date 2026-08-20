// S3 item 8 — THE CONTENT-ITEM SHELL.
//
// artifact_plan materializes media under the run's request id BEFORE any content_item exists for
// that request. On an object-substrate client the artifact bridge indexes artifacts against the
// owning object, so a generation that lands before the object exists comes back
// `artifact_request_not_found` (or an artifact the client can never list, reconcile, or delete). The
// fix is ordering, not a new tool: for a project whose object dialect keeps the request id as the
// object id (objectIdSource "request_id"), the conductor creates an EMPTY content_item shell under
// the run's request id — one `object_create`, idempotent on the run — right before artifact_plan
// dispatches, and the publisher later PATCHES that object (checkout + validate + patch + publish)
// instead of creating a second one.
//
// Everything about this is best-effort and guarded: a shell that cannot be created (project not
// enabled, no dialect, unreachable client, policy block, request-shape rejection) is a node WARNING
// `content_item_shell_failed:<code>` on artifact_plan, never a thrown error and never a failed node —
// the run then proceeds exactly as it did before this module existed (the publisher creates on its
// own). The shell is recorded in artifact_plan's INPUT (`contentItemShell`), which is where the
// publisher reads it back from the persisted run.

import { getProjectHooks } from "../projects/projectHooks.js";
import { findObjectId } from "../projects/objectDialect.js";
import { ProjectMcpAdapter, type CallToolResult } from "../projects/projectMcpAdapter.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { isProjectPublishEnabled } from "./publisher.js";
import type { NodeExecutionState, WorkflowExecutionRecord } from "./executionTypes.js";

export const CONTENT_ITEM_SHELL_INPUT_KEY = "contentItemShell";
export const CONTENT_ITEM_SHELL_FAILED_PREFIX = "content_item_shell_failed:";
export const CONTENT_ITEM_SHELL_TIMEOUT_MS = 12_000;

export type ContentItemShell = { objectId: string; created: boolean; objectType: string; requestId: string };
export type ContentItemShellResult =
  | { ok: true; shell: ContentItemShell }
  | { ok: false; code: string; message: string; skipped: boolean };

export type ContentItemShellParams = {
  run: Pick<WorkflowExecutionRecord, "runId" | "projectId" | "requestId" | "executionMode">;
  // The reduced contract prefetched for this run (contract_intelligence's prefetchedContract) when
  // the conductor holds it; used only to name the client object type.
  prefetchedContract?: { clientObjectType?: unknown } | undefined;
};
export type ContentItemShellDeps = {
  projectRepository: ProjectRepository;
  env?: NodeJS.ProcessEnv;
  callTool?: (config: ProjectConnectionConfig, tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const ALREADY_EXISTS = /already[ _-]?exists|duplicate|conflict|409|exists for this (?:request|id)/i;
const REJECTS_IDEMPOTENCY_KEY = /idempotency_key/i;

const skipped = (code: string, message: string): ContentItemShellResult => ({ ok: false, code, message, skipped: true });
const failed = (code: string, message: string): ContentItemShellResult => ({ ok: false, code, message, skipped: false });

/**
 * Create (once) the empty content_item under the run's request id. Returns a typed verdict; never
 * throws. `skipped:true` means the preconditions were not met (not an object-substrate project, not
 * publish-enabled, mock mode, no pattern-valid request id) — an expected no-op, not a failure.
 */
export async function ensureContentItemShell(params: ContentItemShellParams, deps: ContentItemShellDeps): Promise<ContentItemShellResult> {
  const { run } = params;
  if (run.executionMode !== "openai") return skipped("not_live", `execution mode ${run.executionMode} never touches the client`);
  const config = await deps.projectRepository.get(run.projectId);
  if (!config) return skipped("unknown_project", `no registered project ${run.projectId}`);
  const dialect = config.objectDialect;
  if (!dialect) return skipped("no_object_dialect", `project ${run.projectId} declares no objectDialect; not an object-substrate client`);
  if (dialect.objectIdSource !== "request_id") return skipped("server_minted_ids", `project ${run.projectId} mints object ids server-side; a request-id shell has no meaning`);
  if (!nonEmpty(dialect.siteObjectId)) return skipped("no_site_object_id", `project ${run.projectId} declares no objectDialect.siteObjectId`);
  if (!isProjectPublishEnabled(config, deps.env ?? process.env)) return skipped("publish_disabled", `publishing is not enabled for ${run.projectId}`);
  if (!nonEmpty(run.requestId)) return skipped("no_request_id", "the run carries no request id");
  if (dialect.requestIdPattern) {
    let regex: RegExp | undefined;
    try { regex = new RegExp(dialect.requestIdPattern); } catch { regex = undefined; }
    if (regex && !regex.test(run.requestId)) return skipped("request_id_not_pattern_valid", `run requestId ${run.requestId} does not match ${dialect.requestIdPattern}`);
  }
  const objectType = nonEmpty(params.prefetchedContract?.clientObjectType) ? params.prefetchedContract!.clientObjectType as string : "content_item";
  const requestId = run.requestId.trim();

  const baseArguments: Record<string, unknown> = { object_type: objectType, site: dialect.siteObjectId, requested_id: requestId };
  const policyFindings = getProjectHooks(run.projectId)?.enforceCallToolPolicy?.({ tool: "object_create", arguments: baseArguments }) ?? [];
  const blocking = policyFindings.filter((finding) => finding.severity === "error");
  if (blocking.length) return failed("policy_blocked", `object_create blocked by executable project policy: ${blocking.map((finding) => finding.code).join(", ")}`);

  const callTool = deps.callTool ?? (async (projectConfig, tool, args) => {
    const adapter = new ProjectMcpAdapter(projectConfig, { env: deps.env });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTENT_ITEM_SHELL_TIMEOUT_MS);
    try { return await adapter.callTool(tool, args, controller.signal); } finally { clearTimeout(timer); }
  });

  const attempt = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    try { return await callTool(config, "object_create", args); } catch (error) {
      return { ok: false, projectId: run.projectId, connection: { endpointConfigured: false, tokenConfigured: false, mcpEndpointEnvVar: config.mcpEndpointEnvVar, endpointSource: "unset", tokenSource: "unset" }, tool: "object_create", error: error instanceof Error ? error.message : String(error) };
    }
  };

  // Idempotent on the run: the client keys duplicate suppression on idempotency_key. A client whose
  // create schema rejects the key is retried once without it — the requested_id still makes the
  // second call idempotent on the client's own uniqueness rule (an existing object is reported as
  // created:false below, never as a failure).
  let call = await attempt({ ...baseArguments, idempotency_key: run.runId });
  if (!call.ok && REJECTS_IDEMPOTENCY_KEY.test(call.error ?? "")) call = await attempt(baseArguments);

  if (!call.ok) {
    const message = call.error ?? "object_create failed";
    if (ALREADY_EXISTS.test(message)) return { ok: true, shell: { objectId: requestId, created: false, objectType, requestId } };
    return failed(call.permission === "blocked" ? "blocked" : "create_failed", message);
  }
  const alreadyExisted = isObject(call.result) && (call.result.created === false || call.result.existing === true || call.result.idempotent_replay === true);
  const minted = findObjectId(call.result);
  const objectId = minted === undefined ? requestId : String(minted);
  return { ok: true, shell: { objectId, created: !alreadyExisted, objectType, requestId } };
}

/** The shell artifact_plan's dispatch recorded on the run, if any (read by the publisher). */
export const readContentItemShell = (run: Pick<WorkflowExecutionRecord, "nodes">): ContentItemShell | undefined => {
  const state = run.nodes.find((node: NodeExecutionState) => node.nodeId === "artifact_plan");
  const candidate = isObject(state?.input) ? (state!.input as Record<string, unknown>)[CONTENT_ITEM_SHELL_INPUT_KEY] : undefined;
  if (!isObject(candidate) || !nonEmpty(candidate.objectId) || !nonEmpty(candidate.requestId)) return undefined;
  return { objectId: candidate.objectId, created: candidate.created === true, objectType: nonEmpty(candidate.objectType) ? candidate.objectType : "content_item", requestId: candidate.requestId };
};
