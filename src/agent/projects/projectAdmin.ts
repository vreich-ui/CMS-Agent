// Agent-driven administration of the external project MCP registry.
//
// This is what lets an agent onboard publishing clients beyond the code-defined defaults
// (Dr. Lurie): register a connection, adjust its allowed tools/status, or remove it — all over the
// workspace MCP. Two invariants carry the security posture and are enforced here, not left to
// callers:
//
//   1. Secrets can never be persisted through this API. The TOKEN is accepted ONLY as an
//      environment-variable NAME (validated against a strict identifier pattern), never as a
//      value, so the registry physically cannot store a credential; the value is configured in the
//      deployment and resolved at connection time (see projectTypes.ts).
//
//      The ENDPOINT may now ALSO be supplied as a value (`mcpEndpoint`), because an endpoint URL is
//      not a secret — the fleet already publishes every tenant's endpoint in plaintext in
//      cloudbuild.deploy.yaml's --update-env-vars while tokens travel through --update-secrets.
//      Hand-adding a <CLIENT>_MCP_ENDPOINT variable per tenant was a manual step with no security
//      value (Wolf, 2026-08-18). The reason the original rule refused endpoint values — a URL can
//      smuggle a credential (https://user:pass@host/mcp, ?token=…) — is closed structurally rather
//      than by blanket refusal: registryEndpointSchema below accepts https only, with no userinfo,
//      no query and no fragment, so a stored endpoint is provably credential-free.
//      `mcpEndpointEnvVar` stays REQUIRED and still WINS when populated, so no existing project's
//      resolution changes and the deployment keeps a break-glass override.
//   2. Publishing stays disabled. The publishing policy is constructed server-side on create and
//      is not patchable; enabling publish remains gated on a future explicit PUBLISH approval
//      gate, exactly like the code-defined projects.
//
// Code-defined default projects (dr-lurie) are seeded/migrated from source on every read, so
// deleting them would only resurrect them — delete refuses with a pointer to status="disabled".

import { z } from "zod";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { defaultProjectConfigs } from "./defaultMigration.js";
import { toProjectSummary } from "./projectRegistry.js";
import { DEFAULT_PROJECT_CAPTURE_POLICY, projectAuthModes, projectStatuses, toolPermissions, type ProjectCapturePolicy, type ProjectConnectionConfig, type ProjectPublishingPolicy, type ProjectSummary } from "./projectTypes.js";

// Lowercase-kebab project ids ("acme-daily"), matching the existing "dr-lurie" convention.
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Environment-variable NAME (SCREAMING_SNAKE). The pattern is the load-bearing safety check: a
// URL ("https://…"), a token, or anything value-shaped cannot match, so secrets cannot sneak into
// persisted config through these fields.
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export const projectIdSchema = z.string().regex(PROJECT_ID_PATTERN, "projectId must be lowercase kebab-case (e.g. \"acme-daily\").");
export const envVarNameSchema = z.string().regex(ENV_VAR_NAME_PATTERN, "Expected an environment variable NAME like ACME_MCP_ENDPOINT (never a URL or secret value).");

// The one endpoint VALUE this API accepts, and the whole reason accepting it is safe. Every clause
// is load-bearing:
//   https only        — no http downgrade, no file:/data: smuggling.
//   no userinfo       — https://user:pass@host/mcp is the classic credential-in-a-URL vector.
//   no query/fragment — ?token=… is the other one.
//   length cap        — a registry record is not a payload channel.
// What survives is a plain origin+path, which is exactly what a tenant's /mcp endpoint is and
// nothing more, so it is safe to persist AND to return in project.get / project.list.
export const MAX_REGISTRY_ENDPOINT_LENGTH = 512;
export const registryEndpointSchema = z.string().min(1).max(MAX_REGISTRY_ENDPOINT_LENGTH).superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "mcpEndpoint must be an absolute HTTPS URL (e.g. https://acme-daily.netlify.app/mcp)." });
    return;
  }
  if (url.protocol !== "https:") ctx.addIssue({ code: "custom", message: "mcpEndpoint must use https." });
  if (url.username || url.password) ctx.addIssue({ code: "custom", message: "mcpEndpoint must not embed credentials (no user:password@host) — the token is referenced by env var NAME via tokenEnvVar." });
  if (url.search) ctx.addIssue({ code: "custom", message: "mcpEndpoint must not carry a query string — a query can smuggle a secret value into the registry." });
  if (url.hash) ctx.addIssue({ code: "custom", message: "mcpEndpoint must not carry a fragment." });
});

