import { z } from "zod";
import { articleBodySchema } from "../mcp/workspace/store.js";
import { toConnectionState } from "./projectMcpAdapter.js";
import type { ProjectConnectionConfig, ProjectSummary } from "./projectTypes.js";

// Structural schema for the content_source.v1 handoff envelope (mirrors the input_triage node output).
const contentSourceV1Schema = z.object({
  artifact: z.literal("content_source.v1"),
  summary: z.string().min(1),
  notes: z.array(z.string()).optional()
}).passthrough();

// Safe, caller-facing project view. Never includes the resolved endpoint value or token — only the
// env var names and whether they are populated.
export function toProjectSummary(config: ProjectConnectionConfig, env: NodeJS.ProcessEnv = process.env): ProjectSummary {
  return {
    projectId: config.projectId,
    name: config.name,
    authMode: config.authMode,
    allowedTools: [...config.allowedTools],
    contentContract: { ...config.contentContract },
    publishingPolicy: { ...config.publishingPolicy },
    status: config.status,
    connection: toConnectionState(config, env)
  };
}

type StructureCheck = { present: boolean; valid: boolean; contract: string; issues: z.ZodIssue[] };

const checkStructure = (present: boolean, contract: string, schema: z.ZodTypeAny | null, value: unknown): StructureCheck => {
  if (!present) return { present: false, valid: false, contract, issues: [] };
  if (!schema) return { present: true, valid: false, contract, issues: [{ code: "custom", path: [], message: `Unsupported contract: ${contract}` } as z.ZodIssue] };
  const parsed = schema.safeParse(value);
  return { present: true, valid: parsed.success, contract, issues: parsed.success ? [] : parsed.error.issues };
};

export type HandoffValidation = {
  valid: boolean;
  projectId: string;
  contract: { contentContract: string; canonicalArticleBody: string };
  checks: { contentSource: StructureCheck; articleBody: StructureCheck };
  issues: string[];
};

// Validate a handoff payload's structure against the project's declared content contract
// (content_source.v1) and canonical article body (article_body.v1). This is a local, read-only,
// dry structural check — it performs no network calls and no publishing side effects.
export function validateHandoff(config: ProjectConnectionConfig, payload: { contentSource?: unknown; articleBody?: unknown }): HandoffValidation {
  const { contentContract, canonicalArticleBody } = config.contentContract;
  const contentSourceSchema = contentContract === "content_source.v1" ? contentSourceV1Schema : null;
  const articleBodyContractSchema = canonicalArticleBody === "article_body.v1" ? (articleBodySchema as unknown as z.ZodTypeAny) : null;

  const contentSourcePresent = payload.contentSource !== undefined;
  const articleBodyPresent = payload.articleBody !== undefined;

  const contentSource = checkStructure(contentSourcePresent, contentContract, contentSourceSchema, payload.contentSource);
  const articleBody = checkStructure(articleBodyPresent, canonicalArticleBody, articleBodyContractSchema, payload.articleBody);

  const issues: string[] = [];
  if (!contentSourcePresent && !articleBodyPresent) issues.push("Provide contentSource and/or articleBody to validate a handoff.");
  if (contentSource.present && !contentSource.valid) issues.push(`contentSource does not satisfy ${contentContract}.`);
  if (articleBody.present && !articleBody.valid) issues.push(`articleBody does not satisfy ${canonicalArticleBody}.`);

  const valid = issues.length === 0 && (contentSourcePresent || articleBodyPresent);
  return { valid, projectId: config.projectId, contract: { contentContract, canonicalArticleBody }, checks: { contentSource, articleBody }, issues };
}
