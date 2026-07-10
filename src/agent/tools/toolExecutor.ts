import { ZodError } from "zod";
import { repositoryManager } from "../runtime/repositories.js";
import { evaluateToolPolicy } from "./toolPolicy.js";
import { getTool, resolvePolicySubjects } from "./toolResolver.js";
import type { ToolExecutionContext, ToolExecutionRecord } from "./toolTypes.js";

const records = new Map<string, ToolExecutionRecord>();
const now = () => new Date().toISOString();
const makeId = () => `tool_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const redact = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]").slice(0, 500);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(redact);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([k, v]) => [/authorization|token|secret|api[_-]?key|password/i.test(k) ? [k, "[REDACTED]"] : [k, redact(v)]]));
};
const summarize = (value: unknown) => redact(value);

export function getToolExecution(toolExecutionId: string) { return records.get(toolExecutionId); }
export function listToolExecutions(filters: { runId?: string; nodeId?: string; toolId?: string } = {}) { return [...records.values()].filter((r) => (!filters.runId || r.runId === filters.runId) && (!filters.nodeId || r.nodeId === filters.nodeId) && (!filters.toolId || r.toolId === filters.toolId)); }

export async function executeTool(toolId: string, input: unknown, context: ToolExecutionContext) {
  const tool = getTool(toolId);
  if (!tool) return { ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${toolId}` } };
  const startedAt = now();
  const toolExecutionId = makeId();
  const base = { toolExecutionId, runId: context.runId, nodeId: context.nodeId, toolId: tool.toolId, startedAt, inputSummary: summarize(input), riskLevel: tool.riskLevel };
  const finish = (record: ToolExecutionRecord) => { records.set(toolExecutionId, record); return record; };
  try {
    const { node, skill } = await resolvePolicySubjects(context.nodeId, context.skillId);
    const project = context.projectId ? await repositoryManager.getProjectRepository().get(context.projectId) : undefined;
    const policy = evaluateToolPolicy({ tool, context, node, skill, project });
    if (!policy.allowed) {
      const completedAt = now();
      const record = finish({ ...base, completedAt, durationMs: Date.parse(completedAt)-Date.parse(startedAt), status: "denied", errorCode: policy.code, approvalStatus: "missing" });
      return { ok: false, denied: { code: policy.code, reasons: policy.reasons }, toolExecutionId: record.toolExecutionId };
    }
    const parsed = tool.inputSchema.parse(input);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("tool_timeout")), tool.timeoutMs));
    const output = await Promise.race([Promise.resolve(tool.handler(parsed, context)), timeout]);
    const checked = tool.outputSchema.parse(output);
    const completedAt = now();
    const record = finish({ ...base, completedAt, durationMs: Date.parse(completedAt)-Date.parse(startedAt), status: "success", outputSummary: summarize(checked), riskLevel: tool.riskLevel, approvalStatus: policy.approvalStatus });
    return { ok: true, toolExecutionId: record.toolExecutionId, output: checked };
  } catch (error) {
    const completedAt = now();
    const code = error instanceof ZodError ? "validation_error" : error instanceof Error && error.message === "tool_timeout" ? "tool_timeout" : "tool_error";
    const record = finish({ ...base, completedAt, durationMs: Date.parse(completedAt)-Date.parse(startedAt), status: code === "tool_timeout" ? "timeout" : "error", errorCode: code, riskLevel: tool.riskLevel, approvalStatus: tool.requiresApproval ? (context.approvedToolIds?.includes(tool.toolId) ? "approved" : "missing") : "not_required" });
    return { ok: false, toolExecutionId: record.toolExecutionId, error: { code, message: code === "tool_error" && error instanceof Error ? error.message : code } };
  }
}
