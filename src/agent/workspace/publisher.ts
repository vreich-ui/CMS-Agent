// Explicit PUBLISH gate for the Publishing Conductor. This is the deliberate, auditable step that
// turns a reviewed article_body.v1 into a real publication on a project's live site. Publishing is
// irreversible and outward-facing, so it is protected by defense-in-depth: a live publish runs ONLY
// when the operator has enabled publishing for the project AND the caller passes explicit approval
// AND an explicit live flag. Missing any gate yields a dry-run PLAN that performs no external call.
//
// For Dr. Lurie the sanctioned sequence is create draft -> checkout (lock) -> publish_by_time ->
// checkin, driven through the project's own MCP tools (never the legacy artifact fallback tools the
// executable policy blocks). Image materialization is out of scope for this path (it needs the
// artifact upload flow); a body carrying image/document media is rejected with a clear reason.

import { articleBodySchema, type ArticleBody } from "../mcp/workspace/store.js";
import { redactSensitiveKeys } from "../observability/redaction.js";
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";
import type { CallToolResult } from "../projects/projectMcpAdapter.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { WorkflowExecutionRecord } from "./executionTypes.js";

// request_id contract: req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case, supplied by the
// caller (never auto-generated). A malformed id is accepted at create but breaks every later step.
const REQUEST_ID_PATTERN = /^req_[a-z0-9_]+_\d{8}_\d{2}$/;

const OWNER = { owner_id: "cms-agent", owner_label: "CMS-Agent Publishing Conductor" };

export type PublishGate = { name: string; passed: boolean; reason?: string };
export type PublishGates = { operatorEnabled: boolean; approved: boolean; live: boolean; allPassed: boolean; gates: PublishGate[] };
export type PublishStep = { tool: string; ok: boolean; error?: string };
export type PublishPlan = { projectId: string; requestId: string; nodeCount: number; publishedTime: string | null; toolSequence: string[] };
export type PublishResult =
  | { published: false; mode: "dry_run"; gates: PublishGates; plan: PublishPlan; steps: PublishStep[]; reason: string }
  | { published: true; mode: "live"; gates: PublishGates; plan: PublishPlan; steps: PublishStep[]; result: unknown }
  | { published: false; mode: "error"; gates: PublishGates; plan: PublishPlan | null; steps: PublishStep[]; error: string };

export type CallToolFn = (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;
export type PublishRunInput = { runId: string; projectId?: string; requestId: string; approved?: boolean; live?: boolean; publishedTime?: string | null };
export type PublisherDeps = {
  env?: NodeJS.ProcessEnv;
  executionRepository?: ExecutionRepository;
  projectRepository?: ProjectRepository;
  learningRepository?: LearningRepository;
  // Injectable so tests exercise the gate + sequence against a fake adapter and never touch a live site.
  callTool?: CallToolFn;
};

// The per-project operator enable flag env var name, derived from the connection endpoint env var
// (DR_LURIE_MCP_ENDPOINT -> DR_LURIE_PUBLISH_ENABLED). Referenced by NAME only; the operator sets the
// value in the deployment, exactly like the connection endpoint/token.
export const publishEnabledEnvVar = (config: ProjectConnectionConfig): string => `${config.mcpEndpointEnvVar.replace(/_MCP_ENDPOINT$/, "")}_PUBLISH_ENABLED`;

// Publishing is enabled for a project only when the operator sets the per-project env flag in the
// deployment. The code-level publishingPolicy.publishEnabled stays false as a default-off marker; the
// operator override lives in the environment (never persisted), mirroring the connection endpoint/token.
export const isProjectPublishEnabled = (config: ProjectConnectionConfig, env: NodeJS.ProcessEnv = process.env): boolean =>
  (env[publishEnabledEnvVar(config)] ?? "").trim().toLowerCase() === "true";

const evaluateGates = (config: ProjectConnectionConfig, input: PublishRunInput, env: NodeJS.ProcessEnv): PublishGates => {
  const operatorEnabled = isProjectPublishEnabled(config, env);
  const approved = input.approved === true;
  const live = input.live === true;
  const gates: PublishGate[] = [
    { name: "operator_enabled", passed: operatorEnabled, reason: operatorEnabled ? undefined : `Publishing is not enabled for ${config.projectId}; set ${publishEnabledEnvVar(config)}=true in the deployment.` },
    { name: "explicit_approval", passed: approved, reason: approved ? undefined : "approved: true is required for a live publish." },
    { name: "explicit_live", passed: live, reason: live ? undefined : "live: true (dryRun false) is required for a live publish." }
  ];
  return { operatorEnabled, approved, live, allPassed: gates.every((gate) => gate.passed), gates };
};

// Deep-search a tool result for a lock_token string. Result envelope shapes vary across MCP servers
// (raw result vs. { structuredContent } vs. nested data), so this is intentionally tolerant.
const findLockToken = (value: unknown, depth = 0): string | undefined => {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "lock_token" && typeof child === "string" && child) return child;
    const found = findLockToken(child, depth + 1);
    if (found) return found;
  }
  return undefined;
};

