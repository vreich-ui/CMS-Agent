/**
 * Environment loading + startup validation.
 *
 * Fails fast: if a required variable is missing or malformed, the process
 * throws a precise error naming the variable and exits before the HTTP
 * server ever binds a port. A broker that starts half-configured is a
 * broker that silently leaks or silently blocks — neither is acceptable.
 */

export interface Config {
  port: number;
  sessionSecret: string;
  operatorPasswordHash: string;
  mcpUrl: string;
  mcpToken: string;
  readOnly: boolean;
  allowedOrigin: string;
  mockUpstream: boolean;
}

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(
      `Missing required environment variable: ${name}. See .env.example for what it does and why it is required.`
    );
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

function parseBoolFlag(value: string): boolean {
  // Treat "0", "false", "no" (case-insensitive) as off; everything else on.
  const normalized = value.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no" || normalized === "");
}

/**
 * Loads and validates configuration from the given env source
 * (defaults to process.env). Throws ConfigError with a precise message
 * on the first problem found.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mockUpstream = parseBoolFlag(optional(env, "MOCK_UPSTREAM", "0"));

  const portRaw = optional(env, "PORT", "8787");
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`Invalid PORT: "${portRaw}" is not a valid port number (1-65535).`);
  }

  const sessionSecret = required(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new ConfigError(
      `SESSION_SECRET is too short (${sessionSecret.length} chars). It must be at least 32 characters — ` +
        `generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
    );
  }

  const operatorPasswordHash = required(env, "OPERATOR_PASSWORD_HASH");
  if (!/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(operatorPasswordHash)) {
    throw new ConfigError(
      `OPERATOR_PASSWORD_HASH is malformed. Expected format "scrypt$N$r$p$salt_b64$hash_b64". ` +
        `Generate one with: npm run hash -- <password>`
    );
  }

  // MOCK_UPSTREAM=1 relaxes the MCP endpoint/token requirement so the full
  // HTTP surface can be exercised without real credentials (see smoke.test.ts).
  const mcpUrl = mockUpstream ? optional(env, "CMS_AGENT_MCP_URL", "http://mock.invalid/mcp") : required(env, "CMS_AGENT_MCP_URL");
  const mcpToken = mockUpstream ? optional(env, "CMS_AGENT_MCP_TOKEN", "mock-token") : required(env, "CMS_AGENT_MCP_TOKEN");

  const readOnly = parseBoolFlag(optional(env, "READ_ONLY", "1"));
  const allowedOrigin = optional(env, "ALLOWED_ORIGIN", "http://localhost:5173");

  return {
    port,
    sessionSecret,
    operatorPasswordHash,
    mcpUrl,
    mcpToken,
    readOnly,
    allowedOrigin,
    mockUpstream,
  };
}

export { ConfigError };
