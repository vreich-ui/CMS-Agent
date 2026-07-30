import { Agent, run, tool, Runner } from "@openai/agents";
import { recordModelUsage, summarizeModelUsage, estimateModelCost } from "../../observability/modelUsage.js";
import { buildAgentModel, resolveProvider } from "../providers/providerRegistry.js";
import { renderPlaybookForPrompt } from "../../improvement/playbook.js";
import { repositoryManager } from "../../runtime/repositories.js";
import { getTool, resolveEffectiveToolsForNode } from "../../tools/toolResolver.js";
import { executeTool } from "../../tools/toolExecutor.js";
import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { ExecutionMode, NodeRunnerContext } from "../executionContext.js";
import { validateOutput } from "../outputValidator.js";
import type { NodeRunner, NodeRunnerInput, NodeRunnerResult } from "./NodeRunner.js";

const forbidden = /api[_-]?key|authorization|bearer|jwt|cookie|token|secret|blob.*credential/i;
const redact = (v: unknown): unknown => typeof v === "string" ? v.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]") : Array.isArray(v) ? v.map(redact) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k,val]) => [k, forbidden.test(k) ? "[REDACTED]" : redact(val)])) : v;
const numberFrom = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const stringFrom = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
const cfg = (node: WorkspaceNode) => ({ ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) });

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
    "Node prompt:", node.prompt,
    "Assigned dependencies and memory are provided in the user message. Never reveal secrets. Use only exposed tools."
  ].join("\n");
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
    // before the gate got another look. contract_intelligence took the run from $1.60 to $4.17
    // against a $3 ceiling in one dispatch (139% over). The in-loop guard below now watches
    // whichever ceiling is tighter — the node's own modelConfig.budgetUsd (rare, node-specific) or
    // the run's budgetUsd (the common case, set on workflow.start_dry_run) — not just the former.
    const nodeBudgetUsd = numberFrom(c.budgetUsd);
    const runBudgetUsd = numberFrom(context.run.budgetUsd);
    const budgetUsd = nodeBudgetUsd !== undefined && runBudgetUsd !== undefined ? Math.min(nodeBudgetUsd, runBudgetUsd) : nodeBudgetUsd ?? runBudgetUsd;
    // Reused below by the in-loop circuit breaker (B3) so a configured budget is only ever queried
    // once per node execution, not once here and again per turn.
    let priorSpendUsd = 0;
    if (budgetUsd !== undefined) {
      const spent = await summarizeModelUsage({ runId: context.run.runId });
      priorSpendUsd = spent.totalCostUsdEstimate;
      const reserve = estimateModelCost({ model: stringFrom(c.model) ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5", inputTokens: 1000, outputTokens: numberFrom(c.maxOutputTokens) ?? 1000 });
      if (priorSpendUsd + reserve > budgetUsd) return { ok: false, code: "budget_exceeded", message: "Estimated node budget would be exceeded.", details: { spentUsdEstimate: priorSpendUsd, reserveUsdEstimate: reserve, budgetUsd } };
    }
    // Empty allowedTools short-circuits tool resolution: the policy layer denies every tool for
    // such nodes anyway (node_tool_not_allowed), and skipping the lookup lets synthetic,
    // non-persisted nodes (the improvement judge/reflector) run through this runner without
    // tripping the resolver's unknown-node guard. Behavior for real nodes is unchanged.
    const effective = node.allowedTools.length === 0 ? [] : (await resolveEffectiveToolsForNode(node.id, { runId: context.run.runId, projectId: context.run.projectId, approvedToolIds: context.approvedToolIds, dryRun: context.run.dryRun })).filter((t) => t.allowed);
    const sdkTools = effective.map((t) => tool({
      name: t.name.replace(/[^A-Za-z0-9_-]/g, "_"),
      description: `${getTool(t.toolId)?.description ?? `Controlled CMS-Agent tool ${t.name}`} All calls are audited through ToolExecutor.`,
      // Declared NON-strict on purpose. OpenAI rejects a strict function schema unless it sets
      // additionalProperties:false and enumerates every property (a strict function with
      // additionalProperties:true returns "400 Invalid schema for function ...: 'additionalProperties'
      // is required to be supplied and to be false"). These controlled tools accept varied argument
      // shapes and are re-validated by ToolExecutor at call time, so an open non-strict object schema
      // is the correct declaration and keeps live (openai) execution working.
      parameters: { type: "object", properties: {}, required: [], additionalProperties: true } as any,
      strict: false,
      execute: async (args: unknown) => {
        const result = await executeTool(t.toolId, redact(args), { runId: context.run.runId, nodeId: node.id, projectId: context.run.projectId, approvedToolIds: context.approvedToolIds, dryRun: context.run.dryRun });
        // B2 (T-2): forward the actual violation, not just its code. A thrown "tool_failed:validation_error"
        // with nothing else told the model what to change, so it burned its turn budget retrying blind;
        // ToolExecutor now carries a field-path/expected/received message (or denial reasons) for exactly
        // this, and the SDK's default tool-error handler passes a thrown Error's message straight to the
        // model, so this is the one place that detail needs to be attached to reach it.
        if (!result.ok) throw new Error(result.denied ? `tool_denied:${result.denied.code}: ${result.denied.reasons.join(", ")}` : `tool_failed:${result.error?.code ?? "tool_failed"}${result.error?.message ? `: ${result.error.message}` : ""}`);
        return redact(result.output);
      }
    }));
    // Node-scoped ACE playbook replaces the old inject-every-global-observation behavior
    // (data-model-gaps §6): curated, deduplicated, size-budgeted lessons for THIS node only.
    // Synthetic improvement nodes have no playbook, so judge prompts stay uncontaminated.
    const playbook = await repositoryManager.getImprovementRepository().getPlaybook(node.id).catch(() => undefined);
    const playbookText = playbook ? renderPlaybookForPrompt(playbook) : "";
    const { model, settings } = modelSettings(node);
    const outputType = { type: "json_schema" as const, name: `${node.id}_output`, strict: false, schema: node.outputSchema as any };
    const agent = new Agent({ name: `cms_${node.id}`, instructions: instructions(node, input, playbookText), model: buildAgentModel(provider, model), modelSettings: settings, tools: sdkTools, outputType });
    const prompt = JSON.stringify(redact({ input, dependencyOutputs: Object.fromEntries(node.dependsOn.map((d) => [d, context.run.stageOutputs[d] ?? context.suppliedDependencies?.[d]])), ...(playbookText ? { playbook: playbookText } : {}), outputSchema: node.outputSchema }));
    // F5 (T-2, run_1785352838155_l544ye): draft_writer had NO explicit timeout, defaulted to 60s, and
    // failed with model_timeout on a large brief (300s configured live and it passed). 60s is too
    // tight a default for a single large-output generation call even with zero tool calls — the
    // default is now 120s; nodes with a proven need for more (draft_writer) carry their own explicit
    // override in nodes.ts on top of this.
    const timeoutMs = numberFrom(c.timeout) ?? 120000;
    const maxRetries = Math.max(0, Math.floor(numberFrom(c.retryCount) ?? 0));
    const maxTurns = resolveMaxTurns(c, effective.length);
    // B3 (T-2): budgetUsd was only ever checked ONCE, before this node's loop started — after that,
    // nothing looked again until the run's between-node gate noticed afterwards that the ceiling was
    // blown through (blocked, overBudget, one node having spent the whole thing). A budgeted node now
    // gets a second gate INSIDE its own loop: a Runner (rather than the bare run() function) is needed
    // to observe agent_start, which the SDK fires once per model turn with the run's cumulative token
    // usage so far. If the running total (prior nodes + this node's turns so far) would already clear
    // the ceiling, the node is aborted via signal before its next turn spends anything more, and
    // reports a distinct budget_exceeded rather than surfacing as a generic abort or being discovered
    // only when the run's overall budget gate runs between nodes. Behavior is byte-for-byte unchanged
    // when no budgetUsd is configured — the plain run() function is still used, exactly as before.
    let budgetExceededDetails: { spentUsdEstimate: number; budgetUsd: number; nodeId: string; turnUsage: { inputTokens: number; outputTokens: number } } | undefined;
    let turnSignal = context.signal;
    let runner: Runner | undefined;
    if (budgetUsd !== undefined) {
      const turnController = new AbortController();
      if (context.signal) {
        if (context.signal.aborted) turnController.abort();
        else context.signal.addEventListener("abort", () => turnController.abort(), { once: true });
      }
      turnSignal = turnController.signal as any;
      runner = new Runner();
      runner.on("agent_start", (runContext: any, _agent: unknown, turnInput?: unknown[]) => {
        if (turnController.signal.aborted) return;
        const turnUsage = { inputTokens: runContext.usage?.inputTokens ?? 0, outputTokens: runContext.usage?.outputTokens ?? 0 };
        const spentSoFar = priorSpendUsd + estimateModelCost({ model, inputTokens: turnUsage.inputTokens, outputTokens: turnUsage.outputTokens });
        // G4 (T-2 re-run, run_1785405350649_9u5mjz): spentSoFar alone only accounts for turns ALREADY
        // completed — this event fires BEFORE a turn's own usage is known, so on its own this guard
        // can only ever stop the turn AFTER the one that actually crosses the ceiling. That is exactly
        // what let contract_intelligence blow through a $4 ceiling by 118%: fallen back to full
        // self-discovery (F1's platform prefetch gap), each turn re-sent the whole growing
        // conversation, and whichever turn's own cost tipped it over had already run by the time the
        // NEXT turn's check could react. Reserve for the turn about to run too, estimated from the
        // exact input the SDK is about to send it (turnInput) — the same estimate-then-gate shape the
        // pre-dispatch check above already uses, just applied at every turn instead of only once.
        const prospectiveInputTokens = Math.ceil(JSON.stringify(turnInput ?? "").length / 4);
        const prospectiveReserve = estimateModelCost({ model, inputTokens: prospectiveInputTokens, outputTokens: numberFrom(c.maxOutputTokens) ?? 1000 });
        if (spentSoFar + prospectiveReserve > budgetUsd) {
          budgetExceededDetails = { spentUsdEstimate: Number(spentSoFar.toFixed(6)), budgetUsd, nodeId: node.id, turnUsage };
          turnController.abort();
        }
      });
    }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const runOnce = runner ? runner.run(agent, prompt, { maxTurns, signal: turnSignal as any, tracingDisabled: true, traceIncludeSensitiveData: false } as any) : run(agent, prompt, { maxTurns, signal: turnSignal as any, tracingDisabled: true, traceIncludeSensitiveData: false } as any);
        const result: any = await Promise.race([runOnce, new Promise((_, rej) => setTimeout(() => rej(new Error("model_timeout")), timeoutMs))]);
        const validated = validateOutput(result.finalOutput, node.outputSchema);
        if (!validated.ok) {
          if (attempt < maxRetries) continue;
          return { ok: false, code: "output_validation_failed", message: "OpenAI output did not match node.outputSchema.", details: validated.errors };
        }
        const usage = result.rawResponses?.reduce((a: any, r: any) => ({ inputTokens: a.inputTokens + (r.usage?.inputTokens ?? r.usage?.input_tokens ?? 0), outputTokens: a.outputTokens + (r.usage?.outputTokens ?? r.usage?.output_tokens ?? 0), reasoningTokens: a.reasoningTokens + (r.usage?.reasoningTokens ?? r.usage?.output_tokens_details?.reasoning_tokens ?? 0) }), { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
        // Usage token fields only. `actual` marks the NodeRunnerResult.usage (estimated vs actual);
        // it must NOT be spread into recordModelUsage, whose schema is strict and carries the
        // estimated/actual distinction in `status`. Spreading `actual` there previously threw
        // "unrecognized key: actual", failing an already-validated, successful model result.
        const usageFields = { inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0, reasoningTokens: usage?.reasoningTokens || 0, totalTokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0) };
        // Telemetry is non-authoritative: the validated output is the deliverable, so a usage-record
        // write failure must never discard a successful node (matches the workflow executor's pattern).
        await recordModelUsage({ runId: context.run.runId, workflowId: context.run.workflowId, projectId: context.run.projectId, nodeId: node.id, model, provider: provider.label, ...usageFields, status: "actual", metadata: { executionMode: "openai", traceId: result.lastResponseId } }).catch(() => undefined);
        return { ok: true, output: validated.value, usage: { ...usageFields, actual: true }, trace: { responseId: result.lastResponseId, toolCount: effective.length } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Checked before the generic cancellation/abort branch below: the in-loop circuit breaker
        // aborts via the same kind of signal a real cancellation would, so the flag it set is the
        // only way to tell "budget tripped mid-turn" apart from "caller cancelled".
        if (budgetExceededDetails) {
          return {
            ok: false,
            code: "budget_exceeded",
            message: `Node "${node.id}" was aborted mid-turn: estimated spend $${budgetExceededDetails.spentUsdEstimate} already meets or exceeds its $${budgetExceededDetails.budgetUsd} budget. Caught inside the agent loop before the next turn, rather than discovered only after the node finished.`,
            details: { ...budgetExceededDetails, stage: "mid_turn" }
          };
        }
        if (msg === "model_timeout") return { ok: false, code: "model_timeout", message: "OpenAI node execution timed out." };
        // Distinct and actionable: an exhausted turn budget is a configuration problem with one
        // specific fix, not the "the model errored" bucket. Reported as such even on a non-final
        // attempt, because retrying with the same cap can only exhaust it again.
        if (isMaxTurnsExceeded(error, msg)) {
          return {
            ok: false,
            code: "max_turns_exceeded",
            message: `Node "${node.id}" exhausted its agent-loop turn budget (maxTurns ${maxTurns}) with ${effective.length} tool(s) available, before it could emit its structured output. Raise the budget for this node: set modelConfig.maxTurns explicitly, or raise modelConfig.toolCallLimit (turns default to toolCallLimit + ${TURN_HEADROOM} for a tool-using node).`,
            details: { nodeId: node.id, maxTurns, toolCount: effective.length, toolCallLimit: numberFrom(c.toolCallLimit), configuredMaxTurns: numberFrom(c.maxTurns) }
          };
        }
        if (/aborted|cancel/i.test(msg)) return { ok: false, code: "cancelled", message: "OpenAI node execution was cancelled." };
        if (/tool_denied/.test(msg)) return { ok: false, code: "tool_denied", message: msg };
        if (/tool_failed/.test(msg)) return { ok: false, code: "tool_failed", message: msg };
        if (attempt >= maxRetries) return { ok: false, code: "model_error", message: msg };
      }
    }
    return { ok: false, code: "model_error", message: "OpenAI node execution failed." };
  }
}
