// Agent-driven administration of the external project MCP registry.
//
// This is what lets an agent onboard publishing clients beyond the code-defined defaults
// (Dr. Lurie): register a connection, adjust its allowed tools/status, or remove it — all over the
// workspace MCP. Two invariants carry the security posture and are enforced here, not left to
// callers:
//
//   1. Secrets can never be persisted through this API. Endpoint and token are accepted ONLY as
//      environment-variable NAMES (validated against a strict identifier pattern), never as
//      values. A URL or token pasted where a name belongs fails validation, so the registry
//      physically cannot store a credential. Values are configured in Netlify env and resolved at
//      connection time (see projectTypes.ts).
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
import { projectAuthModes, projectStatuses, type ProjectConnectionConfig, type ProjectPublishingPolicy, type ProjectSummary } from "./projectTypes.js";

// Lowercase-kebab project ids ("acme-daily"), matching the existing "dr-lurie" convention.
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Environment-variable NAME (SCREAMING_SNAKE). The pattern is the load-bearing safety check: a
// URL ("https://…"), a token, or anything value-shaped cannot match, so secrets cannot sneak into
// persisted config through these fields.
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export const projectIdSchema = z.string().regex(PROJECT_ID_PATTERN, "projectId must be lowercase kebab-case (e.g. \"acme-daily\").");
export const envVarNameSchema = z.string().regex(ENV_VAR_NAME_PATTERN, "Expected an environment variable NAME like ACME_MCP_ENDPOINT (never a URL or secret value).");

const contentContractSchema = z.object({
  contentContract: z.string().min(1).default("content_source.v1"),
  canonicalArticleBody: z.string().min(1).default("article_body.v1")
}).strict();

export const projectCreateSchema = z.object({
  projectId: projectIdSchema,
  name: z.string().min(1).max(120),
  mcpEndpointEnvVar: envVarNameSchema,
  authMode: z.enum(projectAuthModes).default("bearer_env"),
  tokenEnvVar: envVarNameSchema.optional(),
  // Deny-all by default: remote tools must be allow-listed explicitly before project.call_tool
  // will forward to them.
  allowedTools: z.array(z.string().min(1).max(128)).max(64).default([]),
  contentContract: contentContractSchema.default({ contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" }),
  status: z.enum(projectStatuses).default("active")
}).strict();

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  mcpEndpointEnvVar: envVarNameSchema.optional(),
  authMode: z.enum(projectAuthModes).optional(),
  tokenEnvVar: envVarNameSchema.nullable().optional(),
  allowedTools: z.array(z.string().min(1).max(128)).max(64).optional(),
  contentContract: z.object({ contentContract: z.string().min(1), canonicalArticleBody: z.string().min(1) }).strict().optional(),
  status: z.enum(projectStatuses).optional()
}).strict();

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

export class ProjectAdminError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

const DISABLED_PUBLISHING_POLICY: ProjectPublishingPolicy = {
  publishEnabled: false,
  requiresExplicitPublish: true,
  description: "Publishing is disabled. Enable only behind a future explicit PUBLISH approval gate."
};

const defaultProjectIds = (): Set<string> => new Set(defaultProjectConfigs().map((project) => project.projectId));

const requireTokenEnvVarForBearer = (authMode: string, tokenEnvVar: string | undefined) => {
  if (authMode === "bearer_env" && !tokenEnvVar) {
    throw new ProjectAdminError("token_env_var_required", "authMode \"bearer_env\" requires tokenEnvVar (the NAME of the env var holding the bearer token).");
  }
};

export async function createProject(repository: ProjectRepository, input: ProjectCreateInput): Promise<ProjectSummary> {
  requireTokenEnvVarForBearer(input.authMode, input.tokenEnvVar);
  if (await repository.get(input.projectId)) {
    throw new ProjectAdminError("project_exists", `A project with id "${input.projectId}" is already registered.`);
  }
  const config: ProjectConnectionConfig = {
    projectId: input.projectId,
    name: input.name,
    mcpEndpointEnvVar: input.mcpEndpointEnvVar,
    authMode: input.authMode,
    ...(input.tokenEnvVar ? { tokenEnvVar: input.tokenEnvVar } : {}),
    allowedTools: [...input.allowedTools],
    contentContract: { ...input.contentContract },
    publishingPolicy: { ...DISABLED_PUBLISHING_POLICY },
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
    ...(patch.contentContract !== undefined ? { contentContract: { ...patch.contentContract } } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    // Identity and policy are not patchable; publishing stays server-controlled.
    projectId: existing.projectId,
    publishingPolicy: { ...existing.publishingPolicy }
  };
  if (patch.tokenEnvVar !== undefined) {
    if (patch.tokenEnvVar === null) delete next.tokenEnvVar;
    else next.tokenEnvVar = patch.tokenEnvVar;
  }
  requireTokenEnvVarForBearer(next.authMode, next.tokenEnvVar);
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
      rule: "Endpoint and token are referenced by environment variable NAME only; values are configured in the Netlify deployment and are never persisted or returned.",
      endpointEnvVarPattern: ENV_VAR_NAME_PATTERN.source,
      convention: "<CLIENT>_MCP_ENDPOINT and <CLIENT>_MCP_TOKEN, e.g. ACME_DAILY_MCP_ENDPOINT / ACME_DAILY_MCP_TOKEN."
    },
    fields: {
      projectId: { required: true, pattern: PROJECT_ID_PATTERN.source, example: "acme-daily" },
      name: { required: true, example: "Acme Daily" },
      mcpEndpointEnvVar: { required: true, example: "ACME_DAILY_MCP_ENDPOINT" },
      authMode: { required: false, default: "bearer_env", enum: [...projectAuthModes] },
      tokenEnvVar: { required: "when authMode is bearer_env", example: "ACME_DAILY_MCP_TOKEN" },
      allowedTools: { required: false, default: [], note: "Deny-all until remote tool names are explicitly allow-listed; project.call_tool refuses anything else." },
      contentContract: { required: false, default: { contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" } },
      status: { required: false, default: "active", enum: [...projectStatuses] }
    },
    publishingPolicy: "Server-enforced: publishEnabled=false, requiresExplicitPublish=true. Not patchable; a future explicit PUBLISH gate is the only path to enabling it.",
    onboardingSteps: [
      "1. project.create with projectId, name, mcpEndpointEnvVar (+ tokenEnvVar for bearer_env).",
      "2. Configure the referenced environment variables in the Netlify deployment (values never pass through MCP).",
      "3. project.get — connection.endpointConfigured/tokenConfigured turn true once the deploy sees the env vars.",
      "4. project.test_connection — primitive MCP initialize against the client's server.",
      "5. project.list_tools, then project.update to allow-list the safe read-only tool names.",
      "6. project.validate_handoff — dry structural validation of content_source.v1 / article_body.v1 payloads."
    ]
  };
}
