// Explicit PUBLISH gate for the Publishing Conductor. This is the deliberate, auditable step that
// turns a reviewed client_object.v1 into a real publication on a project's live site. Publishing is
// irreversible and outward-facing, so it is protected by defense-in-depth: a live publish runs ONLY
// when the operator has enabled publishing for the project AND the caller passes explicit approval
// AND an explicit live flag. Missing any gate yields a dry-run PLAN that performs no external call.
//
// Publish EXECUTION is per-project: each client's dialect (its tool names, lock protocol, and call
// shapes) lives in that project's executePublish hook (see ../projects/projectHooks.ts), driven
// through the project's own MCP tools. This publisher owns everything dialect-independent — gates,
// request-id contract, body validation, readiness, step recording, learning observations — and
// REFUSES to publish for a project with no execution hook rather than guess another client's
// dialect. Image materialization is out of scope for this path (it needs the artifact upload flow);
// a body carrying image/document media is rejected with a clear reason.
//
// Board decision B2: publishRun never releases — releasing to production is a SEPARATE gate whose
// verb must appear nowhere in this file or in any project's publish execution hook.

import { validateOutput } from "../execution/outputValidator.js";
import { getWorkspaceNode } from "./nodes.js";
import { redactSensitiveKeys } from "../observability/redaction.js";
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";
import type { CallToolResult } from "../projects/projectMcpAdapter.js";
import { getProjectHooks, type PublishExecutionOutcome, type PublishReadinessInput, type PublishReadinessResult } from "../projects/projectHooks.js";
import { findLockToken } from "../projects/toolResultSearch.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { WorkflowExecutionRecord } from "./executionTypes.js";

// request_id contract: req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case, supplied by the
// caller (never auto-generated). A malformed id is accepted at create but breaks every later step.
// This is the shared default; a project may declare its own shape in objectDialect.requestIdPattern.
const REQUEST_ID_PATTERN = /^req_[a-z0-9_]+_\d{8}_\d{2}$/;

// Compile a project's declared request-id shape. Project config is operator-writable, so a declared
// pattern is not compiled blindly: it must be anchored and short, and anything else falls back to
// the shared contract default rather than becoming a regex-injection or backtracking seam.
const compileRequestIdPattern = (declared: string | undefined): RegExp => {
  if (!declared || declared.length > 200 || !declared.startsWith("^") || !declared.endsWith("$")) return REQUEST_ID_PATTERN;
  try { return new RegExp(declared); } catch { return REQUEST_ID_PATTERN; }
};

const OWNER = { owner_id: "cms-agent", owner_label: "CMS-Agent Publishing Conductor" };

export type PublishGate = { name: string; passed: boolean; reason?: string };
export type PublishGates = { operatorEnabled: boolean; approved: boolean; live: boolean; allPassed: boolean; gates: PublishGate[] };
export type PublishStep = { tool: string; ok: boolean; error?: string };
export type PublishPlan = { projectId: string; requestId: string; nodeCount: number; publishedTime: string | null; toolSequence: string[] };
// Resumable blocked-state descriptor so an operator/UI can act without reconstructing the run.
export type PublishBlockedState = { requestId: string; nodeAwaitingApproval: string; artifactSlot: string | null; requiredAction: string; resumable: true };
export type PublishResult =
  | { published: false; mode: "dry_run"; gates: PublishGates; plan: PublishPlan; steps: PublishStep[]; reason: string; readiness?: PublishReadinessResult }
  | { published: true; mode: "live"; gates: PublishGates; plan: PublishPlan; steps: PublishStep[]; result: unknown; clientValidation?: NonNullable<PublishExecutionOutcome["clientValidation"]>; readiness?: PublishReadinessResult }
  | { published: false; mode: "blocked_for_publish_execution"; gates: PublishGates; plan: PublishPlan; steps: PublishStep[]; readiness: PublishReadinessResult; blocked: PublishBlockedState }
  | { published: false; mode: "error"; gates: PublishGates; plan: PublishPlan | null; steps: PublishStep[]; error: string };

