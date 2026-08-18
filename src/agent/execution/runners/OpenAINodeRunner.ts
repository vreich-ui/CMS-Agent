import { Agent, run, tool, OpenAIProvider } from "@openai/agents";
import { recordModelUsage, summarizeModelUsage, estimateModelCost } from "../../observability/modelUsage.js";
import { buildAgentModel, resolveProvider } from "../providers/providerRegistry.js";
import { renderPlaybookForPrompt } from "../../improvement/playbook.js";
import { repositoryManager } from "../../runtime/repositories.js";
import { getTool, resolveEffectiveToolsForNode } from "../../tools/toolResolver.js";
import { toolInputJsonSchema } from "../../tools/toolJsonSchema.js";
import { executeTool } from "../../tools/toolExecutor.js";
import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { ExecutionMode, NodeRunnerContext } from "../executionContext.js";
import { validateOutput } from "../outputValidator.js";
import type { NodeRunner, NodeRunnerInput, NodeRunnerResult, NodeToolCallRecord } from "./NodeRunner.js";
import { readRunContext, renderRunContextInstruction } from "../../workspace/runContext.js";
import { NodeBudgetExceededError, wrapModelWithBudgetGuard, type BudgetGuardState } from "./budgetGuard.js";

const forbidden = /api[_-]?key|authorization|bearer|jwt|cookie|token|secret|blob.*credential/i;
const redact = (v: unknown): unknown => typeof v === "string" ? v.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]") : Array.isArray(v) ? v.map(redact) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k,val]) => [k, forbidden.test(k) ? "[REDACTED]" : redact(val)])) : v;
const numberFrom = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const stringFrom = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
const cfg = (node: WorkspaceNode) => ({ ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) });

// Worst-case output reserved per model turn when a node declares no maxOutputTokens. Every canonical
// node now declares one (the node-limits audit); this covers ad-hoc/synthetic nodes only.
const DEFAULT_OUTPUT_TOKEN_RESERVE = 2000;

// Upper bound, in serialized characters, on a single controlled-tool result entering the model
// conversation. The conversation is re-sent on EVERY subsequent turn, so an unbounded tool result is
// paid once per remaining turn, not once: run_1785435947311_jl8hl4's artifact_plan reached 386K input
// tokens for a 3K-char output exactly this way (uncapped stage reads compounding across turns).
// web.fetch had a byte cap from day one; every other tool result had none. Override with
// TOOL_RESULT_MAX_CHARS; the truncation is explicit in the payload, never silent.
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 32000;
const toolResultMaxChars = () => {
  const configured = Number(process.env.TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_TOOL_RESULT_MAX_CHARS;
};

export const boundToolResult = (value: unknown, maxChars: number): unknown => {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length <= maxChars) return value;
  return {
    truncated: true,
    originalChars: serialized.length,
    note: `Tool result exceeded the ${maxChars}-character bound on what may enter the model conversation. Request something narrower (a specific stage id, a specific object) instead of retrying the same call; rely on inputs already delivered to you where possible.`,
    preview: serialized.slice(0, maxChars)
  };
};

function modelSettings(node: WorkspaceNode) {
  const c = cfg(node); const settings: Record<string, unknown> = { parallelToolCalls: false };
  const model = stringFrom(c.model) ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5";
  if (!/^gpt-5/i.test(model) && numberFrom(c.temperature) !== undefined) settings.temperature = numberFrom(c.temperature);
  if (numberFrom(c.maxOutputTokens) !== undefined) settings.maxTokens = numberFrom(c.maxOutputTokens);
  if (stringFrom(c.reasoningEffort)) settings.reasoning = { effort: stringFrom(c.reasoningEffort) };
  return { model, settings };
}