// canonicalArticleBody was removed (R-23): every definition declared the identical value, making it
// configuration that could only ever misconfigure. The canonical body contract (client_object.v1) is
// derived from the article_body node's own produces const (see projectRegistry.ts validate_handoff).
const contentContractSchema = z.object({
  contentContract: z.string().min(1).default("content_source.v1")
}).strict();

const toolPermissionSchema = z.enum(toolPermissions);
// Per-tool overrides: tool NAME -> permission. Capped so a patch can't smuggle in an unbounded map.
const toolPoliciesSchema = z.record(z.string().min(1).max(128), toolPermissionSchema).refine(
  (map) => Object.keys(map).length <= 256,
  { message: "toolPolicies may not exceed 256 entries." }
);

const httpsOriginSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash;
}, "Expected an HTTPS origin without a path, query, or fragment.");
const capturePathPrefixSchema = z.string().regex(/^\/(?!\/)[^?#]*$/, "Expected an absolute path prefix without query or fragment.");
const captureRightsSchema = z.object({
  content: z.enum(["prohibited", "retain_allowed_origin_content"]),
  media: z.enum(["prohibited", "retain_referenced_allowed_origin_media"])
}).strict();
const designReferenceSchema = z.object({
  origin: httpsOriginSchema,
  purpose: z.literal("design_inspiration_only"),
  crawlAllowed: z.literal(false),
  contentReuse: z.literal("prohibited"),
  mediaReuse: z.literal("prohibited")
}).strict();
const capturePolicySchema: z.ZodType<ProjectCapturePolicy> = z.object({
  // Per-project only: this is not a system-wide crawl ceiling. Zero is the fail-closed default.
  maxPages: z.number().int().min(0),
  allowedCrawlOrigins: z.array(httpsOriginSchema).max(32),
  allowedPathPrefixes: z.array(capturePathPrefixSchema).max(128),
  sameOriginOnly: z.boolean(),
  respectRobots: z.boolean(),
  concurrency: z.number().int().min(1).max(32),
  delayMs: z.number().int().min(0).max(86_400_000),
  authenticatedAccess: z.literal("prohibited"),
  rights: captureRightsSchema,
  designReferences: z.array(designReferenceSchema).max(32),
  fidelity: z.object({
    mode: z.enum(["source_faithful", "design_inspired"]),
    sourceDesignTreatment: z.enum(["source_content_and_design", "source_content_with_design_inspiration_only"]),
    coverageRubricOverride: z.object({
      minimumMappedBlockCoverage: z.number().min(0).max(1),
      requireCompleteTokens: z.boolean(),
      requireEnumeratedGaps: z.boolean()
    }).strict().optional()
  }).strict()
}).strict();
const cloneCapturePolicy = (policy: ProjectCapturePolicy): ProjectCapturePolicy => structuredClone(policy);

export const projectCreateSchema = z.object({
  projectId: projectIdSchema,
  name: z.string().min(1).max(120),
  mcpEndpointEnvVar: envVarNameSchema,
  // Optional endpoint VALUE stored on the record. Absent = today's behavior exactly (env var only).
  mcpEndpoint: registryEndpointSchema.optional(),
  authMode: z.enum(projectAuthModes).default("bearer_env"),
  tokenEnvVar: envVarNameSchema.optional(),
  // Deny-all by default: remote tools must be allow-listed explicitly (or via defaultToolPolicy)
  // before project.call_tool will forward to them.
  allowedTools: z.array(z.string().min(1).max(128)).max(64).default([]),
  defaultToolPolicy: toolPermissionSchema.optional(),
  toolPolicies: toolPoliciesSchema.optional(),
  contentContract: contentContractSchema.default({ contentContract: "content_source.v1" }),
  capturePolicy: capturePolicySchema.default(DEFAULT_PROJECT_CAPTURE_POLICY),
  status: z.enum(projectStatuses).default("active")
}).strict();

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  mcpEndpointEnvVar: envVarNameSchema.optional(),
  // null CLEARS the stored endpoint (back to env-var-only resolution); omitting it leaves it as-is.
  mcpEndpoint: registryEndpointSchema.nullable().optional(),
  authMode: z.enum(projectAuthModes).optional(),
  tokenEnvVar: envVarNameSchema.nullable().optional(),
  allowedTools: z.array(z.string().min(1).max(128)).max(64).optional(),
  // The three-state permission control the Access page writes. toolPolicies replaces the whole map;
  // defaultToolPolicy sets the client-wide fallback. Both are safe metadata (tool names, not secrets).
  defaultToolPolicy: toolPermissionSchema.optional(),
  toolPolicies: toolPoliciesSchema.optional(),
  contentContract: z.object({ contentContract: z.string().min(1) }).strict().optional(),
  capturePolicy: capturePolicySchema.optional(),
  status: z.enum(projectStatuses).optional(),
  // T2 (2026-08-13): the ONE deliberate crack in "publishingPolicy is server-controlled" (see
  // updateProject below and the comment at tools.ts's projectPatchJsonSchema). Every other field on
  // ProjectPublishingPolicy — publishEnabled (the hard kill-switch precondition) and
  // requiresExplicitPublish — stays untouchable through this API; only operatorDefault is exposed,
  // by NAME, not by accepting a nested publishingPolicy object a caller could use to smuggle in the
  // rest. "require_explicit" is accepted explicitly so an operator can revert a project to today's
  // behavior without needing a null/undefined convention.
  operatorPublishDefault: z.enum(["approved", "require_explicit"]).optional()
}).strict();