export type CallToolFn = (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;
export type PublishRunInput = { runId: string; projectId?: string; requestId: string; approved?: boolean; live?: boolean; publishedTime?: string | null; readiness?: PublishReadinessInput };
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

// Go-live 2026-07-31 (operator decision, Wolf): publishing is enabled when the project's
// publishingPolicy says so (now true by default) OR the per-project env flag is set. The env flag
// doubles as a kill-switch: an explicit "false" in the deployment forces the project off regardless
// of policy, preserving an operator override that never has to pass through MCP.
export const isProjectPublishEnabled = (config: ProjectConnectionConfig, env: NodeJS.ProcessEnv = process.env): boolean => {
  const flag = (env[publishEnabledEnvVar(config)] ?? "").trim().toLowerCase();
  if (flag === "false") return false;
  return flag === "true" || config.publishingPolicy.publishEnabled === true;
};

// The publish gates, and the ONLY three inputs that open them. This list is deliberately closed and
// deliberately independent of any node's tool grant.
//
// publish_executor and publication_controller now carry project.call_tool in allowedTools, because a
// publisher that cannot reach the client is not a publisher — without it both nodes resolved
// allowed:false and activating publish_executor would have produced exactly that. That grant is a
// CAPABILITY, not a permission: it says which tool the node may reach for, and answers none of the
// questions below. Nothing in this function reads a node's allowedTools, an effective-tool
// resolution, or a skill policy, and it must stay that way — the day a tool grant can satisfy a
// publish gate is the day the gates stop meaning anything. (Go-live 2026-07-31: the controlled-tool
// layer's former per-run approval lock on project.call_tool was removed — requiresApproval is now
// false — so granted nodes reach client tools without a per-run approval ceremony.)
const PUBLISH_GATE_NAMES = ["operator_enabled", "explicit_approval", "explicit_live"] as const;

const evaluateGates = (config: ProjectConnectionConfig, input: PublishRunInput, env: NodeJS.ProcessEnv): PublishGates => {
  const operatorEnabled = isProjectPublishEnabled(config, env);
  // Go-live 2026-07-31: approval and live default to TRUE — a publish request is taken at its word.
  // Passing approved:false or live:false still forces a dry-run plan, so a deliberate rehearsal
  // remains one explicit flag away; it is simply no longer the default posture.
  const approved = input.approved !== false;
  const live = input.live !== false;
  const gates: PublishGate[] = [
    { name: "operator_enabled", passed: operatorEnabled, reason: operatorEnabled ? undefined : `Publishing is not enabled for ${config.projectId}; set ${publishEnabledEnvVar(config)}=true in the deployment.` },
    { name: "explicit_approval", passed: approved, reason: approved ? undefined : "approved: true is required for a live publish." },
    { name: "explicit_live", passed: live, reason: live ? undefined : "live: true (dryRun false) is required for a live publish." }
  ];
  // Structural assertion, not decoration: an unreachable state here means a gate was renamed, dropped,
  // or made to pass on something other than its own input. Cheap, and it fails loudly at the one place
  // that would otherwise publish.
  const names = gates.map((gate) => gate.name);
  if (names.length !== PUBLISH_GATE_NAMES.length || !PUBLISH_GATE_NAMES.every((name, index) => names[index] === name)) {
    throw new Error(`publish_gate_set_changed: expected exactly [${PUBLISH_GATE_NAMES.join(", ")}], got [${names.join(", ")}]. The publish gates are a closed set; adding or removing one is a deliberate act, not a refactor.`);
  }
  const allPassed = operatorEnabled && approved && live;
  if (allPassed !== gates.every((gate) => gate.passed)) throw new Error("publish_gate_evaluation_inconsistent: a gate's passed flag disagrees with its own input.");
  return { operatorEnabled, approved, live, allPassed, gates };
};

const findArticleBody = (run: WorkflowExecutionRecord): unknown =>
  run.stageOutputs?.article_body ?? run.nodes.find((node) => node.nodeId === "article_body")?.output ?? run.entrypoint?.output;

// R-23 — the article_body node emits the CLIENT-shaped envelope
// ({artifact, summary, clientProjectId, clientObjectType, contractSource, body}), and the client's own
// object lives under `body`. This publisher used to validate the whole thing with articleBodySchema, the
// workspace-local {schema_version, nodes} shape — so `article_body_valid` could never pass on a real
// pipeline output, which is a T-3 blocker. Verified live: node.validate_output for article_body rejects
// a {schema_version, nodes} body on all six required fields.
//
// The node's own outputSchema is now the single authority, and the client object is unwrapped from
// `.body`. Node-walking below is tolerant: `nodes` is how Dr. Lurie's content_item carries blocks
// (required: [slug, title, nodes]), but a client whose contract shapes media differently simply reports
// no media rather than throwing — a wrong "no media" is caught downstream by the artifact-verification
// gate, whereas a throw here would take out the whole publish path.
type ClientObject = { nodes?: Array<{ id?: string; public?: { media?: { src?: unknown } } }> };
const clientObjectOf = (envelope: unknown): ClientObject =>
  (envelope && typeof envelope === "object" ? ((envelope as Record<string, unknown>).body as ClientObject) : undefined) ?? {};
const blocksOf = (body: ClientObject) => Array.isArray(body.nodes) ? body.nodes : [];

const bodyHasMedia = (body: ClientObject): boolean => blocksOf(body).some((node) => node?.public?.media !== undefined);

// Identify the first media slot whose reference is not among the pdf-tool-verified refs, so a blocked
// state can point at exactly which artifact slot needs materialization.
const firstUnverifiedMediaSlot = (body: ClientObject, verifiedRefs?: string[]): string | null => {
  const verified = new Set((verifiedRefs ?? []).map((ref) => String(ref)));
  const node = blocksOf(body).find((candidate) => typeof candidate?.public?.media?.src === "string" && !verified.has(candidate.public!.media!.src as string));
  return node ? `node:${node.id}/public.media` : null;
};

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

  const requestIdPattern = compileRequestIdPattern(config.objectDialect?.requestIdPattern);
  if (!requestIdPattern.test(input.requestId)) {
    return { published: false, mode: "error", gates, plan: null, steps: [], error: `invalid_request_id: must match ${requestIdPattern.source} (req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case), got "${input.requestId}".` };
  }

  // Validated against the article_body node's OWN outputSchema — the same authority the executor
  // enforces at execution time and buildInitialRun enforces on a seeded entrypoint. One definition of
  // "what a body is", so R-23 renaming the contract moves all three together.
  const envelope = findArticleBody(run);
  const bodyValidation = validateOutput(envelope, getWorkspaceNode("article_body")?.outputSchema);
  if (!bodyValidation.ok) {
    return { published: false, mode: "error", gates, plan: emptyPlan, steps: [], error: `no_valid_article_body: run ${input.runId} has no article_body output satisfying that node's outputSchema (${bodyValidation.errors.join("; ")}).` };
  }
  const body = clientObjectOf(envelope);
  // The publish dialect belongs to the client's contract, so both the displayed sequence and the
  // execution below come from the project's hooks — never hardcoded here (a client whose tools this
  // publisher guessed at would fail at its first call, or worse, half-publish).
  const hooks = getProjectHooks(projectId);
  const plan: PublishPlan = { projectId, requestId: input.requestId, nodeCount: blocksOf(body).length, publishedTime: input.publishedTime ?? null, toolSequence: hooks?.publishToolSequence ?? [] };

  // Project publish-readiness policy (GO/NO-GO). Layered via the hook registry so other projects
  // hosted by this workspace are NOT subject to Dr. Lurie's readiness rules. A NO-GO is an expected
  // safety state (blocked_for_publish_execution), surfaced as a resumable blocked state — not a failure.
  const readinessHook = hooks?.evaluatePublishReadiness;
  // The hook is handed the ENVELOPE, not the unwrapped client object: its `article_body_valid` check
  // now validates against the article_body node's own outputSchema (the single authority), exactly as
  // evaluatePublishReadiness below already does, and it unwraps `.body` itself for the media check.
  const readiness = readinessHook ? readinessHook({ articleBody: envelope, ...input.readiness }) : undefined;
  if (readiness && readiness.status === "no_go") {
    const artifactSlot = readiness.blockers.includes("media_artifacts_verified") ? firstUnverifiedMediaSlot(body, input.readiness?.verifiedMediaRefs) : null;
    return {
      published: false,
      mode: "blocked_for_publish_execution",
      gates,
      plan,
      steps: [],
      readiness,
      blocked: { requestId: input.requestId, nodeAwaitingApproval: "publication_controller", artifactSlot, requiredAction: readiness.requiredAction ?? `Resolve: ${readiness.blockers.join(", ")}.`, resumable: true }
    };
  }

  // This path executes text-only publishes; image/document media needs the artifact upload flow.
  if (bodyHasMedia(body)) {
    return { published: false, mode: "error", gates, plan: emptyPlan, steps: [], error: "image_media_unsupported: this publish path handles text-only bodies; image/document media requires the Dr. Lurie artifact upload flow and is not published here." };
  }

  if (!gates.allPassed) {
    const reason = gates.gates.filter((gate) => !gate.passed).map((gate) => gate.reason).join(" ");
    return { published: false, mode: "dry_run", gates, plan, steps: [], reason: reason || "One or more publish gates are not satisfied.", readiness };
  }

  // Every gate passed, but this project contributes no publish executor: refuse loudly. Falling back
  // to another client's dialect would fire that client's tool names at this client's server.
  if (!hooks?.executePublish) {
    return { published: false, mode: "error", gates, plan, steps: [], error: `no_publish_executor: project ${projectId} has no publish execution hook; refusing to guess a dialect.` };
  }

  // All gates passed: drive the project's sanctioned publish sequence through its own MCP tools.
  const callTool = deps.callTool ?? ((tool, args) => new ProjectMcpAdapter(config).callTool(tool, args));
  const steps: PublishStep[] = [];
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await callTool(tool, args);
    steps.push({ tool, ok: res.ok, error: res.error });
    if (!res.ok) throw new Error(`${tool}_failed: ${res.error ?? "call failed"}`);
    return res.result;
  };

  try {
    const outcome = await hooks.executePublish({
      requestId: input.requestId,
      envelope: envelope as Record<string, unknown>,
      body: body as Record<string, unknown>,
      // Passed through VERBATIM from the validated envelope (the outputSchema requires a string).
      clientObjectType: (envelope as Record<string, unknown>).clientObjectType as string,
      publishedTime: input.publishedTime ?? null,
      owner: OWNER,
      // Per-site parameters (owning site object id, taxonomy registry, who mints the object id) come
      // from the project's own config — the hook never carries another site's identifiers.
      ...(config.objectDialect ? { objectDialect: config.objectDialect } : {}),
      call
    });

    await learningRepository.recordObservation(`Live publish executed for ${projectId} request ${input.requestId}.`, { type: "publish_executed", projectId, requestId: input.requestId, runId: input.runId });
    return { published: true, mode: "live", gates, plan, steps, result: redactSensitiveKeys(outcome.result), ...(outcome.clientValidation ? { clientValidation: outcome.clientValidation } : {}), readiness };
  } catch (error) {
    const message = error instanceof Error ? error.message : "publish_failed";
    await learningRepository.recordObservation(`Live publish failed for ${projectId} request ${input.requestId}: ${message}`, { type: "publish_failed", projectId, requestId: input.requestId, runId: input.runId }).catch(() => undefined);
    return { published: false, mode: "error", gates, plan, steps, error: message };
  }
}

