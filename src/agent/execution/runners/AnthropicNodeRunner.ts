// Native Anthropic runner (docs/platform/DIRECTION.md Phase 6). Claude nodes previously had to run
// through the `openai_compatible` provider pointed at a gateway; this adds a first-class path that
// speaks the Anthropic Messages API directly, with schema-enforced structured output. It lets a node —
// or, crucially, a rubric's LLM-as-judge — run natively on Claude, enabling cross-family judging (a
// Claude judge grading an OpenAI generator, the recommended setup).
//
// Schema-enforced output uses the Messages API's forced-tool idiom: a single `emit_output` tool whose
// input_schema IS the node's outputSchema, with tool_choice pinned to it, so the model must return a
// tool_use block whose input matches the schema. No @anthropic-ai/sdk dependency — the request is a
// plain fetch, and fetchImpl is injectable so tests never hit the network. Sampling params
// (temperature/top_p) are intentionally omitted: the current Claude models reject them.
//
// Scope: this runner covers schema-constrained generation (judges, the reflector/curator synthetic
// nodes, and tool-less conductor nodes). Bridging CMS-Agent's controlled tools into the Messages API
// tool loop for tool-using conductor nodes is a tracked follow-up; such a node runs here without tool
// access, so keep tool-using nodes on the OpenAI runner until that lands.
import { recordModelUsage } from "../../observability/modelUsage.js";
import { renderPlaybookForPrompt } from "../../improvement/playbook.js";
import { repositoryManager } from "../../runtime/repositories.js";
import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import type { ExecutionMode, NodeRunnerContext } from "../executionContext.js";
import { validateOutput } from "../outputValidator.js";
import type { NodeRunner, NodeRunnerInput, NodeRunnerResult } from "./NodeRunner.js";
import { readRunContext, renderRunContextInstruction } from "../../workspace/runContext.js";
import { boundDependencyOutput, dependencyOutputMaxChars } from "./OpenAINodeRunner.js";
import { classifyProviderHttpError, operatorActionForProviderHttpError, truncateProviderMessage } from "./providerHttpErrors.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

// W12 truncation retry (see OpenAINodeRunner.ts's matching header comment for the incident and the
// full detection rationale). Ceiling on how far the truncation retry may double this node's
// configured max_tokens; override per deployment via ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING if a
// model's real ceiling differs.
export const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING = 64000;
export const anthropicMaxOutputTokensCeiling = (): number => {
  const configured = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING;
};
// Same ratio and rationale as OpenAINodeRunner's NEAR_CAP_TRUNCATION_RATIO: the fallback signal
// (no emit_output tool call — see below) only counts as truncation evidence when the response
// actually spent close to the cap it was given.
const NEAR_CAP_TRUNCATION_RATIO = 0.9;

const forbidden = /api[_-]?key|authorization|bearer|jwt|cookie|token|secret|blob.*credential/i;
const redact = (value: unknown): unknown => typeof value === "string" ? value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]") : Array.isArray(value) ? value.map(redact) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, forbidden.test(key) ? "[REDACTED]" : redact(val)])) : value;
const numberFrom = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const stringFrom = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const cfg = (node: WorkspaceNode) => ({ ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) });
const apiKeyEnv = (node: WorkspaceNode) => stringFrom(cfg(node).apiKeyEnv) ?? "ANTHROPIC_API_KEY";

const instructions = (node: WorkspaceNode, playbookText: string, input?: unknown): string => [
  "You are the CMS-Agent node runner running natively on Claude.",
  `Node: ${node.name} (${node.id})`,
  `Description: ${node.description}`,
  // W3 part 3 (determinism program, 2026-08-12): parity with the OpenAI runner — the run's client
  // facts stated once by the conductor, so a node on either provider works from the same delivered
  // context instead of echoing a dependency's envelope. Absent when the input carries no runContext.
  renderRunContextInstruction(readRunContext(input)),
  "Node prompt:", node.prompt,
  playbookText ? `Playbook (curated lessons for this node):\n${playbookText}` : "",
  "Assigned dependencies and memory are provided in the user message. Never reveal secrets.",
  "Return your result by calling the emit_output tool exactly once with a value matching its schema."
].filter(Boolean).join("\n");

