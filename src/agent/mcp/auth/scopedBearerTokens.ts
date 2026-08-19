// Scoped MCP bearer configuration is intentionally a single secret-backed JSON value. The JSON
// maps the opaque bearer itself to the projects and canonical *wire* tool names it may use. This
// module never logs or returns either the raw configuration or a token.
//
// Example secret payload (use synthetic values in documentation and tests only):
// {"scoped-example-platform":{"projects":["platform"],"toolAllowlist":["agent_resolve","agent_converse"]}}

export const SCOPED_BEARER_TOKENS_ENV = "MCP_SCOPED_TOKENS_JSON";

export type ScopedBearerTokenPolicy = {
  projects: readonly string[];
  toolAllowlist: readonly string[];
};

export class ScopedBearerConfigurationError extends Error {
  constructor() {
    // Do not include parser detail: it could otherwise surface token material from the secret.
    super("Scoped MCP bearer configuration is invalid.");
  }
}

const projectIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const wireToolNamePattern = /^[a-z][a-z0-9_]*$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const cleanStringList = (value: unknown, valid: (item: string) => boolean): string[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !valid(item) || values.includes(item)) return null;
    values.push(item);
  }
  return values;
};

// Empty/unset disables scoped-token support and leaves the two established auth paths unchanged.
// A configured entry must be complete: partial policy is an accidental privilege grant, so it is
// rejected instead of guessed. Keys are opaque bearer values and deliberately keep their exact
// bytes; trim/normalization would change the secret represented by a key.
export function parseScopedBearerTokenPolicies(env: NodeJS.ProcessEnv = process.env): Map<string, ScopedBearerTokenPolicy> {
  const raw = env[SCOPED_BEARER_TOKENS_ENV];
  if (raw === undefined || raw === "") return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScopedBearerConfigurationError();
  }
  if (!isPlainObject(parsed)) throw new ScopedBearerConfigurationError();

  const policies = new Map<string, ScopedBearerTokenPolicy>();
  for (const [token, value] of Object.entries(parsed)) {
    if (!token || token.trim() !== token || /\s/.test(token) || !isPlainObject(value) || Object.keys(value).length !== 2 || !("projects" in value) || !("toolAllowlist" in value)) {
      throw new ScopedBearerConfigurationError();
    }
    const projects = cleanStringList(value.projects, (project) => projectIdPattern.test(project));
    // Allow-list entries are the canonical underscore names exposed by tools/list. Dotted aliases
    // are intentionally rejected so config cannot accidentally grant both spellings of a tool.
    const toolAllowlist = cleanStringList(value.toolAllowlist, (tool) => wireToolNamePattern.test(tool));
    if (!projects || !toolAllowlist) throw new ScopedBearerConfigurationError();
    policies.set(token, { projects, toolAllowlist });
  }

  const legacyToken = env.MCP_API_TOKEN;
  if (legacyToken && policies.has(legacyToken)) throw new ScopedBearerConfigurationError();
  return policies;
}

// Cloud Run validates at process startup. Netlify has no equivalent process-start hook, so the
// endpoint parses on each request and treats a malformed secret as an authentication failure.
export function validateScopedBearerTokenConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  parseScopedBearerTokenPolicies(env);
}

export const findScopedBearerTokenPolicy = (token: string, env: NodeJS.ProcessEnv = process.env): ScopedBearerTokenPolicy | undefined =>
  parseScopedBearerTokenPolicies(env).get(token);

// The deployment-time JSON remains a backwards-compatible break-glass path. Genesis-owned
// credentials are resolved from the durable digest registry, which means adding or rotating a
// client no longer requires editing one shared secret and forcing a Cloud Run revision.
export async function findAnyScopedBearerTokenPolicy(token: string, env: NodeJS.ProcessEnv = process.env): Promise<ScopedBearerTokenPolicy | undefined> {
  const legacy = findScopedBearerTokenPolicy(token, env);
  const { findManagedScopedBearerTokenPolicy, hasManagedScopedBearerForProjects } = await import("./managedScopedBearerCredentials.js");
  const managed = await findManagedScopedBearerTokenPolicy(token, env);
  if (managed) return managed;
  // Once genesis/reconciliation owns a project's credential, any matching legacy static-map token
  // for that project is superseded automatically. Operators do not need to hand-edit the shared
  // JSON immediately to make the rotation effective.
  if (legacy && !(await hasManagedScopedBearerForProjects(legacy.projects, env))) return legacy;
  return undefined;
}
