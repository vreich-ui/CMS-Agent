import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectMcpAdapter,
  resolveProjectConnection,
  resolveProjectConnectionWithSecrets,
  toConnectionState
} from "../../../src/agent/projects/projectMcpAdapter.js";
import {
  __resetSecretCachesForTesting,
  accessSecretValue,
  isSecretVersionRef,
  SECRET_CACHE_TTL_MS
} from "../../../src/agent/projects/secretManager.js";
import { projectCreateSchema, projectUpdateSchema } from "../../../src/agent/projects/projectAdmin.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// T12.20 — the TOKEN half of endpoint-on-record.
//
// The incident this is pinned against: the `continuation-tick` Cloud Run job has executed queued
// nodes every ~2 minutes since 2026-08-14 and carries NO tenant MCP variables, so roughly half of
// every capture node execution failed while the identical call through the cms-agent-mcp service
// succeeded. Two planes, same code, different environment. The fix is that a plane needs no
// per-tenant configuration at all: the record names a Secret Manager version, and any plane with a
// Google identity resolves it.
//
// The load-bearing properties, each pinned below: ENV STILL WINS (no existing project changes), the
// VALUE never appears in a caller-facing view or an error, a failed read is NAMED rather than left
// to surface as a tenant 401, and the reference field cannot be turned into a secret field.

const SECRET_REF = "projects/cms-agent-503015/secrets/tenant-acme-mcp-token/versions/latest";
const SECRET_VALUE = "tenant-bearer-do-not-leak";
const B64 = Buffer.from(SECRET_VALUE, "utf8").toString("base64");

const config = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig => ({
  projectId: "acme",
  name: "Acme",
  mcpEndpointEnvVar: "ACME_MCP_ENDPOINT",
  mcpEndpoint: "https://acme.netlify.app/mcp",
  authMode: "bearer_env",
  tokenEnvVar: "ACME_MCP_TOKEN",
  allowedTools: [],
  defaultToolPolicy: "allowed",
  contentContract: { contentContract: "content_source.v1" },
  capturePolicy: {
    maxPages: 0,
    allowedCrawlOrigins: [],
    allowedPathPrefixes: [],
    sameOriginOnly: true,
    respectRobots: true,
    concurrency: 1,
    delayMs: 0,
    authenticatedAccess: "prohibited",
    rights: { content: "prohibited", media: "prohibited" },
    designReferences: [],
    fidelity: { mode: "source_faithful", sourceDesignTreatment: "source_content_and_design" }
  },
  publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, description: "test" },
  status: "active",
  ...overrides
});

/** Stands in for the metadata server + Secret Manager. Records what was asked for. */
const stubGoogle = (options: { secretStatus?: number; metadataOk?: boolean; payload?: string } = {}) => {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/computeMetadata/")) {
      if (options.metadataOk === false) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      expect(init?.headers?.["Metadata-Flavor"]).toBe("Google");
      return { ok: true, status: 200, json: async () => ({ access_token: "ya29.plane", expires_in: 3600 }) } as unknown as Response;
    }
    const status = options.secretStatus ?? 200;
    return {
      ok: status === 200,
      status,
      json: async () => ({ payload: { data: options.payload ?? B64 } })
    } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
};

afterEach(() => {
  __resetSecretCachesForTesting();
  vi.restoreAllMocks();
});

describe("token resolution: env first, Secret Manager second", () => {
  it("a populated token env var STILL WINS over a stored reference — no existing project's resolution changes", async () => {
    const google = stubGoogle();
    const resolved = await resolveProjectConnectionWithSecrets(
      config({ tokenSecretRef: SECRET_REF }),
      { ACME_MCP_TOKEN: "from-the-environment" },
      { fetchImpl: google.fetchImpl }
    );
    expect(resolved.token).toBe("from-the-environment");
    expect(resolved.tokenSource).toBe("env");
    // The decisive part: Secret Manager was never contacted at all.
    expect(google.calls).toEqual([]);
  });

  it("resolves the token from Secret Manager when the env var is absent", async () => {
    const google = stubGoogle();
    const resolved = await resolveProjectConnectionWithSecrets(
      config({ tokenSecretRef: SECRET_REF }),
      {},
      { fetchImpl: google.fetchImpl }
    );
    expect(resolved.token).toBe(SECRET_VALUE);
    expect(resolved.tokenSource).toBe("secret");
    expect(resolved.tokenConfigured).toBe(true);
    expect(resolved.tokenError).toBeUndefined();
    expect(google.calls.some((c) => c.endsWith(`${SECRET_REF}:access`))).toBe(true);
  });

  it("caches a resolved secret, so a busy run does not re-read it on every call", async () => {
    const google = stubGoogle();
    const deps = { fetchImpl: google.fetchImpl };
    await resolveProjectConnectionWithSecrets(config({ tokenSecretRef: SECRET_REF }), {}, deps);
    await resolveProjectConnectionWithSecrets(config({ tokenSecretRef: SECRET_REF }), {}, deps);
    expect(google.calls.filter((c) => c.includes(":access"))).toHaveLength(1);
  });

  it("re-reads once the cache TTL has passed, so a rotation takes effect without a redeploy", async () => {
    const google = stubGoogle();
    let clock = 1_000;
    const deps = { fetchImpl: google.fetchImpl, now: () => clock };
    await accessSecretValue(SECRET_REF, deps);
    clock += SECRET_CACHE_TTL_MS + 1;
    await accessSecretValue(SECRET_REF, deps);
    expect(google.calls.filter((c) => c.includes(":access"))).toHaveLength(2);
  });

  it("an empty-string env var falls through to the reference rather than resolving to nothing", async () => {
    const google = stubGoogle();
    const resolved = await resolveProjectConnectionWithSecrets(
      config({ tokenSecretRef: SECRET_REF }),
      { ACME_MCP_TOKEN: "   " },
      { fetchImpl: google.fetchImpl }
    );
    expect(resolved.token).toBe(SECRET_VALUE);
    expect(resolved.tokenSource).toBe("secret");
  });

  it("trims the stored value — a trailing newline is the classic way a hand-made secret 401s", async () => {
    const google = stubGoogle({ payload: Buffer.from(`${SECRET_VALUE}\n`, "utf8").toString("base64") });
    const result = await accessSecretValue(SECRET_REF, { fetchImpl: google.fetchImpl });
    expect(result).toEqual({ ok: true, value: SECRET_VALUE });
  });
});