// The MCP boundary parses defaults before calling createProject. Keeping this optional also lets
// trusted in-process callers use the same fail-closed default rather than having to duplicate it.
export type ProjectCreateInput = Omit<z.infer<typeof projectCreateSchema>, "capturePolicy"> & { capturePolicy?: ProjectCapturePolicy };
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

export class ProjectAdminError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

const DEFAULT_PUBLISHING_POLICY: ProjectPublishingPolicy = {
  publishEnabled: true,
  requiresExplicitPublish: false,
  description: "Publishing is enabled (go-live 2026-07-31, operator decision). Set the per-project *_PUBLISH_ENABLED=false env flag to force publishing off."
};

const defaultProjectIds = (): Set<string> => new Set(defaultProjectConfigs().map((project) => project.projectId));

// Enforced HERE, not only at the MCP boundary's zod parse, so no in-process caller (site genesis,
// a future job) can put an endpoint on a record without passing the credential-free check.
const requireCredentialFreeEndpoint = (mcpEndpoint: string | undefined) => {
  if (mcpEndpoint === undefined) return;
  const parsed = registryEndpointSchema.safeParse(mcpEndpoint);
  if (!parsed.success) {
    throw new ProjectAdminError("endpoint_not_credential_free", `mcpEndpoint is not a storable endpoint: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`);
  }
};

const requireTokenEnvVarForBearer = (authMode: string, tokenEnvVar: string | undefined) => {
  if (authMode === "bearer_env" && !tokenEnvVar) {
    throw new ProjectAdminError("token_env_var_required", "authMode \"bearer_env\" requires tokenEnvVar (the NAME of the env var holding the bearer token).");
  }
};

