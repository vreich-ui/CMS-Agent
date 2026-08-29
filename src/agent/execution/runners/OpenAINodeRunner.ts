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
import { classifyProviderHttpError, operatorActionForBudgetExceeded, operatorActionForProviderHttpError, truncateProviderMessage } from "./providerHttpErrors.js";

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

// T12.22 — the DEPENDENCY half of the same lesson `boundToolResult` above learned.
//
// Tool results were capped; dependency outputs never were. That asymmetry is what hung
// `gap_adjudicator` in a reclaim loop for a full day. It is the capture workflow's only CONFLUENCE
// node: its single dependency is `capture_score`, whose envelope aggregates every page, every
// visual comparison and the site-wide gap report. That whole object went into the prompt through a
// plain JSON.stringify. The model call never returned inside its 180s timeout, the process died
// before `delete state.dispatch` could run, the orphaned claim aged past
// timeout + STALL_MARGIN_MS (270s), the next advance reclaimed it as `stale_dispatch_reclaimed`
// and re-dispatched the identical oversized payload. ~248 times in 24h. Forever, by construction.
//
// WHY NOT A BLIND SLICE. `boundToolResult` may hand the model a `preview` string because a tool
// result is one leaf the model asked for. A dependency output is the node's whole evidentiary
// input; cutting it mid-token yields unparseable JSON and converts a hang into an
// `output_validation_failed` — a different failure, not a fix. So this SHRINKS instead of cutting:
// it repeatedly halves the largest arrays (the bulk is always evidence arrays) until the payload
// fits, leaving every object key, every scalar and valid JSON throughout. What was dropped is
// declared, per path, in a `__truncation` ledger the model can read and cite.
//
// Deliberately generous relative to a tool result: this is the node's primary input, not a lookup.
export const DEFAULT_DEPENDENCY_OUTPUT_MAX_CHARS = 48000;
export const dependencyOutputMaxChars = () => {
  const configured = Number(process.env.DEPENDENCY_OUTPUT_MAX_CHARS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_DEPENDENCY_OUTPUT_MAX_CHARS;
};

const DEPENDENCY_TRUNCATION_NOTE =
  "This dependency output was too large to deliver whole. Object keys and scalars are intact; the " +
  "arrays listed below were shortened, keeping their leading entries. Judge from what is present " +
  "and say plainly that your view was partial — never infer that a dropped entry did not exist, " +
  "and never invent one.";

type ArraySite = { parent: unknown[] | Record<string, unknown>; key: string | number; path: string; array: unknown[] };

const collectArraySites = (value: unknown, path: string, into: ArraySite[]): void => {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const child = value[i];
      if (Array.isArray(child)) into.push({ parent: value, key: i, path: `${path}[${i}]`, array: child });
      collectArraySites(child, `${path}[${i}]`, into);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (Array.isArray(child)) into.push({ parent: value as Record<string, unknown>, key, path: childPath, array: child });
    collectArraySites(child, childPath, into);
  }
};

/**
 * Shrink one dependency output to fit `maxChars` WITHOUT breaking its shape.
 *
 * Halves the largest array, re-measures, repeats. Every array keeps at least one element so the
 * model can still see what the shape of a dropped entry was. Returns the value untouched when it
 * already fits, and falls back to the tool-result bound only for a non-object payload (a giant
 * bare string), where there is no structure to preserve in the first place.
 */
