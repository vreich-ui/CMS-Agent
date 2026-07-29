import { ZodError, type ZodIssue } from "zod";
import { repositoryManager } from "../runtime/repositories.js";
import { evaluateToolPolicy } from "./toolPolicy.js";
import { getTool, resolvePolicySubjects } from "./toolResolver.js";
import { coerceJsonObjectInput } from "./jsonCoercion.js";
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

const pathAt = (value: unknown, path: ZodIssue["path"]): unknown => {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key as PropertyKey];
  }
  return current;
};

// T-2 (run_1785340011864_qpyjr0): a controlled-tool validation failure surfaced as the bare string
// "validation_error" in both code and message, with no field path, expected shape, or received shape.
// The model had nothing to self-correct on and burned its whole turn budget retrying blind. Zod
// already carries a field path and a readable expected/received sentence per issue; this reformats
// that into one line per issue (redacting anything secret-looking from the received value) so a
// single failed call is actionable instead of a multi-turn guessing loop.
function describeValidationError(error: ZodError, input: unknown): { message: string; issues: Array<{ path: string; message: string; expected?: string; received?: unknown }> } {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    const expected = (issue as { expected?: string }).expected;
    const received = pathAt(input, issue.path);
    return { path, message: issue.message, ...(expected ? { expected } : {}), ...(received !== undefined ? { received: redact(received) } : {}) };
  });
  return { message: issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "), issues };
}

export function getToolExecution(toolExecutionId: string) { return records.get(toolExecutionId); }
export function listToolExecutions(filters: { runId?: string; nodeId?: string; toolId?: string } = {}) { return [...records.values()].filter((r) => (!filters.runId || r.runId === filters.runId) && (!filters.nodeId || r.nodeId === filters.nodeId) && (!filters.toolId || r.toolId === filters.toolId)); }

export async function executeTool(toolId: string, rawInput: unknown, context: ToolExecutionContext) {
  const tool = getTool(toolId);
  if (!tool) return { ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${toolId}` } };
  // B1 (T-2): some callers — tool.test's untyped `input` field chief among them — forward a
  // JSON-stringified object instead of the parsed object every controlled tool's inputSchema
  // expects. Coerce once, here, at the single execution gateway, so every caller (tool.test, the
  // live node runners) is defended the same way instead of each needing its own fix.
  const input = coerceJsonObjectInput(rawInput);
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
    const validation = error instanceof ZodError ? describeValidationError(error, input) : undefined;
    const record = finish({ ...base, completedAt, durationMs: Date.parse(completedAt)-Date.parse(startedAt), status: code === "tool_timeout" ? "timeout" : "error", errorCode: code, riskLevel: tool.riskLevel, approvalStatus: tool.requiresApproval ? (context.approvedToolIds?.includes(tool.toolId) ? "approved" : "missing") : "not_required" });
    const message = validation ? validation.message : code === "tool_error" && error instanceof Error ? error.message : code;
    return { ok: false, toolExecutionId: record.toolExecutionId, error: { code, message, ...(validation ? { issues: validation.issues } : {}) } };
  }
}
