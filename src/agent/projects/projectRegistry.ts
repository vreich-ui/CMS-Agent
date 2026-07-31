import { z } from "zod";
import { validateOutput } from "../execution/outputValidator.js";
import { getWorkspaceNode } from "../workspace/nodes.js";
import { toConnectionState } from "./projectMcpAdapter.js";
import { getProjectHooks, type ProjectPolicyFinding } from "./projectHooks.js";
import { toToolPolicyMap, type ProjectConnectionConfig, type ProjectSummary } from "./projectTypes.js";

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
    defaultToolPolicy: config.defaultToolPolicy ?? "blocked",
    toolPolicies: toToolPolicyMap(config),
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

// The article_body node's OWN outputSchema is the authority on a client_object.v1 handoff — the same
// single authority the executor enforces at execution time, buildInitialRun enforces on a seeded
// entrypoint, and the publisher enforces before publishing. This used to parse the workspace-local
// {schema_version, nodes} Zod schema (deleted by R-6 / R-23's delete half), which validated a shape
// the node never emits — so a real pipeline envelope failed here while a legacy body passed. Beyond
// this envelope, the client's own validator (object_validate) is the authority on the body.
//
// The contract NAME is likewise no longer read from project config: the removed canonicalArticleBody
// field was declared identically by every project definition, making it configuration that could only
// ever misconfigure. The article_body node's own `produces` const is the single source.
const canonicalBodyContract = (): string => getWorkspaceNode("article_body")?.produces[0] ?? "client_object.v1";

const checkArticleBodyStructure = (present: boolean, value: unknown): StructureCheck => {
  const canonical = canonicalBodyContract();
  if (!present) return { present: false, valid: false, contract: canonical, issues: [] };
  // Same "Unsupported contract" refusal the removed config field used to trigger, now keyed off the
  // payload itself: an envelope naming any OTHER contract is refused up front with the crisp message
  // instead of an opaque schema mismatch.
  const declared = value && typeof value === "object" ? (value as Record<string, unknown>).artifact : undefined;
  if (typeof declared === "string" && declared !== canonical) return { present: true, valid: false, contract: canonical, issues: [{ code: "custom", path: [], message: `Unsupported contract: ${declared}` } as z.ZodIssue] };
  const result = validateOutput(value, getWorkspaceNode("article_body")?.outputSchema);
  return { present: true, valid: result.ok, contract: canonical, issues: result.ok ? [] : result.errors.map((message) => ({ code: "custom", path: [], message }) as z.ZodIssue) };
};

export type HandoffProjectPolicy = { applied: boolean; findings: ProjectPolicyFinding[] };

export type HandoffValidation = {
  valid: boolean;
  projectId: string;
  // canonicalBodyContract is DERIVED from the article_body node's own produces const, never read from
  // project config — the removed canonicalArticleBody field was declared identically by every
  // definition, so it was configuration that could only ever misconfigure.
  contract: { contentContract: string; canonicalBodyContract: string };
  checks: { contentSource: StructureCheck; articleBody: StructureCheck };
  // Project-specific policy layered via the hook registry (projectHooks.ts). "error" findings mark
  // the handoff invalid; "warning" findings are advisory.
  projectPolicy: HandoffProjectPolicy;
  issues: string[];
};

// Validate a handoff payload's structure against the project's declared content contract
// (content_source.v1) and the canonical body contract (client_object.v1 — the article_body node's own
// output envelope: one client object plus its provenance), then layer the project's own policy hook
// when one is registered. This is a local, read-only, dry check — it performs no network calls and no
// publishing side effects.
export function validateHandoff(config: ProjectConnectionConfig, payload: { contentSource?: unknown; articleBody?: unknown }): HandoffValidation {
  const { contentContract } = config.contentContract;
  const contentSourceSchema = contentContract === "content_source.v1" ? contentSourceV1Schema : null;

  const contentSourcePresent = payload.contentSource !== undefined;
  const articleBodyPresent = payload.articleBody !== undefined;

  const contentSource = checkStructure(contentSourcePresent, contentContract, contentSourceSchema, payload.contentSource);
  const articleBody = checkArticleBodyStructure(articleBodyPresent, payload.articleBody);

  const issues: string[] = [];
  if (!contentSourcePresent && !articleBodyPresent) issues.push("Provide contentSource and/or articleBody to validate a handoff.");
  if (contentSource.present && !contentSource.valid) issues.push(`contentSource does not satisfy ${contentContract}.`);
  if (articleBody.present && !articleBody.valid) issues.push(`articleBody does not satisfy ${articleBody.contract}.`);

  const policyHook = getProjectHooks(config.projectId)?.validateHandoffPolicy;
  const findings = policyHook && (contentSourcePresent || articleBodyPresent) ? policyHook(payload) : [];
  const projectPolicy: HandoffProjectPolicy = { applied: Boolean(policyHook), findings };
  for (const finding of findings) {
    if (finding.severity === "error") issues.push(`[${config.projectId} policy] ${finding.code} at ${finding.path || "$"}: ${finding.message}`);
  }

  const valid = issues.length === 0 && (contentSourcePresent || articleBodyPresent);
  return { valid, projectId: config.projectId, contract: { contentContract, canonicalBodyContract: articleBody.contract }, checks: { contentSource, articleBody }, projectPolicy, issues };
}