export const boundDependencyOutput = (value: unknown, maxChars: number): unknown => {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length <= maxChars) return value;
  if (!value || typeof value !== "object") return boundToolResult(value, maxChars);

  const clone = JSON.parse(serialized) as Record<string, unknown>;
  const dropped = new Map<string, { kept: number; total: number }>();

  // The ledger is part of the payload, so it has to be MEASURED as part of the payload. Shrinking
  // against the bare clone and appending the ledger afterwards overshoots by the ledger's own size
  // — caught by the nested-array test, which came back 4417 chars against a 4000 bound. Every pass
  // now measures exactly what will be returned.
  const withLedger = (): unknown =>
    dropped.size === 0
      ? clone
      : {
          ...clone,
          __truncation: {
            reason: "dependency_output_exceeded_prompt_bound",
            originalChars: serialized.length,
            maxChars,
            note: DEPENDENCY_TRUNCATION_NOTE,
            shortenedArrays: [...dropped.entries()]
              .map(([path, counts]) => ({ path, kept: counts.kept, total: counts.total }))
              .sort((a, b) => b.total - a.total)
          }
        };

  // Bounded by construction: every pass strictly shortens the single largest array, so the loop
  // either fits the budget or runs out of arrays it is allowed to shorten further.
  for (let pass = 0; pass < 500; pass += 1) {
    if (JSON.stringify(withLedger()).length <= maxChars) break;
    const sites: ArraySite[] = [];
    collectArraySites(clone, "", sites);
    const shrinkable = sites.filter((site) => site.array.length > 1);
    if (shrinkable.length === 0) break;
    let largest = shrinkable[0];
    let largestSize = JSON.stringify(largest.array).length;
    for (const site of shrinkable.slice(1)) {
      const size = JSON.stringify(site.array).length;
      if (size > largestSize) { largest = site; largestSize = size; }
    }
    const total = dropped.get(largest.path)?.total ?? largest.array.length;
    const kept = Math.max(1, Math.floor(largest.array.length / 2));
    (largest.parent as Record<string | number, unknown>)[largest.key] = largest.array.slice(0, kept);
    dropped.set(largest.path, { kept, total });
  }

  const bounded = withLedger();
  // Shrinking every array to a single element can still not be enough — a payload whose bulk is one
  // enormous scalar, or a bound smaller than the ledger itself. Say so with the tool-result bound
  // rather than returning something over budget and calling it bounded.
  if (JSON.stringify(bounded).length > maxChars) return boundToolResult(value, maxChars);
  return bounded;
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

// W12 — truncation retry (run_1787953591700_nla80z, run_1788011844073_ipwrnx).
//
// A model node whose structured output exceeds modelConfig.maxOutputTokens gets its JSON cut off
// mid-string. The SDK's structured-output parser (agents-core's turnResolution.js) then throws a
// ModelBehaviorError reading "Invalid output type: Unterminated string in JSON at position N" —
// indistinguishable, by message alone, from any other malformed-output model_error. Two problems
// this section fixes: classifying that failure by name, and not retrying it against the SAME cap
// (which can only truncate again).
//
// DETECTION. The SDK exposes a documented `errorHandlers.invalidFinalOutput` hook on run() options
// (agents-core/dist/runner/errorHandlers.d.ts's RunErrorHandlers) specifically for this error kind.
// It receives `runData.rawResponses` — the SAME array `state._modelResponses` this dispatch just
// pushed the failing turn's raw response onto (run.js:455, BEFORE resolveTurnAfterModelResponse can
// throw at run.js:467) — before the SDK decides what to do with the error. Returning `undefined`
// from the handler declines to override the outcome (resolveRunErrorHandler treats a falsy result as
// "not handled"), so the SDK still throws exactly as before; the handler is used purely as a
// side-channel tap to read the raw response the thrown error itself does not carry (the
// ModelBehaviorError turnResolution.js constructs at line ~742 is `new ModelBehaviorError(message)` —
// ONE arg, so its inherited `.state` is `undefined`, not the RunState `resolveTurnAfterModelResponse`
// had in scope; there is no other way to reach the raw response from outside the SDK).
//
// The raw response's `providerData` is the untouched provider payload (openaiResponsesModel.js's
// getResponse: `providerData: response` — the full OpenAI Responses API object; equally for
// openaiChatCompletionsModel.js on an openai_compatible/google provider). That is the PROVIDER'S OWN
// signal: Responses API truncation is `response.status === "incomplete"` with
// `response.incomplete_details.reason === "max_output_tokens"` (openai's responses.d.ts); a Chat
// Completions-shaped provider reports it as `choices[0].finish_reason === "length"`.
//
// FALLBACK. Not every provider path is guaranteed to carry that signal (a proxy that drops it, a
// provider this runner has not been taught the shape of yet), so the JSON-parse failure itself is a
// second, weaker signal — but ONLY when the observed output is at or near the cap that was actually
// sent. A malformed-JSON response from a model that stopped well under its cap is a real (and
// different) model defect, not truncation, and must not be relabeled — hence the NEAR_CAP_RATIO gate
// below, checked against the SAME response's own usage.outputTokens.
type RawTruncationResponse = { usage?: { outputTokens?: number }; providerData?: unknown };

function providerSignalsTruncation(response: RawTruncationResponse | undefined): boolean {
  const pd = response?.providerData as Record<string, unknown> | undefined;
  if (!pd || typeof pd !== "object") return false;
  const incompleteDetails = pd.incomplete_details as { reason?: string } | undefined;
  if (pd.status === "incomplete" && incompleteDetails?.reason === "max_output_tokens") return true;
  const choices = pd.choices as Array<{ finish_reason?: string }> | undefined;
  if (Array.isArray(choices) && choices[0]?.finish_reason === "length") return true;
  return pd.finish_reason === "length";
}

