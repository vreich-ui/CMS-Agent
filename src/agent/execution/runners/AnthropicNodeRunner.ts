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

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

const forbidden = /api[_-]?key|authorization|bearer|jwt|cookie|token|secret|blob.*credential/i;
const redact = (value: unknown): unknown => typeof value === "string" ? value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]") : Array.isArray(value) ? value.map(redact) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, forbidden.test(key) ? "[REDACTED]" : redact(val)])) : value;
const numberFrom = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const stringFrom = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const cfg = (node: WorkspaceNode) => ({ ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) });
const apiKeyEnv = (node: WorkspaceNode) => stringFrom(cfg(node).apiKeyEnv) ?? "ANTHROPIC_API_KEY";

const instructions = (node: WorkspaceNode, playbookText: string): string => [
  "You are the CMS-Agent node runner running natively on Claude.",
  `Node: ${node.name} (${node.id})`,
  `Description: ${node.description}`,
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
      dependencyOutputs: Object.fromEntries(node.dependsOn.map((dependency) => [dependency, context.run.stageOutputs[dependency] ?? context.suppliedDependencies?.[dependency]])),
      ...(playbookText ? { playbook: playbookText } : {}),
      outputSchema: node.outputSchema
    }));
    const body = {
      model,
      max_tokens: numberFrom(c.maxOutputTokens) ?? 4096,
      system: instructions(node, playbookText),
      messages: [{ role: "user", content: userContent }],
      tools: [{ name: "emit_output", description: "Emit this node's structured output. Call exactly once with the full result matching the schema.", input_schema: node.outputSchema as Record<string, unknown> }],
      tool_choice: { type: "tool", name: "emit_output" }
    };
    const timeoutMs = numberFrom(c.timeout) ?? 60000;
    const maxRetries = Math.max(0, Math.floor(numberFrom(c.retryCount) ?? 0));

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
          return { ok: false, code: "model_error", message: `anthropic_http_${response.status}: ${detail.slice(0, 300)}`, retryable: response.status >= 500 || response.status === 429 };
        }
        const data = await response.json() as AnthropicMessagesResponse;
        if (data.stop_reason === "refusal") return { ok: false, code: "model_error", message: "anthropic_refusal: the request was declined by the model's safety classifiers." };
        const toolUse = (data.content ?? []).find((block) => block.type === "tool_use" && block.name === "emit_output");
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
        await recordModelUsage({ runId: context.run.runId, workflowId: context.run.workflowId, projectId: context.run.projectId, nodeId: node.id, model, provider: "anthropic", ...usageFields, status: "actual", metadata: { executionMode: "anthropic" } }).catch(() => undefined);
        return { ok: true, output: validated.value, usage: { ...usageFields, actual: true }, trace: { responseId: data.id, provider: "anthropic" } };
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