// Agent-loop turn budget. A "turn" in the Agents SDK is one model request plus the tool calls it
// issues; with parallelToolCalls disabled every tool call costs its own turn, and the node still
// needs a final turn to emit its structured output. maxTurns was previously read straight off
// `toolCallLimit`, conflating "how many tools may I call" with "how many model round-trips do I
// get" — which is what killed the research node in live mode: it is the first node holding
// web.search + web.fetch, and the cap was exhausted searching before it ever reached the turn that
// emits its output. A tool-free node never needed more than a couple of turns and was unaffected,
// which is why this only ever bit the tool-using nodes.
//
// Resolution order:
//   1. modelConfig/executionConfig.maxTurns — explicit per-node override, always wins.
//   2. a node holding tools — toolCallLimit + TURN_HEADROOM (the output turn, plus one spare so a
//      single malformed tool call does not cost the node its result).
//   3. a node holding no tools — DEFAULT_MAX_TURNS.
// Per node, never one global constant: research legitimately needs an order of magnitude more turns
// than a node that only reshapes its dependencies' output.
export const DEFAULT_MAX_TURNS = 4;
export const TURN_HEADROOM = 3;

export function resolveMaxTurns(config: Record<string, unknown>, toolCount: number): number {
  const explicit = numberFrom(config.maxTurns);
  if (explicit !== undefined) return Math.max(1, Math.floor(explicit));
  if (toolCount === 0) return DEFAULT_MAX_TURNS;
  const toolCallLimit = numberFrom(config.toolCallLimit) ?? DEFAULT_MAX_TURNS;
  return Math.max(DEFAULT_MAX_TURNS, Math.floor(toolCallLimit) + TURN_HEADROOM);
}

// The SDK signals an exhausted loop by throwing MaxTurnsExceededError ("Max turns (N) exceeded").
// Matched on shape rather than by importing the class so an SDK refactor degrades to the generic
// model_error path instead of breaking the build.
const isMaxTurnsExceeded = (error: unknown, message: string): boolean =>
  (error as { name?: string })?.name === "MaxTurnsExceededError" || /max turns?\b.*exceeded/i.test(message);

function instructions(node: WorkspaceNode, deps: unknown, observations: unknown) {
  return [
    "You are the CMS-Agent node runner. Return only structured JSON matching the output schema.",
    `Node: ${node.name} (${node.id})`,
    `Description: ${node.description}`,
    // W3 part 3 (determinism program, 2026-08-12): the run's client facts, stated once by the
    // conductor for every node, so a node never has to reconstruct clientProjectId/clientObjectType/
    // contractSource by echoing a dependency's output. Empty (and therefore absent from the system
    // prompt) for any dispatch whose input carries no runContext — a test double, a synthetic node.
    renderRunContextInstruction(readRunContext(deps)),
    "Node prompt:", node.prompt,
    "Assigned dependencies and memory are provided in the user message. Never reveal secrets. Use only exposed tools."
  ].filter(Boolean).join("\n");
}