export async function createProject(repository: ProjectRepository, input: ProjectCreateInput): Promise<ProjectSummary> {
  requireTokenEnvVarForBearer(input.authMode, input.tokenEnvVar);
  requireCredentialFreeEndpoint(input.mcpEndpoint);
  if (await repository.get(input.projectId)) {
    throw new ProjectAdminError("project_exists", `A project with id "${input.projectId}" is already registered.`);
  }
  const config: ProjectConnectionConfig = {
    projectId: input.projectId,
    name: input.name,
    mcpEndpointEnvVar: input.mcpEndpointEnvVar,
    ...(input.mcpEndpoint ? { mcpEndpoint: input.mcpEndpoint } : {}),
    authMode: input.authMode,
    ...(input.tokenEnvVar ? { tokenEnvVar: input.tokenEnvVar } : {}),
    allowedTools: [...input.allowedTools],
    ...(input.defaultToolPolicy ? { defaultToolPolicy: input.defaultToolPolicy } : {}),
    ...(input.toolPolicies ? { toolPolicies: { ...input.toolPolicies } } : {}),
    contentContract: { ...input.contentContract },
    capturePolicy: cloneCapturePolicy(input.capturePolicy ?? DEFAULT_PROJECT_CAPTURE_POLICY),
    publishingPolicy: { ...DEFAULT_PUBLISHING_POLICY },
    status: input.status
  };
  return toProjectSummary(await repository.save(config));
}

export async function updateProject(repository: ProjectRepository, projectId: string, patch: ProjectUpdateInput): Promise<ProjectSummary> {
  const existing = await repository.get(projectId);
  if (!existing) throw new ProjectAdminError("unknown_project", `Unknown projectId: ${projectId}`);

  const next: ProjectConnectionConfig = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.mcpEndpointEnvVar !== undefined ? { mcpEndpointEnvVar: patch.mcpEndpointEnvVar } : {}),
    ...(patch.authMode !== undefined ? { authMode: patch.authMode } : {}),
    ...(patch.allowedTools !== undefined ? { allowedTools: [...patch.allowedTools] } : {}),
    ...(patch.defaultToolPolicy !== undefined ? { defaultToolPolicy: patch.defaultToolPolicy } : {}),
    ...(patch.toolPolicies !== undefined ? { toolPolicies: { ...patch.toolPolicies } } : {}),
    ...(patch.contentContract !== undefined ? { contentContract: { ...patch.contentContract } } : {}),
    ...(patch.capturePolicy !== undefined ? { capturePolicy: cloneCapturePolicy(patch.capturePolicy) } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    // Identity and policy are not patchable; publishing stays server-controlled — EXCEPT
    // operatorDefault (T2), which is copied in from the narrow, separately-validated
    // operatorPublishDefault field so a caller can only ever move that one sub-field. publishEnabled
    // (the hard kill-switch precondition) and requiresExplicitPublish are never touched here.
    projectId: existing.projectId,
    publishingPolicy: {
      ...existing.publishingPolicy,
      ...(patch.operatorPublishDefault !== undefined ? { operatorDefault: patch.operatorPublishDefault } : {})
    }
  };
  if (patch.mcpEndpoint !== undefined) {
    if (patch.mcpEndpoint === null) delete next.mcpEndpoint;
    else next.mcpEndpoint = patch.mcpEndpoint;
  }
  if (patch.tokenEnvVar !== undefined) {
    if (patch.tokenEnvVar === null) delete next.tokenEnvVar;
    else next.tokenEnvVar = patch.tokenEnvVar;
  }
  requireTokenEnvVarForBearer(next.authMode, next.tokenEnvVar);
  requireCredentialFreeEndpoint(next.mcpEndpoint);
  return toProjectSummary(await repository.save(next));
}

export async function deleteProject(repository: ProjectRepository, projectId: string): Promise<{ deleted: boolean; projectId: string }> {
  if (defaultProjectIds().has(projectId)) {
    throw new ProjectAdminError("default_project_protected", `"${projectId}" is a code-defined default project and is re-seeded on read; set status to "disabled" instead of deleting.`);
  }
  if (!(await repository.get(projectId))) throw new ProjectAdminError("unknown_project", `Unknown projectId: ${projectId}`);
  const deleted = await repository.delete(projectId);
  return { deleted, projectId };
}