describe("failures are named, never guessed at", () => {
  it("reports what the metadata server ACTUALLY did, per host — never a confident guess", async () => {
    const google = stubGoogle({ metadataOk: false });
    const result = await accessSecretValue(SECRET_REF, { fetchImpl: google.fetchImpl });
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    // Both documented hosts are attempted, and each is named with its own outcome. The first cut of
    // this module collapsed all of that into "this plane has no Google identity", which was WRONG on
    // a plane that reads GCS through the very same credential and cost an hour of misdirection.
    expect(error).toContain("metadata.google.internal: HTTP 404");
    expect(error).toContain("169.254.169.254: HTTP 404");
    expect(error).toContain("metadata reachability problem, not a token problem");
    expect(google.calls.filter((c) => c.includes("/computeMetadata/"))).toHaveLength(2);
  });

  it("falls back to the link-local address when the metadata DNS NAME does not resolve", async () => {
    // The exact 2026-08-20 failure shape: the name is unresolvable, the address is fine.
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("metadata.google.internal")) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { name: "TypeError" });
      if (href.includes("/computeMetadata/")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "ya29.plane", expires_in: 3600 }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ payload: { data: B64 } }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await accessSecretValue(SECRET_REF, { fetchImpl });
    expect(result).toEqual({ ok: true, value: SECRET_VALUE });
    expect(calls.some((c) => c.includes("169.254.169.254"))).toBe(true);
  });

  it("a denied read names the IAM role that would fix it", async () => {
    const google = stubGoogle({ secretStatus: 403 });
    const result = await accessSecretValue(SECRET_REF, { fetchImpl: google.fetchImpl });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("roles/secretmanager.secretAccessor");
  });

  it("the adapter refuses a record that names a secret it cannot read, quoting the REFERENCE only", async () => {
    const google = stubGoogle({ secretStatus: 403 });
    const adapter = new ProjectMcpAdapter(config({ tokenSecretRef: SECRET_REF }), {
      env: {},
      secrets: { fetchImpl: google.fetchImpl }
    });
    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain(SECRET_REF);
    expect(result.error).not.toContain(SECRET_VALUE);
  });

  it("a project with neither an env token nor a reference still connects tokenless, exactly as before", async () => {
    const resolved = await resolveProjectConnectionWithSecrets(config(), {});
    expect(resolved.token).toBeUndefined();
    expect(resolved.tokenSource).toBe("unset");
    expect(resolved.tokenConfigured).toBe(false);
    expect(resolved.tokenError).toBeUndefined();
  });
});

describe("the reference is a pointer, and cannot become a secret field", () => {
  it("accepts a version resource name", () => {
    expect(isSecretVersionRef(SECRET_REF)).toBe(true);
    expect(isSecretVersionRef("projects/acme-prod-123/secrets/x_y-z/versions/7")).toBe(true);
  });

  it.each([
    ["a raw bearer token", "ya29.averyrealsecretvalue"],
    ["an arbitrary URL", "https://secretmanager.googleapis.com/v1/projects/p/secrets/s/versions/latest"],
    ["a different Google API path", "projects/cms-agent-503015/locations/global/keyRings/r"],
    ["a traversal", "projects/cms-agent-503015/secrets/../../versions/latest"],
    ["a project id too short to be real", "projects/p-12/secrets/tenant/versions/latest"],
    ["a missing version", "projects/cms-agent-503015/secrets/tenant-acme-mcp-token"],
    ["version zero", "projects/cms-agent-503015/secrets/tenant/versions/0"]
  ])("refuses %s", (_label, value) => {
    expect(isSecretVersionRef(value)).toBe(false);
    expect(projectCreateSchema.safeParse({ ...baseCreateInput, tokenSecretRef: value }).success).toBe(false);
  });

  it("project.create and project.update accept a valid reference; null clears it on update", () => {
    expect(projectCreateSchema.safeParse({ ...baseCreateInput, tokenSecretRef: SECRET_REF }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ tokenSecretRef: SECRET_REF }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ tokenSecretRef: null }).success).toBe(true);
  });

  it("the safe connection view reports the SOURCE and the REFERENCE, and never the value", () => {
    const state = toConnectionState(config({ tokenSecretRef: SECRET_REF }), {});
    expect(state.tokenSource).toBe("secret");
    expect(state.tokenSecretRef).toBe(SECRET_REF);
    expect(state.tokenConfigured).toBe(true);
    expect(JSON.stringify(state)).not.toContain(SECRET_VALUE);
  });

  it("the sync resolver performs NO privileged read — reachability callers must stay side-effect-free", () => {
    const resolved = resolveProjectConnection(config({ tokenSecretRef: SECRET_REF }), {});
    expect(resolved.tokenConfigured).toBe(true);
    expect(resolved.tokenSource).toBe("secret");
    expect(resolved.token).toBeUndefined();
  });
});

const baseCreateInput = {
  projectId: "acme-daily",
  name: "Acme Daily",
  mcpEndpointEnvVar: "ACME_DAILY_MCP_ENDPOINT"
};