type AnthropicMessagesResponse = { id?: string; stop_reason?: string; content?: Array<{ type: string; name?: string; input?: unknown }>; usage?: { input_tokens?: number; output_tokens?: number } };

export class AnthropicNodeRunner implements NodeRunner {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  // Selected by PROVIDER (modelConfig.provider === "anthropic") in the runner registry, never by
  // ExecutionMode, so it does not claim any mode — mode-based lookup keeps returning the OpenAI runner.
  supports(_mode: ExecutionMode): boolean { return false; }

  validateConfiguration(node: WorkspaceNode) {
    const errors: string[] = [];
    if (!node.outputSchema) errors.push("outputSchema is required.");
    if (!process.env[apiKeyEnv(node)]) errors.push(`${apiKeyEnv(node)} is required for anthropic execution.`);
    // This runner has no tool loop (see the header): a tool-using node would run WITHOUT its granted
    // tools — for article_body/artifact_plan/publish_payload that silently strips the client
    // validation their prompts mandate. A provider switch on such a node must fail by name at
    // configuration time, not degrade at run time.
    const grantedTools = node.allowedTools ?? [];
    if (grantedTools.length > 0) {
      errors.push(`provider=anthropic cannot execute tool-using nodes yet: the Messages-API tool loop is not implemented, and node "${node.id}" grants ${grantedTools.length} tool(s) (${grantedTools.join(", ")}) that would be silently stripped. Keep tool-using nodes on the OpenAI runner until the Anthropic tool loop lands.`);
    }
    return errors.length ? { ok: false as const, errors } : { ok: true as const };
  }