const findArticleBody = (run: WorkflowExecutionRecord): unknown =>
  run.stageOutputs?.article_body ?? run.nodes.find((node) => node.nodeId === "article_body")?.output ?? run.entrypoint?.output;

const bodyHasMedia = (body: ArticleBody): boolean => body.nodes.some((node) => node.public.media !== undefined);

// Execute (or plan) a live publish for a completed/late-stage run. Returns a dry-run plan unless every
// gate passes. Never throws for gate/validation failures — those are returned as structured results;
// only truly unexpected conditions throw.
export async function publishRun(input: PublishRunInput, deps: PublisherDeps = {}): Promise<PublishResult> {
  const env = deps.env ?? process.env;
  const executionRepository = deps.executionRepository ?? repositoryManager.getExecutionRepository();
  const projectRepository = deps.projectRepository ?? repositoryManager.getProjectRepository();
  const learningRepository = deps.learningRepository ?? repositoryManager.getLearningRepository();

  const run = await executionRepository.getRun(input.runId);
  if (!run) throw new Error(`Unknown run: ${input.runId}`);
  const projectId = input.projectId ?? run.projectId;
  const config = await projectRepository.get(projectId);
  if (!config) throw new Error(`Unknown projectId: ${projectId}`);

  const gates = evaluateGates(config, input, env);
  const emptyPlan: PublishPlan = { projectId, requestId: input.requestId, nodeCount: 0, publishedTime: input.publishedTime ?? null, toolSequence: [] };

  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    return { published: false, mode: "error", gates, plan: null, steps: [], error: `invalid_request_id: must match req_<flow>_<topic>_<yyyymmdd>_<nn> (lowercase snake_case), got "${input.requestId}".` };
  }

  const parsed = articleBodySchema.safeParse(findArticleBody(run));
  if (!parsed.success) {
    return { published: false, mode: "error", gates, plan: emptyPlan, steps: [], error: `no_valid_article_body: run ${input.runId} has no valid article_body.v1 to publish (${parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join("; ")}).` };
  }
  const body = parsed.data;
  if (bodyHasMedia(body)) {
    return { published: false, mode: "error", gates, plan: emptyPlan, steps: [], error: "image_media_unsupported: this publish path handles text-only bodies; image/document media requires the Dr. Lurie artifact upload flow and is not published here." };
  }

  const toolSequence = ["save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time", "save_json_blob_checkin_request"];
  const plan: PublishPlan = { projectId, requestId: input.requestId, nodeCount: body.nodes.length, publishedTime: input.publishedTime ?? null, toolSequence };

  if (!gates.allPassed) {
    const reason = gates.gates.filter((gate) => !gate.passed).map((gate) => gate.reason).join(" ");
    return { published: false, mode: "dry_run", gates, plan, steps: [], reason: reason || "One or more publish gates are not satisfied." };
  }

  // All gates passed: drive the sanctioned publish sequence through the project's MCP tools.
  const callTool = deps.callTool ?? ((tool, args) => new ProjectMcpAdapter(config).callTool(tool, args));
  const steps: PublishStep[] = [];
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await callTool(tool, args);
    steps.push({ tool, ok: res.ok, error: res.error });
    if (!res.ok) throw new Error(`${tool}_failed: ${res.error ?? "call failed"}`);
    return res.result;
  };

  try {
    await call("save_json_blob_create_article_draft", { request_id: input.requestId, input: { record_type: "content_source", schema_version: "content_source.v1", content: { article_body: body } } });
    const checkout = await call("save_json_blob_checkout_request", { request_id: input.requestId, ...OWNER });
    const lockToken = findLockToken(checkout);
    if (!lockToken) throw new Error("checkout_missing_lock_token: could not resolve lock_token from checkout result.");
    const publishResult = await call("save_json_blob_publish_by_time", { request_id: input.requestId, lock_token: lockToken, ...(input.publishedTime ? { published_time: input.publishedTime } : {}) });
    // Best-effort lock release; a failure here only means the lease expires naturally.
    try { await call("save_json_blob_checkin_request", { request_id: input.requestId, lock_token: lockToken }); } catch { /* lock expires on its own */ }

    await learningRepository.recordObservation(`Live publish executed for ${projectId} request ${input.requestId}.`, { type: "publish_executed", projectId, requestId: input.requestId, runId: input.runId });
    return { published: true, mode: "live", gates, plan, steps, result: redactSensitiveKeys(publishResult) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "publish_failed";
    await learningRepository.recordObservation(`Live publish failed for ${projectId} request ${input.requestId}: ${message}`, { type: "publish_failed", projectId, requestId: input.requestId, runId: input.runId }).catch(() => undefined);
    return { published: false, mode: "error", gates, plan, steps, error: message };
  }
}

export const __test__ = { evaluateGates, findLockToken, REQUEST_ID_PATTERN };