export class OpenAINodeRunner implements NodeRunner {
  supports(mode: ExecutionMode) { return mode === "openai"; }
  validateConfiguration(node: WorkspaceNode) {
    const c = cfg(node); const errors: string[] = [];
    try { resolveProvider(c); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    if (!node.outputSchema) errors.push("outputSchema is required.");
    if (numberFrom(c.budgetUsd) !== undefined && numberFrom(c.budgetUsd)! < 0) errors.push("budgetUsd must be non-negative.");
    return errors.length ? { ok: false as const, errors } : { ok: true as const };
  }
  async run({ node, input }: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult> {
    const valid = this.validateConfiguration(node); if (!valid.ok) return { ok: false, code: "invalid_node_configuration", message: valid.errors.join("; ") };
    const c = cfg(node);
    const provider = resolveProvider(c);
    if (!process.env[provider.apiKeyEnv]) return { ok: false, code: "invalid_node_configuration", message: `${provider.apiKeyEnv} is required for ${provider.label} execution.` };
    // F2b (T-2, run_1785352838155_l544ye): the run's OWN budgetUsd ceiling was only ever evaluated
    // BETWEEN nodes (advanceRun's budget gate, before dispatch) — nothing inside a node's own turn
    // loop watched it, so a single node's turns could carry the run straight through the ceiling
    // before the gate got another look. The guard watches BOTH ceilings, separately: the node's own
    // modelConfig.budgetUsd bounds THIS NODE's spend, the run's budgetUsd (workflow.start_dry_run)
    // bounds the whole run's. They were previously collapsed to min(node, run) and compared against
    // run-wide prior spend — harmless while no node declared a budget, but with every canonical node
    // now carrying one, that conflation would refuse to run any node dispatched after cumulative run
    // spend passed its own small per-node ceiling.
    const nodeBudgetUsd = numberFrom(c.budgetUsd);
    const runBudgetUsd = numberFrom(context.run.budgetUsd);
    const budgetGuardEngaged = nodeBudgetUsd !== undefined || runBudgetUsd !== undefined;
    const { model, settings } = modelSettings(node);
    const maxOutputTokens = numberFrom(c.maxOutputTokens) ?? DEFAULT_OUTPUT_TOKEN_RESERVE;
    let priorSpendUsd = 0;
    if (budgetGuardEngaged) {
      // R-20: prior spend is measured spend only — estimated/mock records never count against budgets.
      // Perf (mcp-client-abort-timeouts-memoization): executor.ts's advanceRun computes this SAME
      // {runId} summary immediately before dispatch, for its own run.budgetUsd gate, whenever a run
      // budget is configured — which is exactly when runBudgetUsd below would be defined too. Reusing
      // its figure via context.priorRunSpendUsd avoids re-downloading/re-summing every usage record
      // for this run a second time in the same dispatch; a caller that never computed it (context.
      // priorRunSpendUsd undefined) falls back to querying it here exactly as before.
      const precomputed = numberFrom(context.priorRunSpendUsd);
      priorSpendUsd = precomputed !== undefined ? precomputed : (await summarizeModelUsage({ runId: context.run.runId })).actualCostUsdEstimate;
      const reserve = estimateModelCost({ model, inputTokens: 1000, outputTokens: maxOutputTokens });
      if (nodeBudgetUsd !== undefined && reserve > nodeBudgetUsd) {
        return { ok: false, code: "budget_exceeded", message: `Node "${node.id}"'s own budgetUsd ($${nodeBudgetUsd}) cannot cover even one model turn's reserve (~$${reserve}); raise modelConfig.budgetUsd or lower maxOutputTokens.`, details: { reserveUsdEstimate: reserve, nodeBudgetUsd, ceiling: "node" } };
      }
      if (runBudgetUsd !== undefined && priorSpendUsd + reserve > runBudgetUsd) {
        return { ok: false, code: "budget_exceeded", message: "Estimated node budget would be exceeded.", details: { spentUsdEstimate: priorSpendUsd, reserveUsdEstimate: reserve, budgetUsd: runBudgetUsd, ceiling: "run" } };
      }
    }
    // Empty allowedTools short-circuits tool resolution: the policy layer denies every tool for
    // such nodes anyway (node_tool_not_allowed), and skipping the lookup lets synthetic,
    // non-persisted nodes (the improvement judge/reflector) run through this runner without
    // tripping the resolver's unknown-node guard. Behavior for real nodes is unchanged.
    const effective = node.allowedTools.length === 0 ? [] : (await resolveEffectiveToolsForNode(node.id, { runId: context.run.runId, workflowId: context.run.workflowId, projectId: context.run.projectId, approvedToolIds: context.approvedToolIds, dryRun: context.run.dryRun })).filter((t) => t.allowed);
    // toolCallLimit is now enforced as an actual per-execution tool-call cap, not just an input to the
    // turn budget: nothing previously counted invocations against it, so "toolCallLimit: 5" bounded
    // nothing. Calls beyond the limit are refused with a named denial the model can read; maxTurns
    // still bounds how long it can keep trying.
    const toolCallLimit = numberFrom(c.toolCallLimit);
    const resultMaxChars = toolResultMaxChars();
    const toolCalls: NodeToolCallRecord[] = [];
    let toolCallCount = 0;
    const sdkTools = effective.map((t) => tool({
      name: t.name.replace(/[^A-Za-z0-9_-]/g, "_"),
      description: `${getTool(t.toolId)?.description ?? `Controlled CMS-Agent tool ${t.name}`} All calls are audited through ToolExecutor.`,
      // S1: the tool's REAL parameter schema, derived from its zod inputSchema (toolJsonSchema.ts).
      // Until now this was the open placeholder {properties:{}, additionalProperties:true}, which
      // told the model nothing about the argument names the strict server-side schema would then
      // reject. Still declared NON-strict: OpenAI's strict mode demands additionalProperties:false
      // AND every property required, which optional arguments (tool?, arguments?) cannot satisfy;
      // ToolExecutor re-validates every call against the zod schema regardless.
      parameters: toolInputJsonSchema(getTool(t.toolId)?.inputSchema) as any,
      strict: false,
      execute: async (args: unknown) => {
        toolCallCount += 1;
        if (toolCallLimit !== undefined && toolCallCount > toolCallLimit) {
          toolCalls.push({ toolId: t.toolId, status: "denied", errorCode: "tool_call_limit_exceeded" });
          throw new Error(`tool_denied:tool_call_limit_exceeded: node "${node.id}" has used all ${toolCallLimit} of its allowed tool calls. Emit your structured output now from the inputs and results you already have; further tool calls will also be refused.`);
        }
        const startedAt = Date.now();
        const result = await executeTool(t.toolId, redact(args), { runId: context.run.runId, nodeId: node.id, workflowId: context.run.workflowId, projectId: context.run.projectId, approvedToolIds: context.approvedToolIds, dryRun: context.run.dryRun });
        toolCalls.push({ toolId: t.toolId, toolExecutionId: result.toolExecutionId, status: result.ok ? "success" : result.denied ? "denied" : "error", errorCode: result.ok ? undefined : result.denied?.code ?? result.error?.code, durationMs: Date.now() - startedAt });
        // B2 (T-2): forward the actual violation, not just its code. A thrown "tool_failed:validation_error"
        // with nothing else told the model what to change, so it burned its turn budget retrying blind;
        // ToolExecutor now carries a field-path/expected/received message (or denial reasons) for exactly
        // this, and the SDK's default tool-error handler passes a thrown Error's message straight to the
        // model, so this is the one place that detail needs to be attached to reach it.
        if (!result.ok) throw new Error(result.denied ? `tool_denied:${result.denied.code}: ${result.denied.reasons.join(", ")}` : `tool_failed:${result.error?.code ?? "tool_failed"}${result.error?.message ? `: ${result.error.message}` : ""}`);
        return boundToolResult(redact(result.output), resultMaxChars);
      }
    }));
    // Node-scoped ACE playbook replaces the old inject-every-global-observation behavior
    // (data-model-gaps §6): curated, deduplicated, size-budgeted lessons for THIS node only.
    // Synthetic improvement nodes have no playbook, so judge prompts stay uncontaminated.
    const playbook = await repositoryManager.getImprovementRepository().getPlaybook(node.id).catch(() => undefined);
    const playbookText = playbook ? renderPlaybookForPrompt(playbook) : "";
    const outputType = { type: "json_schema" as const, name: `${node.id}_output`, strict: false, schema: node.outputSchema as any };
    // Per-model-request budget guard (see budgetGuard.ts). The previous agent_start-hook guard read a
    // usage object that stays empty during the loop, so its accrued-spend term never grew and
    // artifact_plan carried a $3 ceiling to 138% in one dispatch. Wrapping the Model itself gates
    // BEFORE every request with real accumulated usage. The default provider path resolves the model
    // through the SDK's own OpenAIProvider (same Responses API the bare model-name string uses).
    const guardState: BudgetGuardState = { accrued: { inputTokens: 0, outputTokens: 0 } };
    let agentModel = buildAgentModel(provider, model);
    if (budgetGuardEngaged) {
      const innerModel = typeof agentModel === "string" ? await new OpenAIProvider().getModel(agentModel) : agentModel;
      agentModel = wrapModelWithBudgetGuard(innerModel, { nodeId: node.id, model, nodeBudgetUsd, runBudgetUsd, priorSpendUsd, maxOutputTokens }, guardState);
    }
    const agent = new Agent({ name: `cms_${node.id}`, instructions: instructions(node, input, playbookText), model: agentModel, modelSettings: settings, tools: sdkTools, outputType });
    // Dependency outputs used to be serialized TWICE into every prompt: once inside `input` (the
    // executor delivers them as input.dependencies) and again as a sibling `dependencyOutputs` key.
    // For a node like article_body that duplication alone doubled an 18K-char payload on every turn.
    // The prompt now carries them once, under `dependencyOutputs`, resolved from the delivered input
    // first and the run's stage outputs otherwise (the single-node path supplies its own).
    const inputRecord = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
    const deliveredDependencies = inputRecord?.dependencies && typeof inputRecord.dependencies === "object" ? (inputRecord.dependencies as Record<string, unknown>) : undefined;
    const { dependencies: _delivered, ...inputSansDependencies } = inputRecord ?? {};
    const dependencyOutputs = Object.fromEntries(node.dependsOn.map((d) => [d, deliveredDependencies?.[d] ?? context.run.stageOutputs[d] ?? context.suppliedDependencies?.[d]]));
    const prompt = JSON.stringify(redact({ input: inputRecord ? inputSansDependencies : input, dependencyOutputs, ...(playbookText ? { playbook: playbookText } : {}), outputSchema: node.outputSchema }));
    // F5 (T-2, run_1785352838155_l544ye): draft_writer had NO explicit timeout, defaulted to 60s, and
    // failed with model_timeout on a large brief (300s configured live and it passed). 60s is too
    // tight a default for a single large-output generation call even with zero tool calls — the
    // default is now 120s; nodes with a proven need for more (draft_writer) carry their own explicit
    // override in nodes.ts on top of this.
    const timeoutMs = numberFrom(c.timeout) ?? 120000;
    const maxRetries = Math.max(0, Math.floor(numberFrom(c.retryCount) ?? 0));
    const maxTurns = resolveMaxTurns(c, effective.length);
    // A failed node's real spend used to vanish: usage was recorded only on the success path, so an
    // aborted or timed-out node contributed $0 to the run ledger the budget gate reads — hiding
    // exactly the overshoot it was supposed to stop. The guard accumulates actual usage per model
    // response; any exit that leaves accrued usage behind records it (best-effort, like the success
    // path's own telemetry).
    const recordAccruedUsage = async (failureCode: string, attempt: number): Promise<void> => {
      // Session E: prefer the SDK-accumulated total across every attempt this dispatch actually
      // completed a response for (cumulativeUsage) over the budget guard's own accrued figure
      // (guardState.accrued), which is populated only when a run budget is configured at all. Both
      // read the SAME underlying model responses when both are populated — this is a choice of
      // source, not an addition of two sources, so it cannot double-count. guardState.accrued remains
      // the fallback for a throw that happened before any full response completed (this dispatch's own
      // rawResponses were never populated) where the guard's mid-turn accounting is the only figure
      // that exists at all.
      const usable = cumulativeUsage.inputTokens > 0 || cumulativeUsage.outputTokens > 0 ? cumulativeUsage : guardState.accrued;
      const { inputTokens, outputTokens } = usable;
      if (inputTokens === 0 && outputTokens === 0) return;
      await recordModelUsage({
        runId: context.run.runId, requestId: context.run.requestId, workflowId: context.run.workflowId, projectId: context.run.projectId, nodeId: node.id, model, provider: provider.label,
        inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
        reasoningTokens: "reasoningTokens" in usable ? (usable as typeof cumulativeUsage).reasoningTokens : undefined,
        cachedInputTokens: "cachedInputTokens" in usable ? (usable as typeof cumulativeUsage).cachedInputTokens : undefined,
        status: "actual",
        metadata: { executionMode: "openai", partial: true, failureCode, attempt: attempt + 1, attemptsTotal: attempt + 1, turnCount, toolCallCount }
      }).catch(() => undefined);
    };
    // Session E: accumulates every ATTEMPT this dispatch obtained a real SDK result for — including a
    // validation-failed attempt that gets retried, whose real token spend previously vanished from the
    // ledger entirely (recorded neither on that attempt, since it wasn't final, nor folded into the
    // eventual success record, which used to read only the LAST attempt's own usage). Distinct from
    // guardState.accrued (the budget guard's own running total, gated on budgetGuardEngaged, updated
    // per model response for real-time spend gating) — this is the general-purpose ledger source,
    // present whether or not a budget is configured, and it is what recordAccruedUsage now prefers.
    const cumulativeUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
    // Session E: env-controlled, default OFF (matches every prior hardcoded `tracingDisabled: true` —
    // this is a policy toggle, not a behavior change, until an operator opts in). AGENT_TRACING_ENABLED
    // must be exactly "true" to turn tracing on. When on, only safe, already-public-within-the-run
    // metadata is attached — workflow name, run id, node id, project id, execution mode, attempt.
    // Never authorization headers, tokens, full client contracts, or publish payloads: none of those
    // are ever assembled into traceMetadata here, by construction (it is built from five named scalars,
    // not from `input`, `dependencyOutputs`, or anything sourced from the node's own prompt/response).
    const tracingEnabled = process.env.AGENT_TRACING_ENABLED === "true";
    const tracingMetadataFor = (attempt: number): Record<string, string> => ({
      runId: context.run.runId,
      nodeId: node.id,
      projectId: context.run.projectId,
      executionMode: "openai",
      attempt: String(attempt + 1)
    });
    let turnCount = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const runOnce = run(agent, prompt, {
          maxTurns, signal: context.signal as any,
          tracingDisabled: !tracingEnabled, traceIncludeSensitiveData: false,
          ...(tracingEnabled ? { workflowName: context.run.workflowId, traceMetadata: tracingMetadataFor(attempt) } : {})
        } as any);
        const result: any = await Promise.race([runOnce, new Promise((_, rej) => setTimeout(() => rej(new Error("model_timeout")), timeoutMs))]);
        const usage = result.rawResponses?.reduce((a: any, r: any) => ({
          inputTokens: a.inputTokens + (r.usage?.inputTokens ?? r.usage?.input_tokens ?? 0),
          outputTokens: a.outputTokens + (r.usage?.outputTokens ?? r.usage?.output_tokens ?? 0),
          reasoningTokens: a.reasoningTokens + (r.usage?.reasoningTokens ?? r.usage?.output_tokens_details?.reasoning_tokens ?? 0),
          cachedInputTokens: a.cachedInputTokens + (r.usage?.cachedInputTokens ?? r.usage?.input_tokens_details?.cached_tokens ?? 0)
        }), { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }) ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
        cumulativeUsage.inputTokens += usage.inputTokens;
        cumulativeUsage.outputTokens += usage.outputTokens;
        cumulativeUsage.reasoningTokens += usage.reasoningTokens;
        cumulativeUsage.cachedInputTokens += usage.cachedInputTokens;
        turnCount += result.rawResponses?.length ?? 0;
        const validated = validateOutput(result.finalOutput, node.outputSchema);
        if (!validated.ok) {
          if (attempt < maxRetries) continue;
          await recordAccruedUsage("output_validation_failed", attempt);
          return { ok: false, code: "output_validation_failed", message: "OpenAI output did not match node.outputSchema.", details: validated.errors, toolCalls };
        }
        // Usage token fields only. `actual` marks the NodeRunnerResult.usage (estimated vs actual);
        // it must NOT be spread into recordModelUsage, whose schema is strict and carries the
        // estimated/actual distinction in `status`. Spreading `actual` there previously threw
        // "unrecognized key: actual", failing an already-validated, successful model result.
        // cumulativeUsage, not just this attempt's own `usage` — a node retried after a validation
        // failure previously recorded only its FINAL (successful) attempt's tokens, silently dropping
        // the real spend of every earlier attempt from the ledger. One record, summed across every
        // attempt this dispatch made, recorded exactly once (never double-counted, since it is written
        // only here on the terminal success path).
        const usageFields = { inputTokens: cumulativeUsage.inputTokens, outputTokens: cumulativeUsage.outputTokens, reasoningTokens: cumulativeUsage.reasoningTokens, cachedInputTokens: cumulativeUsage.cachedInputTokens, totalTokens: cumulativeUsage.inputTokens + cumulativeUsage.outputTokens };
        // Telemetry is non-authoritative: the validated output is the deliverable, so a usage-record
        // write failure must never discard a successful node (matches the workflow executor's pattern).
        await recordModelUsage({ runId: context.run.runId, requestId: context.run.requestId, workflowId: context.run.workflowId, projectId: context.run.projectId, nodeId: node.id, model, provider: provider.label, ...usageFields, status: "actual", metadata: { executionMode: "openai", traceId: result.lastResponseId, attempt: attempt + 1, attemptsTotal: attempt + 1, turnCount, toolCallCount } }).catch(() => undefined);
        return { ok: true, output: validated.value, usage: { ...usageFields, actual: true }, trace: { responseId: result.lastResponseId, toolCount: effective.length }, toolCalls, outputValidated: true };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Checked before the generic cancellation/abort branch below: the guard throws from inside the
        // model call, and the flag it sets is how "budget tripped mid-loop" stays distinguishable from
        // "caller cancelled" no matter how the SDK re-wraps the thrown error.
        if (guardState.exceeded || error instanceof NodeBudgetExceededError) {
          const details = guardState.exceeded ?? (error as NodeBudgetExceededError).details;
          await recordAccruedUsage("budget_exceeded", attempt);
          return {
            ok: false,
            code: "budget_exceeded",
            message: `Node "${node.id}" stopped before the model turn that would cross the ${details.ceiling} budget: estimated spend $${details.spentUsdEstimate} plus ~$${details.prospectiveTurnUsd} for the upcoming turn exceeds the $${details.budgetUsd} ceiling. Caught inside the agent loop before the turn ran, not after.`,
            details: { ...details, stage: "mid_loop" },
            toolCalls
          };
        }
        if (msg === "model_timeout") { await recordAccruedUsage("model_timeout", attempt); return { ok: false, code: "model_timeout", message: "OpenAI node execution timed out.", toolCalls }; }
        // Distinct and actionable: an exhausted turn budget is a configuration problem with one
        // specific fix, not the "the model errored" bucket. Reported as such even on a non-final
        // attempt, because retrying with the same cap can only exhaust it again.
        if (isMaxTurnsExceeded(error, msg)) {
          await recordAccruedUsage("max_turns_exceeded", attempt);
          return {
            ok: false,
            code: "max_turns_exceeded",
            message: `Node "${node.id}" exhausted its agent-loop turn budget (maxTurns ${maxTurns}) with ${effective.length} tool(s) available, before it could emit its structured output. Raise the budget for this node: set modelConfig.maxTurns explicitly, or raise modelConfig.toolCallLimit (turns default to toolCallLimit + ${TURN_HEADROOM} for a tool-using node).`,
            details: { nodeId: node.id, maxTurns, toolCount: effective.length, toolCallLimit: numberFrom(c.toolCallLimit), configuredMaxTurns: numberFrom(c.maxTurns) },
            toolCalls
          };
        }
        if (/aborted|cancel/i.test(msg)) { await recordAccruedUsage("cancelled", attempt); return { ok: false, code: "cancelled", message: "OpenAI node execution was cancelled.", toolCalls }; }
        if (/tool_denied/.test(msg)) { await recordAccruedUsage("tool_denied", attempt); return { ok: false, code: "tool_denied", message: msg, toolCalls }; }
        if (/tool_failed/.test(msg)) { await recordAccruedUsage("tool_failed", attempt); return { ok: false, code: "tool_failed", message: msg, toolCalls }; }
        if (attempt >= maxRetries) { await recordAccruedUsage("model_error", attempt); return { ok: false, code: "model_error", message: msg, toolCalls }; }
      }
    }
    await recordAccruedUsage("model_error", maxRetries);
    return { ok: false, code: "model_error", message: "OpenAI node execution failed.", toolCalls };
  }
}
