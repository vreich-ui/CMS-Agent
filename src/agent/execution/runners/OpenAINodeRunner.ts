import { Agent, run, tool } from "@openai/agents";
import { recordModelUsage, summarizeModelUsage, estimateModelCost } from "../../observability/modelUsage.js";
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
    if ((stringFrom(c.provider) ?? "openai") !== "openai") errors.push("Only provider=openai is supported.");
    if (!node.outputSchema) errors.push("outputSchema is required.");
    if (numberFrom(c.budgetUsd) !== undefined && numberFrom(c.budgetUsd)! < 0) errors.push("budgetUsd must be non-negative.");
    return errors.length ? { ok: false as const, errors } : { ok: true as const };
  }
  async run({ node, input }: NodeRunnerInput, context: NodeRunnerContext): Promise<NodeRunnerResult> {
    if (!process.env.OPENAI_API_KEY) return { ok: false, code: "invalid_node_configuration", message: "OPENAI_API_KEY is required for openai execution." };
    const valid = this.validateConfiguration(node); if (!valid.ok) return { ok: false, code: "invalid_node_configuration", message: valid.errors.join("; ") };
    const c = cfg(node); const budgetUsd = numberFrom(c.budgetUsd);
    if (budgetUsd !== undefined) {
      const spent = await summarizeModelUsage({ runId: context.run.runId });
      const reserve = estimateModelCost({ model: stringFrom(c.model) ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5", inputTokens: 1000, outputTokens: numberFrom(c.maxOutputTokens) ?? 1000 });
      if (spent.totalCostUsdEstimate + reserve > budgetUsd) return { ok: false, code: "budget_exceeded", message: "Estimated node budget would be exceeded.", details: { spentUsdEstimate: spent.totalCostUsdEstimate, reserveUsdEstimate: reserve, budgetUsd } };
    }
    const effective = (await resolveEffectiveToolsForNode(node.id, { runId: context.run.runId, projectId: context.run.projectId, approvedToolIds: context.approvedToolIds, dryRun: context.run.dryRun })).filter((t) => t.allowed);
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
        if (!result.ok) throw new Error(result.denied ? `tool_denied:${result.denied.code}` : `tool_failed:${result.error?.code ?? "tool_failed"}`);
        return redact(result.output);
      }
    }));
    const observations = await repositoryManager.getLearningRepository().listObservations().catch(() => []);
    const { model, settings } = modelSettings(node);
    const outputType = { type: "json_schema" as const, name: `${node.id}_output`, strict: false, schema: node.outputSchema as any };
    const agent = new Agent({ name: `cms_${node.id}`, instructions: instructions(node, input, observations), model, modelSettings: settings, tools: sdkTools, outputType });
    const prompt = JSON.stringify(redact({ input, dependencyOutputs: Object.fromEntries(node.dependsOn.map((d) => [d, context.run.stageOutputs[d] ?? context.suppliedDependencies?.[d]])), observations, outputSchema: node.outputSchema }));
    const timeoutMs = numberFrom(c.timeout) ?? 60000;
    const maxRetries = Math.max(0, Math.floor(numberFrom(c.retryCount) ?? 0));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result: any = await Promise.race([run(agent, prompt, { maxTurns: Math.max(1, Math.floor(numberFrom(c.toolCallLimit) ?? 4)), signal: context.signal as any, tracingDisabled: true, traceIncludeSensitiveData: false } as any), new Promise((_, rej) => setTimeout(() => rej(new Error("model_timeout")), timeoutMs))]);
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
        await recordModelUsage({ runId: context.run.runId, workflowId: context.run.workflowId, projectId: context.run.projectId, nodeId: node.id, model, provider: "openai", ...usageFields, status: "actual", metadata: { executionMode: "openai", traceId: result.lastResponseId } }).catch(() => undefined);
        return { ok: true, output: validated.value, usage: { ...usageFields, actual: true }, trace: { responseId: result.lastResponseId, toolCount: effective.length } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg === "model_timeout") return { ok: false, code: "model_timeout", message: "OpenAI node execution timed out." };
        if (/aborted|cancel/i.test(msg)) return { ok: false, code: "cancelled", message: "OpenAI node execution was cancelled." };
        if (/tool_denied/.test(msg)) return { ok: false, code: "tool_denied", message: msg };
        if (/tool_failed/.test(msg)) return { ok: false, code: "tool_failed", message: msg };
        if (attempt >= maxRetries) return { ok: false, code: "model_error", message: msg };
      }
    }
    return { ok: false, code: "model_error", message: "OpenAI node execution failed." };
  }
}