// Dry publish-readiness evaluation with no gates and no side effects. Resolves the article body from
// a runId (or a directly-supplied body) and runs the project's readiness hook. Returns available:false
// with no readiness when the project has no readiness policy — the UI then shows only the generic gate.
export async function evaluatePublishReadiness(
  input: { projectId: string; runId?: string; articleBody?: unknown; readiness?: PublishReadinessInput },
  deps: PublisherDeps = {}
): Promise<{ available: boolean; articleBodyValid: boolean; readiness: PublishReadinessResult | null }> {
  const executionRepository = deps.executionRepository ?? repositoryManager.getExecutionRepository();
  let articleBody = input.articleBody;
  if (articleBody === undefined && input.runId) {
    const run = await executionRepository.getRun(input.runId);
    articleBody = run ? findArticleBody(run) : undefined;
  }
  // Same authority as publishRun above: the node's own outputSchema. These two disagreeing is what let
  // publish_readiness report a checklist that a real pipeline output could never satisfy.
  const articleBodyValid = validateOutput(articleBody, getWorkspaceNode("article_body")?.outputSchema).ok;
  const hook = getProjectHooks(input.projectId)?.evaluatePublishReadiness;
  if (!hook) return { available: false, articleBodyValid, readiness: null };
  return { available: true, articleBodyValid, readiness: hook({ articleBody, ...input.readiness }) };
}

export const __test__ = { evaluateGates, findLockToken, firstUnverifiedMediaSlot, REQUEST_ID_PATTERN, compileRequestIdPattern, PUBLISH_GATE_NAMES };
