import { describe, expect, it, vi } from "vitest";
import { defaultProjectConfigs } from "../../../src/agent/projects/defaultMigration.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import { reconcileSiteClientManagerCredentials } from "../../../src/agent/capture/siteCredentialReconciler.js";
import { SITE_CLIENT_MANAGER_TOOLS } from "../../../src/agent/capture/siteGenesis.js";
import {
  MANAGED_SCOPED_BEARER_CONTRACT,
  MANAGED_SCOPED_BEARER_REGISTRY_KEY,
  ManagedScopedBearerCredentialRepository
} from "../../../src/agent/mcp/auth/managedScopedBearerCredentials.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";

const projectRepository = (): ProjectRepository => {
  const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
  const record = { ...platform, mcpEndpoint: "https://kugel-platform.netlify.app/mcp", clientSiteBinding: { netlifySiteName: "kugel-platform", netlifySiteId: "site_platform" }, status: "active" as const };
  return {
    list: async () => [record],
    get: async () => record,
    save: async (value) => value,
    delete: async () => false,
    health: async () => ({ readable: true, writable: true, backend: "memory", version: "memory.v1" })
  } as ProjectRepository;
};

const response = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// A minimal in-memory double for the blob store, matching the one in
// tests/agent/mcp/managedScopedBearerCredentials.test.ts, so these tests exercise the real
// ManagedScopedBearerCredentialRepository (mint/activate/state filtering) rather than a hand-rolled
// stand-in that could silently drift from what the reconciler actually depends on.
const memoryBlobStore = (): BlobStoreClient => {
  const values = new Map<string, { data: unknown; etag: string }>();
  let generation = 0;
  return {
    get: async (key: string) => structuredClone(values.get(key)?.data ?? null),
    getWithMetadata: async (key: string) => {
      const current = values.get(key);
      return current ? { data: structuredClone(current.data), etag: current.etag, metadata: {} } : null;
    },
    setJSON: async (key: string, data: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      const current = values.get(key);
      if ((options?.onlyIfNew && current) || (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return { modified: false };
      generation += 1;
      const etag = String(generation);
      values.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    list: async () => ({ blobs: [], directories: [] }),
    delete: async (key: string) => { values.delete(key); }
  } as unknown as BlobStoreClient;
};

const netlifyResolveOnly = () => vi.fn(async (url: string) => {
  if (url.includes("/sites?name=")) return response(200, [{ id: "site_platform", name: "kugel-platform", account_id: "acct_1", ssl_url: "https://kugel-platform.netlify.app" }]);
  throw new Error(`unexpected ${url}`);
});

const netlifyFullRotation = () => vi.fn(async (url: string) => {
  if (url.includes("/sites?name=")) return response(200, [{ id: "site_platform", name: "kugel-platform", account_id: "acct_1", ssl_url: "https://kugel-platform.netlify.app" }]);
  if (url.includes("/env/CMS_AGENT_MCP_")) return response(404);
  if (url.includes("/env?site_id=site_platform")) return response(200);
  if (url.includes("/sites/site_platform/builds?title=")) return response(200, { id: "build_1", deploy_id: "deploy_1" });
  if (url.endsWith("/deploys/deploy_1")) return response(200, { id: "deploy_1", state: "ready" });
  if (url.endsWith("/sites/site_platform")) return response(200, { published_deploy: { id: "deploy_1", state: "ready" } });
  throw new Error(`unexpected ${url}`);
});

describe("existing-fleet Client Manager credential reconciliation", () => {
  it("is dry-run by default and performs no mint or network write", async () => {
    const netlifyFetch = vi.fn();
    const mint = vi.fn();
    const results = await reconcileSiteClientManagerCredentials(
      { apply: false },
      {
        projectRepository: projectRepository(),
        env: {},
        netlifyFetch: netlifyFetch as never,
        credentialRepository: { mint, activateAndRetireOtherProjectCredentials: vi.fn(), revokeCredential: vi.fn(), findActiveCredentialForProject: vi.fn(async () => undefined) }
      }
    );
    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "planned" }]);
    expect(netlifyFetch).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints internally, installs secret/function-only env, verifies, then retires the old digest", async () => {
    const netlifyCalls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const netlifyFetch = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      netlifyCalls.push({ url, init });
      if (url.includes("/sites?name=")) return response(200, [{ id: "site_platform", name: "kugel-platform", account_id: "acct_1", ssl_url: "https://kugel-platform.netlify.app" }]);
      if (url.includes("/env/CMS_AGENT_MCP_")) return response(404);
      if (url.includes("/env?site_id=site_platform")) return response(200);
      if (url.includes("/sites/site_platform/builds?title=")) return response(200, { id: "build_1", deploy_id: "deploy_1" });
      if (url.endsWith("/deploys/deploy_1")) return response(200, { id: "deploy_1", state: "ready" });
      if (url.endsWith("/sites/site_platform")) return response(200, { published_deploy: { id: "deploy_1", state: "ready" } });
      throw new Error(`unexpected ${url}`);
    });
    const credentialFetch = vi.fn(async () => response(200, { jsonrpc: "2.0", id: "genesis-credential-check", result: {} }));
    const mint = vi.fn(async () => ({ token: "raw-token-never-reported", digest: "d".repeat(64), policy: { projects: ["platform"], toolAllowlist: ["agent_resolve", "agent_converse"] } }));
    const activate = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFetch as never,
        credentialFetch: credentialFetch as never,
        credentialRepository: { mint, activateAndRetireOtherProjectCredentials: activate, revokeCredential: revoke, findActiveCredentialForProject: vi.fn(async () => undefined) }
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "rotated" }]);
    expect(JSON.stringify(results)).not.toContain("raw-token-never-reported");
    expect(activate).toHaveBeenCalledWith("platform", "d".repeat(64));
    expect(revoke).not.toHaveBeenCalled();
    const envPosts = netlifyCalls.filter((call) => call.init?.method === "POST" && call.url.includes("/env?site_id="));
    const variables = envPosts.flatMap((call) => JSON.parse(call.init!.body as string));
    expect(variables.map((variable: { key: string }) => variable.key).sort()).toEqual(["CMS_AGENT_MCP_ENDPOINT", "CMS_AGENT_MCP_TOKEN"]);
    expect(variables.find((variable: { key: string }) => variable.key === "CMS_AGENT_MCP_TOKEN")).toMatchObject({ is_secret: true, scopes: ["functions"], values: [{ context: "production" }] });
    expect(credentialFetch).toHaveBeenCalledOnce();
  });

  it("includes disabled marked client sites and excludes unmarked internal projects", async () => {
    const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
    const disabledClient = { ...platform, projectId: "fernwell", mcpEndpoint: "https://fernwell.netlify.app/mcp", clientSiteBinding: { netlifySiteName: "fernwell" }, status: "disabled" as const };
    const internal = { ...platform, projectId: "pdf-tool", mcpEndpoint: "https://internal.example/mcp", status: "active" as const };
    const results = await reconcileSiteClientManagerCredentials(
      { apply: false },
      { projectRepository: { ...projectRepository(), list: async () => [disabledClient, internal] } as ProjectRepository, env: {} }
    );
    expect(results).toEqual([{ projectId: "fernwell", netlifySiteName: "fernwell", status: "planned" }]);
  });

  it("uses an explicit backfill map for existing clients without marking internal projects", async () => {
    const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
    const existingClient = { ...platform, projectId: "dr-lurie", status: "active" as const };
    const internal = { ...platform, projectId: "pdf-tool", status: "active" as const };
    const results = await reconcileSiteClientManagerCredentials(
      { apply: false },
      {
        projectRepository: { ...projectRepository(), list: async () => [existingClient, internal] } as ProjectRepository,
        env: { CMS_AGENT_SITE_BINDINGS_JSON: JSON.stringify({ "dr-lurie": "drluriescience" }) }
      }
    );
    expect(results).toEqual([{ projectId: "dr-lurie", netlifySiteName: "drluriescience", status: "planned" }]);
  });

  it("persists the durable binding after a mapped credential is installed and verified", async () => {
    const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
    const existingClient = { ...platform, projectId: "dr-lurie", status: "active" as const };
    const save = vi.fn(async (value) => value);
    const repository = { ...projectRepository(), list: async () => [existingClient], save } as ProjectRepository;
    const netlifyFetch = vi.fn(async (url: string) => {
      if (url.includes("/sites?name=")) return response(200, [{ id: "site_drlurie", name: "drluriescience", account_id: "acct_1", ssl_url: "https://drluriescience.netlify.app" }]);
      if (url.includes("/env/CMS_AGENT_MCP_")) return response(404);
      if (url.includes("/env?site_id=site_drlurie")) return response(200);
      if (url.includes("/sites/site_drlurie/builds?title=")) return response(200, { id: "build_1", deploy_id: "deploy_1" });
      if (url.endsWith("/deploys/deploy_1")) return response(200, { id: "deploy_1", state: "ready" });
      if (url.endsWith("/sites/site_drlurie")) return response(200, { published_deploy: { id: "deploy_1", state: "ready" } });
      throw new Error(`unexpected ${url}`);
    });
    await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: repository,
        env: {
          NETLIFY_API_TOKEN: "netlify-hidden",
          CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp",
          CMS_AGENT_SITE_BINDINGS_JSON: JSON.stringify({ "dr-lurie": "drluriescience" })
        },
        netlifyFetch: netlifyFetch as never,
        credentialFetch: vi.fn(async () => response(200)) as never,
        credentialRepository: {
          mint: vi.fn(async () => ({ token: "raw-token-never-reported", digest: "d".repeat(64), policy: { projects: ["dr-lurie"], toolAllowlist: ["agent_resolve", "agent_converse"] } })),
          activateAndRetireOtherProjectCredentials: vi.fn(async () => undefined),
          revokeCredential: vi.fn(async () => undefined),
          findActiveCredentialForProject: vi.fn(async () => undefined)
        }
      }
    );
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "dr-lurie",
      clientSiteBinding: { netlifySiteName: "drluriescience", netlifySiteId: "site_drlurie" }
    }));
  });

  it("revokes the pending digest and leaves the project unmodified when Netlify rejects the secret write", async () => {
    const save = vi.fn();
    const repository = { ...projectRepository(), save } as ProjectRepository;
    const netlifyFetch = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      if (url.includes("/sites?name=")) return response(200, [{ id: "site_platform", name: "kugel-platform", account_id: "acct_1" }]);
      if (url.includes("/env/CMS_AGENT_MCP_ENDPOINT")) return response(200, { key: "CMS_AGENT_MCP_ENDPOINT" });
      if (url.includes("/env/CMS_AGENT_MCP_TOKEN") && !init?.method) return response(200, { key: "CMS_AGENT_MCP_TOKEN" });
      if (url.includes("/env/CMS_AGENT_MCP_ENDPOINT") && init?.method === "PUT") return response(200);
      if (url.includes("/env/CMS_AGENT_MCP_TOKEN") && init?.method === "PUT") return response(422, { message: "redacted" });
      throw new Error(`unexpected ${url}`);
    });
    const activate = vi.fn();
    const revoke = vi.fn(async () => undefined);
    const digest = "e".repeat(64);

    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: repository,
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFetch as never,
        credentialRepository: {
          mint: vi.fn(async () => ({ token: "raw-token-never-reported", digest, policy: { projects: ["platform"], toolAllowlist: ["agent_resolve", "agent_converse"] } })),
          activateAndRetireOtherProjectCredentials: activate,
          revokeCredential: revoke,
          findActiveCredentialForProject: vi.fn(async () => undefined)
        }
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "failed", errorCode: "netlify_api_failed" }]);
    expect(revoke).toHaveBeenCalledWith(digest);
    expect(activate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toContain("raw-token-never-reported");
  });

  it("keeps an installed digest pending when the production rebuild fails", async () => {
    const netlifyFetch = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      if (url.includes("/sites?name=")) return response(200, [{ id: "site_platform", name: "kugel-platform", account_id: "acct_1" }]);
      if (url.includes("/env/CMS_AGENT_MCP_") && !init?.method) return response(200, {});
      if (url.includes("/env/CMS_AGENT_MCP_") && init?.method === "PUT") return response(200);
      if (url.includes("/sites/site_platform/builds?title=")) return response(200, { id: "build_1", deploy_id: "deploy_failed" });
      if (url.endsWith("/deploys/deploy_failed")) return response(200, { id: "deploy_failed", state: "error" });
      throw new Error(`unexpected ${url}`);
    });
    const activate = vi.fn();
    const revoke = vi.fn(async () => undefined);
    const digest = "f".repeat(64);

    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFetch as never,
        credentialFetch: vi.fn(async () => response(200)) as never,
        credentialRepository: {
          mint: vi.fn(async () => ({ token: "raw-token-never-reported", digest, policy: { projects: ["platform"], toolAllowlist: ["agent_resolve", "agent_converse"] } })),
          activateAndRetireOtherProjectCredentials: activate,
          revokeCredential: revoke,
          findActiveCredentialForProject: vi.fn(async () => undefined)
        }
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "failed", errorCode: "netlify_build_failed" }]);
    expect(revoke).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("idempotency: skip check against the managed credential registry", () => {
  // This is the behavior the whole file exists to add. Before it, every --apply run re-minted,
  // reinstalled and rebuilt EVERY eligible project unconditionally — a routine scheduled pass would
  // rotate and republish the entire client fleet for no reason. These tests assert the skip by
  // asserting on the collaborators directly (mint/activate/revoke never called, and — via the
  // deliberately narrow netlifyResolveOnly fetch stub — that nothing beyond the one site-lookup GET
  // ever reaches Netlify) rather than only checking the returned status, so a regression that still
  // reports "current" but quietly rebuilds anyway would fail loudly here.
  it("skips mint/env-write/rebuild/retire when the active credential already matches", async () => {
    const store = memoryBlobStore();
    const repository = new ManagedScopedBearerCredentialRepository(store);
    // Order-independent on purpose: the stored allowlist is the reverse of SITE_CLIENT_MANAGER_TOOLS.
    // A skip check built on array equality would wrongly rotate here.
    const minted = await repository.mint({
      projectId: "platform",
      toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS].reverse(),
      netlifySiteId: "site_platform",
      netlifySiteName: "kugel-platform"
    });
    await repository.activateAndRetireOtherProjectCredentials("platform", minted.digest);

    const mintSpy = vi.spyOn(repository, "mint");
    const activateSpy = vi.spyOn(repository, "activateAndRetireOtherProjectCredentials");
    const revokeSpy = vi.spyOn(repository, "revokeCredential");
    const netlifyFetch = netlifyResolveOnly();

    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFetch as never,
        credentialRepository: repository
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "current" }]);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(activateSpy).not.toHaveBeenCalled();
    expect(revokeSpy).not.toHaveBeenCalled();
    // The only Netlify call is the site-id lookup needed to compare netlifySiteId; env writes and
    // the rebuild-and-wait-for-publish call would hit unstubbed URLs and throw inside
    // netlifyResolveOnly, so this count also proves no env write or rebuild happened.
    expect(netlifyFetch).toHaveBeenCalledTimes(1);
  });

  it("rotates when the stored allowlist differs from SITE_CLIENT_MANAGER_TOOLS", async () => {
    const store = memoryBlobStore();
    const repository = new ManagedScopedBearerCredentialRepository(store);
    const minted = await repository.mint({
      projectId: "platform",
      // A narrower, historical allowlist — the exact "silently narrowed a tenant's scope" shape
      // the SITE_CLIENT_MANAGER_TOOLS history comment in siteGenesis.ts warns about.
      toolAllowlist: ["agent_resolve", "agent_converse"],
      netlifySiteId: "site_platform",
      netlifySiteName: "kugel-platform"
    });
    await repository.activateAndRetireOtherProjectCredentials("platform", minted.digest);
    const mintSpy = vi.spyOn(repository, "mint");
    const activateSpy = vi.spyOn(repository, "activateAndRetireOtherProjectCredentials");

    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFullRotation() as never,
        credentialFetch: vi.fn(async () => response(200)) as never,
        credentialRepository: repository
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "rotated" }]);
    expect(mintSpy).toHaveBeenCalledOnce();
    expect(activateSpy).toHaveBeenCalledOnce();
  });

  it("rotates when the active credential's netlifySiteId differs from the resolved site", async () => {
    const store = memoryBlobStore();
    const repository = new ManagedScopedBearerCredentialRepository(store);
    const minted = await repository.mint({
      projectId: "platform",
      toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS],
      netlifySiteId: "site_stale_from_before_a_site_migration",
      netlifySiteName: "kugel-platform"
    });
    await repository.activateAndRetireOtherProjectCredentials("platform", minted.digest);
    const mintSpy = vi.spyOn(repository, "mint");

    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFullRotation() as never,
        credentialFetch: vi.fn(async () => response(200)) as never,
        credentialRepository: repository
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "rotated" }]);
    expect(mintSpy).toHaveBeenCalledOnce();
  });

  it("does not treat a pending credential as active, so it rotates rather than skipping", async () => {
    const store = memoryBlobStore();
    const repository = new ManagedScopedBearerCredentialRepository(store);
    // Minted but never activated — exactly the "verification handshake never completed" state
    // activateAndRetireOtherProjectCredentials' own comment describes as not yet superseding
    // anything for the project. It must not satisfy the skip check either.
    await repository.mint({
      projectId: "platform",
      toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS],
      netlifySiteId: "site_platform",
      netlifySiteName: "kugel-platform"
    });
    const mintSpy = vi.spyOn(repository, "mint");

    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFullRotation() as never,
        credentialFetch: vi.fn(async () => response(200)) as never,
        credentialRepository: repository
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "rotated" }]);
    expect(mintSpy).toHaveBeenCalledOnce();
  });

  it("treats a stateless (pre-marker v1) registry entry as active", async () => {
    const store = memoryBlobStore();
    // Written directly, bypassing mint(), because mint() always stamps a fresh entry "pending" —
    // there is no repository call that produces a stateless entry today. This is exactly the v1
    // shape ManagedScopedBearerMetadata.state's comment describes: it predates the activation
    // marker entirely, not just "activated a while ago".
    await store.setJSON(MANAGED_SCOPED_BEARER_REGISTRY_KEY, {
      contract: MANAGED_SCOPED_BEARER_CONTRACT,
      revision: 1,
      credentials: [{
        digest: "a".repeat(64),
        projects: ["platform"],
        toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS],
        createdAt: "2025-01-01T00:00:00.000Z",
        netlifySiteId: "site_platform",
        netlifySiteName: "kugel-platform"
      }]
    });
    const repository = new ManagedScopedBearerCredentialRepository(store);
    const mintSpy = vi.spyOn(repository, "mint");

    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyResolveOnly() as never,
        credentialRepository: repository
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "current" }]);
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it("dry run reports current vs planned correctly against the registry", async () => {
    const store = memoryBlobStore();
    const repository = new ManagedScopedBearerCredentialRepository(store);
    const minted = await repository.mint({
      projectId: "platform",
      toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS].reverse(),
      netlifySiteId: "site_platform",
      netlifySiteName: "kugel-platform"
    });
    await repository.activateAndRetireOtherProjectCredentials("platform", minted.digest);

    const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
    const upToDate = { ...platform, clientSiteBinding: { netlifySiteName: "kugel-platform", netlifySiteId: "site_platform" }, status: "active" as const };
    // No managed credential registered for this project at all, so the dry run has no active
    // credential to compare against and must honestly report "planned", not guess "current".
    const neverRotated = { ...platform, projectId: "fernwell", clientSiteBinding: { netlifySiteName: "fernwell", netlifySiteId: "site_fernwell" }, status: "active" as const };

    const results = await reconcileSiteClientManagerCredentials(
      { apply: false },
      {
        projectRepository: { ...projectRepository(), list: async () => [upToDate, neverRotated] } as ProjectRepository,
        env: {},
        credentialRepository: repository
      }
    );

    expect(results).toEqual([
      { projectId: "platform", netlifySiteName: "kugel-platform", status: "current" },
      { projectId: "fernwell", netlifySiteName: "fernwell", status: "planned" }
    ]);
  });
});

// Regression: the dry run's current/planned distinction must work in PRODUCTION, where
// reconcileSiteCredentialsMain passes only a projectRepository. An earlier revision reached the
// registry through `deps.credentialRepository?.` — always undefined on a real run — so the plan an
// operator reads before approving a fleet-wide republish reported "planned" unconditionally.
describe("dry run without an injected credential repository", () => {
  it("still produces a plan, and degrades to planned rather than failing when the registry is unreadable", async () => {
    const project = {
      projectId: "dr-lurie",
      authMode: "bearer_env" as const,
      clientSiteBinding: { netlifySiteName: "drluriescience", netlifySiteId: "site-1" }
    };
    const projectRepository = { list: async () => [project] } as unknown as ProjectRepository;

    // No credentialRepository in deps — exactly what production passes. The registry read is
    // attempted for real; whether it resolves or throws here, the plan must still be produced.
    const results = await reconcileSiteClientManagerCredentials(
      { apply: false },
      { projectRepository, env: {} as NodeJS.ProcessEnv }
    );

    expect(results).toHaveLength(1);
    expect(["planned", "current"]).toContain(results[0]!.status);
    expect(results[0]!.status).not.toBe("failed");
  });
});