  async run({ node, input }: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult> {
    const valid = this.validateConfiguration(node);
    if (!valid.ok) return { ok: false, code: "invalid_node_configuration", message: valid.errors.join("; ") };
    const c = cfg(node);
    const model = stringFrom(c.model) ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const baseURL = (process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const apiKey = process.env[apiKeyEnv(node)]!;

    const playbook = await repositoryManager.getImprovementRepository().getPlaybook(node.id).catch(() => undefined);
    const playbookText = playbook ? renderPlaybookForPrompt(playbook) : "";
    const userContent = JSON.stringify(redact({
      input,
      // T12.22 fleet parity: the OpenAI runner bounds these; an unbounded confluence payload hangs
      // the same way on either provider, so the same bound applies here rather than waiting for
      // the second incident to prove it.
      dependencyOutputs: Object.fromEntries(node.dependsOn.map((dependency) => [dependency, boundDependencyOutput(context.run.stageOutputs[dependency] ?? context.suppliedDependencies?.[dependency], dependencyOutputMaxChars())])),
      ...(playbookText ? { playbook: playbookText } : {}),
      outputSchema: node.outputSchema
    }));
    const body = {
      model,
      max_tokens: numberFrom(c.maxOutputTokens) ?? 4096,
      system: instructions(node, playbookText, input),
      messages: [{ role: "user", content: userContent }],
      tools: [{ name: "emit_output", description: "Emit this node's structured output. Call exactly once with the full result matching the schema.", input_schema: node.outputSchema as Record<string, unknown> }],
      tool_choice: { type: "tool", name: "emit_output" }
    };
    // F5 (T-2, run_1785352838155_l544ye): matches the OpenAI runner's default bump — 60s proved too
    // tight for at least one real generation node (draft_writer, on the OpenAI path); raised here too
    // for parity in case a node's provider is switched to anthropic.
    const timeoutMs = numberFrom(c.timeout) ?? 120000;
    const maxRetries = Math.max(0, Math.floor(numberFrom(c.retryCount) ?? 0));
    // W12 — tracked outside the loop for the same reason as OpenAINodeRunner: the truncation retry is
    // ONE bonus attempt at double the cap, granted independently of maxRetries/retryCount, and
    // `initialMaxOutputTokens` preserves the node's ORIGINAL configured cap for the failure message
    // even after body.max_tokens has been doubled.
    const initialMaxOutputTokens = body.max_tokens;
    let truncationRetryUsed = false;

    // The loop's normal bound is attempt<=maxRetries, exactly as before; +1 accommodates the single
    // bonus truncation retry (see OpenAINodeRunner.ts's identical widened bound for the termination
    // proof — this loop has the same shape: every branch either returns or bounds its own continue by
    // maxRetries, except the new truncation branch, which bounds itself by truncationRetryUsed).
    for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImpl(`${baseURL}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
          body: JSON.stringify(body),
          signal: context.signal ?? controller.signal
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          if (attempt < maxRetries && response.status >= 500) continue;
          // Provider-error-details (2026-08-29 incident): a 429 must never fall into the opaque
          // model_error bucket below (or, worse, our own budget_exceeded — reserved for OUR usd
          // budget guard) without saying WHY, so the operator does not lose an hour hunting a code
          // bug that is actually an empty provider wallet.
          const classified = classifyProviderHttpError(response.status, detail);
          if (classified) {
            const parsedBody = (() => { try { return JSON.parse(detail) as { error?: { message?: unknown } }; } catch { return undefined; } })();
            const rawMessage = parsedBody?.error?.message;
            const providerMessage = truncateProviderMessage(typeof rawMessage === "string" && rawMessage.trim() ? rawMessage.trim() : detail);
            return {
              ok: false,
              code: classified,
              message: `Node "${node.id}" received ${response.status} from anthropic: ${providerMessage}`,
              providerStatus: response.status,
              providerMessage,
              operatorAction: operatorActionForProviderHttpError(classified, "anthropic", `workflow.retry_node ${node.id}`)
            };
          }
          return { ok: false, code: "model_error", message: `anthropic_http_${response.status}: ${detail.slice(0, 300)}`, retryable: response.status >= 500 || response.status === 429 };
        }
        const data = await response.json() as AnthropicMessagesResponse;
        if (data.stop_reason === "refusal") return { ok: false, code: "model_error", message: "anthropic_refusal: the request was declined by the model's safety classifiers." };

        // W12 truncation classification. PRIMARY signal: the Messages API's own stop_reason — "the
        // request must be prefilled with a maximally verbose completion" is never why stop_reason is
        // "max_tokens"; that value means exactly one thing, hitting the token cap mid-generation, so
        // it is checked regardless of whether a tool_use block happened to come back at all.
        // FALLBACK: unlike the OpenAI Responses/Chat Completions APIs, Anthropic parses tool arguments
        // server-side, so a cutoff here does not surface as a client-side JSON.parse failure — the
        // nearest equivalent evidence is "no emit_output call came back AND the response spent
        // near-cap output tokens getting there" (the same near-cap safety gate as the OpenAI runner's
        // parse-failure fallback, applied to the closest signal this API actually exposes).
        const toolUse = (data.content ?? []).find((block) => block.type === "tool_use" && block.name === "emit_output");
        const observedOutputTokens = numberFrom(data.usage?.output_tokens);
        const providerTruncated = data.stop_reason === "max_tokens";
        const capUsedThisAttempt = body.max_tokens;
        const fallbackTruncated = !providerTruncated && !toolUse &&
          observedOutputTokens !== undefined && observedOutputTokens >= capUsedThisAttempt * NEAR_CAP_TRUNCATION_RATIO;
        if (providerTruncated || fallbackTruncated) {
          const ceiling = anthropicMaxOutputTokensCeiling();
          const doubledCap = Math.min(capUsedThisAttempt * 2, ceiling);
          if (!truncationRetryUsed && doubledCap > capUsedThisAttempt) {
            truncationRetryUsed = true;
            body.max_tokens = doubledCap;
            continue;
          }
          const signal = providerTruncated
            ? "the provider reported stop_reason=max_tokens"
            : `no emit_output call was returned and its output (~${observedOutputTokens} tokens) was at or near the ${capUsedThisAttempt}-token cap sent`;
          const remedy = truncationRetryUsed
            ? `This dispatch already retried once at double the cap (${capUsedThisAttempt} tokens) and was still truncated. Raise modelConfig.maxOutputTokens above ${capUsedThisAttempt} for this node and retry via workflow_retry_node.`
            : `Raise modelConfig.maxOutputTokens above ${capUsedThisAttempt} for this node — it is already at or above this runner's ${ceiling}-token retry ceiling, so no automatic retry was attempted — and retry via workflow_retry_node.`;
          const details = { nodeId: node.id, attempt: attempt + 1, initialMaxOutputTokens, cap: capUsedThisAttempt, outputTokens: observedOutputTokens, retriedAtDoubledCap: truncationRetryUsed, providerSignal: providerTruncated };
          const inputTokensSoFar = data.usage?.input_tokens ?? 0;
          const outputTokensSoFar = data.usage?.output_tokens ?? 0;
          if (inputTokensSoFar > 0 || outputTokensSoFar > 0) {
            await recordModelUsage({ runId: context.run.runId, requestId: context.run.requestId, workflowId: context.run.workflowId, projectId: context.run.projectId, nodeId: node.id, model, provider: "anthropic", inputTokens: inputTokensSoFar, outputTokens: outputTokensSoFar, totalTokens: inputTokensSoFar + outputTokensSoFar, status: "actual", metadata: { executionMode: "anthropic", partial: true, failureCode: "truncated", attempt: attempt + 1, cap: capUsedThisAttempt, initialMaxOutputTokens, retriedAtDoubledCap: truncationRetryUsed, providerSignal: providerTruncated } }).catch(() => undefined);
          }
          return {
            ok: false,
            code: "truncated",
            message: `Node "${node.id}" produced structured output truncated at its output-token cap (attempt ${attempt + 1}): ${signal}. ${remedy}`,
            details
          };
        }

        if (!toolUse) {
          if (attempt < maxRetries) continue;
          return { ok: false, code: "output_validation_failed", message: "Anthropic response contained no emit_output tool call." };
        }
        const validated = validateOutput(toolUse.input, node.outputSchema);
        if (!validated.ok) {
          if (attempt < maxRetries) continue;
          return { ok: false, code: "output_validation_failed", message: "Anthropic output did not match node.outputSchema.", details: validated.errors };
        }
        const inputTokens = data.usage?.input_tokens ?? 0;
        const outputTokens = data.usage?.output_tokens ?? 0;
        const usageFields = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
        await recordModelUsage({ runId: context.run.runId, requestId: context.run.requestId, workflowId: context.run.workflowId, projectId: context.run.projectId, nodeId: node.id, model, provider: "anthropic", ...usageFields, status: "actual", metadata: { executionMode: "anthropic" } }).catch(() => undefined);
        // outputValidated: true — see NodeRunner.ts and executor.ts's executeRunnableNode: this runner
        // already validated `output` against `node.outputSchema` immediately above (to decide whether
        // to retry), so the executor's own generic output-schema gate can skip re-running the identical
        // check against the identical (output, schema) pair.
        return { ok: true, output: validated.value, usage: { ...usageFields, actual: true }, model, trace: { responseId: data.id, provider: "anthropic" }, outputValidated: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (context.signal?.aborted) return { ok: false, code: "cancelled", message: "Anthropic node execution was cancelled." };
        if (/abort/i.test(message)) return { ok: false, code: "model_timeout", message: "Anthropic node execution timed out." };
        if (attempt >= maxRetries) return { ok: false, code: "model_error", message };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, code: "model_error", message: "Anthropic node execution failed." };
  }
}