// Machine-readable onboarding contract, so an agent can discover exactly how to register a new
// publishing client end-to-end without reading this codebase.
export function projectRegistrationContract() {
  return {
    version: "project_registration.v1",
    purpose: "Register an external publishing client's MCP server so the workspace can test, inspect, and validate handoffs against it.",
    secretHandling: {
      rule: "The TOKEN is referenced by environment variable NAME only; its value is configured in the deployment and is never persisted or returned. The ENDPOINT is not a secret: supply it directly as mcpEndpoint and it is stored on the record, so no per-tenant env var has to be added to this deployment. A stored endpoint is validated credential-free (https, no user:password@, no query, no fragment) and may be returned to callers; the env var's own value never is.",
      endpointEnvVarPattern: ENV_VAR_NAME_PATTERN.source,
      endpointResolution: "env var first, record second: <CLIENT>_MCP_ENDPOINT wins whenever it is populated (unchanged behavior + a break-glass override); mcpEndpoint answers when it is not.",
      convention: "<CLIENT>_MCP_ENDPOINT and <CLIENT>_MCP_TOKEN, e.g. ACME_DAILY_MCP_ENDPOINT / ACME_DAILY_MCP_TOKEN."
    },
    fields: {
      projectId: { required: true, pattern: PROJECT_ID_PATTERN.source, example: "acme-daily" },
      name: { required: true, example: "Acme Daily" },
      mcpEndpointEnvVar: { required: true, example: "ACME_DAILY_MCP_ENDPOINT", note: "Env var NAME. Still required (it is the override channel), but you no longer have to SET it if you pass mcpEndpoint." },
      mcpEndpoint: { required: false, example: "https://acme-daily.netlify.app/mcp", note: "The endpoint URL itself, stored on the record — an endpoint is not a secret. https only, no credentials, no query, no fragment. Omit it to keep pure env-var resolution. site.duplicate genesis derives this automatically from the Netlify site it just created, so a minted tenant needs no endpoint step at all." },
      authMode: { required: false, default: "bearer_env", enum: [...projectAuthModes] },
      tokenEnvVar: { required: "when authMode is bearer_env", example: "ACME_DAILY_MCP_TOKEN" },
      allowedTools: { required: false, default: [], note: "Deny-all until remote tool names are explicitly allow-listed; project.call_tool refuses anything else." },
      contentContract: { required: false, default: { contentContract: "content_source.v1" } },
      capturePolicy: { required: false, default: DEFAULT_PROJECT_CAPTURE_POLICY, note: "Per-project capture governance. Missing policy denies all capture (maxPages=0, no origins); design references may never contribute copied content or media." },
      status: { required: false, default: "active", enum: [...projectStatuses] }
    },
    publishingPolicy: "Server-enforced: publishEnabled=true by default (go-live 2026-07-31). The per-project *_PUBLISH_ENABLED=false env flag is the operator kill-switch.",
    onboardingSteps: [
      "1. project.create with projectId, name, mcpEndpointEnvVar (+ tokenEnvVar for bearer_env), and — recommended — mcpEndpoint, the endpoint URL itself.",
      "2. Configure the TOKEN env var referenced by tokenEnvVar in the deployment (a secret value never passes through MCP). The endpoint needs no deployment change when mcpEndpoint was supplied; set <CLIENT>_MCP_ENDPOINT only to override it.",
      "3. project.get — connection.endpointConfigured/tokenConfigured turn true once the deploy sees the env vars.",
      "4. project.test_connection — primitive MCP initialize against the client's server.",
      "5. project.list_tools, then project.update to allow-list the safe read-only tool names.",
      "6. project.validate_handoff — dry structural validation of content_source.v1 / client_object.v1 payloads."
    ]
  };
}