// The parse-failure SHAPE that a mid-string cutoff produces. Deliberately narrow: "Unexpected token"/
// "Expected ',' or '}'"-style messages indicate genuinely malformed content, not necessarily a cutoff,
// and must keep failing as model_error — only these two V8 JSON.parse messages are cutoff-shaped.
const JSON_TRUNCATION_SHAPE = /Unterminated string in JSON|Unexpected end of JSON input/i;
// How close to the cap the observed output has to be for the parse-failure shape to count as
// truncation evidence on its own (no provider signal). 90%: comfortably past "the model just
// happened to stop mid-string for an unrelated reason" while tolerant of the cap/observed-token
// accounting not lining up to the last token.
const NEAR_CAP_TRUNCATION_RATIO = 0.9;

// Upper bound on how far the truncation retry may double a node's configured cap. Override per
// deployment via OPENAI_MAX_OUTPUT_TOKENS_CEILING if a model's real ceiling differs.
export const DEFAULT_MAX_OUTPUT_TOKENS_CEILING = 128000;
export const maxOutputTokensCeiling = (): number => {
  const configured = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS_CEILING);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_OUTPUT_TOKENS_CEILING;
};

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
        return { ok: false, code: "budget_exceeded", message: `Node "${node.id}"'s own budgetUsd ($${nodeBudgetUsd}) cannot cover even one model turn's reserve (~$${reserve}); raise modelConfig.budgetUsd or lower maxOutputTokens.`, details: { reserveUsdEstimate: reserve, nodeBudgetUsd, ceiling: "node" }, operatorAction: operatorActionForBudgetExceeded(nodeBudgetUsd, 0) };
      }
      if (runBudgetUsd !== undefined && priorSpendUsd + reserve > runBudgetUsd) {
        return { ok: false, code: "budget_exceeded", message: "Estimated node budget would be exceeded.", details: { spentUsdEstimate: priorSpendUsd, reserveUsdEstimate: reserve, budgetUsd: runBudgetUsd, ceiling: "run" }, operatorAction: operatorActionForBudgetExceeded(runBudgetUsd, priorSpendUsd) };
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
    // A plain mutable object (not spread into the wrapper): the truncation retry below doubles
    // settings.maxTokens and updates this SAME object's maxOutputTokens field so the guard's
    // per-turn cost estimate (budgetGuard.ts's gate(), which reads config.maxOutputTokens on every
    // call) reflects the larger cap actually being sent, instead of silently under-pricing the retry.
    const budgetGuardConfig = { nodeId: node.id, model, nodeBudgetUsd, runBudgetUsd, priorSpendUsd, maxOutputTokens };
    let agentModel = buildAgentModel(provider, model);
    if (budgetGuardEngaged) {
      const innerModel = typeof agentModel === "string" ? await new OpenAIProvider().getModel(agentModel) : agentModel;
      agentModel = wrapModelWithBudgetGuard(innerModel, budgetGuardConfig, guardState);
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
    // Each dependency is bounded INDEPENDENTLY, so one oversized confluence input cannot crowd out
    // a small sibling the node also needs (see boundDependencyOutput).
    const dependencyMaxChars = dependencyOutputMaxChars();
    const dependencyOutputs = Object.fromEntries(node.dependsOn.map((d) => [d, boundDependencyOutput(deliveredDependencies?.[d] ?? context.run.stageOutputs[d] ?? context.suppliedDependencies?.[d], dependencyMaxChars)]));
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
    const recordAccruedUsage = async (failureCode: string, attempt: number, extraMetadata?: Record<string, unknown>): Promise<void> => {
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
        metadata: { executionMode: "openai", partial: true, failureCode, attempt: attempt + 1, attemptsTotal: attempt + 1, turnCount, toolCallCount, ...extraMetadata }
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
    // W12 truncation retry — see the DETECTION comment above providerSignalsTruncation. Tracked
    // outside the loop: `initialMaxOutputTokens` is the node's ORIGINAL configured cap (for the
    // failure message, even after settings.maxTokens has been doubled); `truncationRetryUsed` grants
    // exactly ONE doubled-cap retry for the whole dispatch, independently of maxRetries/retryCount —
    // a second truncation (or a first one with no cap left to raise) fails the node instead of
    // burning the ordinary validation-retry budget on a request that can only fail the same way
    // again. `lastInvalidOutputResponses` is the side-channel the invalidFinalOutput errorHandler
    // (passed to run() below) writes the failing turn's raw response array into; reset before every
    // attempt so a stale response from an earlier attempt can never be misread as this one's.
    const initialMaxOutputTokens = numberFrom(settings.maxTokens);
    let truncationRetryUsed = false;
    let lastInvalidOutputResponses: RawTruncationResponse[] | undefined;
    // The loop's normal bound is attempt<=maxRetries, exactly as before; +1 accommodates the single
    // bonus truncation retry, which can land on any attempt (including the last "normal" one) and
    // must get one more iteration regardless of retryCount/maxRetries. truncationRetryUsed guarantees
    // that bonus is spent at most once, so this remains a bounded, terminating loop.
    for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
      // Cast (not a bare `= undefined`): TS's control-flow narrowing otherwise fixes this variable's
      // type to the literal `undefined` at this assignment and never widens it back after the
      // errorHandler closure below reassigns it mid-attempt (a call boundary TS's CFA does not model
      // for captured `let`s) — `.at()` below would then be type-checked against `never`, not the
      // real union type.
      lastInvalidOutputResponses = undefined as RawTruncationResponse[] | undefined;
      try {
        // T12.22 — the timeout has to CANCEL, not just stop waiting.
        //
        // This raced `runOnce` against a timer and rejected with model_timeout, while `signal` came
        // from context.signal — which the executor never supplies (executionContext.signal is
        // optional and no caller sets it), so it was always undefined. The rejection returned
        // control to this loop but left the underlying model request outstanding: nothing tore down
        // the socket, the process stayed occupied, and on a large enough payload it never reached
        // `delete state.dispatch` — leaving the orphaned dispatch claim that the reclaim loop then
        // recycled every ~270s. Bounding the prompt above removes the usual cause; this removes the
        // consequence, for every cause.
        //
        // The controller is PER ATTEMPT. A node-scoped one would stay aborted after the first
        // timeout and make every retry fail instantly with `cancelled` — the retry budget would
        // exist on paper only. An external context.signal (real operator cancellation) is forwarded
        // into the same controller so both paths abort exactly one in-flight call.
        const attemptAbort = new AbortController();
        const forwardExternalAbort = () => attemptAbort.abort();
        if (context.signal) {
          if (context.signal.aborted) attemptAbort.abort();
          else context.signal.addEventListener("abort", forwardExternalAbort, { once: true });
        }
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const runOnce = run(agent, prompt, {
          maxTurns, signal: attemptAbort.signal as any,
          tracingDisabled: !tracingEnabled, traceIncludeSensitiveData: false,
          // Detection-only tap (see the truncation retry comment above the loop): the SDK calls this
          // BEFORE throwing its "Invalid output type" ModelBehaviorError, handing over the raw
          // response the thrown error itself does not carry. Returning undefined declines to
          // override the SDK's own behavior — it still throws exactly as it would with no handler
          // configured at all; this only lets the catch block below see WHY.
          errorHandlers: { invalidFinalOutput: ({ runData }: any) => { lastInvalidOutputResponses = runData?.rawResponses; return undefined; } },
          ...(tracingEnabled ? { workflowName: context.run.workflowId, traceMetadata: tracingMetadataFor(attempt) } : {})
        } as any);
        let result: any;
        try {
          result = await Promise.race([
            runOnce,
            new Promise((_, rej) => {
              timeoutHandle = setTimeout(() => {
                // Abort FIRST so the request is actually torn down, then reject. Rejecting alone is
                // what left the call in flight.
                attemptAbort.abort();
                rej(new Error("model_timeout"));
              }, timeoutMs);
            })
          ]);
        } finally {
          // An un-cleared timer holds the event loop open for the rest of the timeout on every
          // successful call — the same class of leak, just quieter.
          if (timeoutHandle) clearTimeout(timeoutHandle);
          context.signal?.removeEventListener("abort", forwardExternalAbort);
          // The losing promise must not surface as an unhandled rejection once the race is settled.
          void Promise.resolve(runOnce).catch(() => undefined);
        }
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
        return { ok: true, output: validated.value, usage: { ...usageFields, actual: true }, model, trace: { responseId: result.lastResponseId, toolCount: effective.length }, toolCalls, outputValidated: true };
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
            operatorAction: operatorActionForBudgetExceeded(details.budgetUsd, details.spentUsdEstimate),
            toolCalls
          };
        }
        // Provider-error-details (2026-08-29 incident): the openai SDK's APIError (status + the
        // response body's unwrapped `error` object) propagates straight through the Agents SDK's own
        // retry wrapper unmodified once it declines to retry (agents-core's getResponseWithRetry
        // re-throws the exact error `model.getResponse` threw) — so it is still THIS error, not some
        // SDK-repackaged shape, when it reaches this catch. A 429 must never fall into budget_exceeded
        // (that code is reserved for OUR OWN guard above) or the opaque model_error bucket below —
        // classify it by what the provider actually said.
        const providerStatus = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
        if (providerStatus !== undefined) {
          const providerBody = (error as { error?: unknown }).error as { message?: unknown } | undefined;
          const classified = classifyProviderHttpError(providerStatus, `${msg} ${JSON.stringify(providerBody ?? {})}`);
          if (classified) {
            const providerMessage = truncateProviderMessage(typeof providerBody?.message === "string" && providerBody.message.trim() ? providerBody.message.trim() : msg);
            await recordAccruedUsage(classified, attempt);
            return {
              ok: false,
              code: classified,
              message: `Node "${node.id}" received ${providerStatus} from ${provider.label}: ${providerMessage}`,
              providerStatus,
              providerMessage,
              operatorAction: operatorActionForProviderHttpError(classified, provider.label, `workflow.retry_node ${node.id}`),
              toolCalls
            };
          }
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
        // W12 truncation classification. Only reachable when the invalidFinalOutput errorHandler
        // actually fired for THIS attempt (lastInvalidOutputResponses set) — already narrows this to
        // "the SDK rejected the model's final output", not any other failure shape.
        const lastRawResponse = lastInvalidOutputResponses?.at(-1);
        if (lastRawResponse) {
          const capUsedThisAttempt = numberFrom(settings.maxTokens);
          const observedOutputTokens = numberFrom(lastRawResponse.usage?.outputTokens);
          const providerTruncated = providerSignalsTruncation(lastRawResponse);
          const fallbackTruncated = !providerTruncated && JSON_TRUNCATION_SHAPE.test(msg) &&
            capUsedThisAttempt !== undefined && observedOutputTokens !== undefined &&
            observedOutputTokens >= capUsedThisAttempt * NEAR_CAP_TRUNCATION_RATIO;
          if (providerTruncated || fallbackTruncated) {
            const ceiling = maxOutputTokensCeiling();
            const doubledCap = capUsedThisAttempt !== undefined ? Math.min(capUsedThisAttempt * 2, ceiling) : undefined;
            const canRetryWithDoubledCap = !truncationRetryUsed && capUsedThisAttempt !== undefined &&
              doubledCap !== undefined && doubledCap > capUsedThisAttempt;
            if (canRetryWithDoubledCap) {
              truncationRetryUsed = true;
              settings.maxTokens = doubledCap;
              if (budgetGuardEngaged) budgetGuardConfig.maxOutputTokens = doubledCap as number;
              continue;
            }
            const signal = providerTruncated ? "the provider reported the response was cut off at its output-token limit" : `its output (~${observedOutputTokens} tokens) was at or near the ${capUsedThisAttempt}-token cap sent`;
            const remedy = capUsedThisAttempt === undefined
              ? `Set modelConfig.maxOutputTokens for this node (no cap was configured, so there is nothing this retry could raise) and retry via workflow_retry_node.`
              : truncationRetryUsed
                ? `This dispatch already retried once at double the cap (${capUsedThisAttempt} tokens) and was still truncated. Raise modelConfig.maxOutputTokens above ${capUsedThisAttempt} for this node and retry via workflow_retry_node.`
                : `Raise modelConfig.maxOutputTokens above ${capUsedThisAttempt} for this node — it is already at or above this runner's ${ceiling}-token retry ceiling, so no automatic retry was attempted — and retry via workflow_retry_node.`;
            const details = {
              nodeId: node.id,
              attempt: attempt + 1,
              initialMaxOutputTokens,
              cap: capUsedThisAttempt,
              outputTokens: observedOutputTokens,
              retriedAtDoubledCap: truncationRetryUsed,
              providerSignal: providerTruncated
            };
            // Requirement: node.list_executions/node_get must show WHY — attempt, cap used, output
            // tokens — not just the generic model_error bucket. `details` above lands on the failed
            // node's execution state (executor.ts: state.output.error.details); this puts the SAME
            // figures on the usage ledger too, alongside the real token spend that attempt cost.
            await recordAccruedUsage("truncated", attempt, { cap: capUsedThisAttempt, initialMaxOutputTokens, outputTokens: observedOutputTokens, retriedAtDoubledCap: truncationRetryUsed, providerSignal: providerTruncated });
            return {
              ok: false,
              code: "truncated",
              message: `Node "${node.id}" produced structured output truncated at its output-token cap (attempt ${attempt + 1}): ${signal}. ${remedy}`,
              details,
              toolCalls
            };
          }
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
