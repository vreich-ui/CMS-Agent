import { z } from "zod";
import { workspaceRiskLevels } from "../workspace/nodeTypes.js";
import { validateJsonSchema } from "../mcp/workspace/store.js";
import { skillStatuses, type SkillDefinition, type SkillValidationResult } from "./skillTypes.js";

const stringArray = z.array(z.string().min(1)).default([]);
export const skillDefinitionSchema = z.object({
  skillId: z.string().min(1), name: z.string().min(1), description: z.string().min(1), version: z.string().min(1), status: z.enum(skillStatuses), instructions: z.string().min(1),
  inputSchema: z.unknown(), outputSchema: z.unknown(), allowedTools: stringArray, requiredArtifacts: stringArray, producedArtifacts: stringArray,
  examples: z.array(z.object({ name: z.string().min(1), input: z.unknown(), output: z.unknown(), notes: z.string().optional() }).strict()).min(1),
  preconditions: stringArray, completionCriteria: stringArray, blockerCriteria: stringArray,
  memoryPolicy: z.object({ namespaces: stringArray, read: z.boolean(), write: z.boolean(), retention: z.string().optional() }).strict(),
  toolPolicy: z.object({ requestedTools: stringArray, mutatingToolsRequireApproval: z.boolean(), notes: z.string().optional() }).strict(),
  riskLevel: z.enum(workspaceRiskLevels), metadata: z.record(z.string(), z.unknown()), createdAt: z.string().datetime(), updatedAt: z.string().datetime()
}).strict() as z.ZodType<SkillDefinition>;

const validateSimpleExample = (schema: unknown, value: unknown, label: string): string[] => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const typed = schema as { type?: unknown; required?: unknown; properties?: unknown };
  if (typed.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) return [`${label} must be an object.`];
  const required = Array.isArray(typed.required) ? typed.required.filter((item): item is string => typeof item === "string") : [];
  if (required.length && value && typeof value === "object" && !Array.isArray(value)) return required.filter((field) => !(field in value)).map((field) => `${label} missing required field: ${field}`);
  return [];
};

export function validateSkillDefinition(candidate: unknown): SkillValidationResult {
  const parsed = skillDefinitionSchema.safeParse(candidate);
  if (!parsed.success) return { valid: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "skill"}: ${issue.message}`) };
  const skill = parsed.data;
  const issues = [...validateJsonSchema(skill.inputSchema).map((issue) => `inputSchema: ${issue}`), ...validateJsonSchema(skill.outputSchema).map((issue) => `outputSchema: ${issue}`)];
  for (const example of skill.examples) issues.push(...validateSimpleExample(skill.inputSchema, example.input, `example ${example.name} input`), ...validateSimpleExample(skill.outputSchema, example.output, `example ${example.name} output`));
  for (const requested of skill.toolPolicy.requestedTools) if (!skill.allowedTools.includes(requested)) issues.push(`toolPolicy requested tool is not listed in allowedTools: ${requested}`);
  return { valid: issues.length === 0, issues };
}

export const assertValidSkill = (skill: SkillDefinition) => { const result = validateSkillDefinition(skill); if (!result.valid) throw new Error(result.issues.join("; ")); return skillDefinitionSchema.parse(skill); };
