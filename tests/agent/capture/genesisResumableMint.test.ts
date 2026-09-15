import { describe, expect, it, vi } from "vitest";
import { runSiteGenesis } from "../../../src/agent/capture/siteGenesis.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";

// A2.2 ACCEPTANCE (2026-09-15) — GENESIS MUST SURVIVE ITS OWN FAILURE.
//
// THE INCIDENT. `site_duplicate {newSite: genesis-lab-3}` created a Netlify site, wrote two env vars,
// got HTTP 422 on the third and threw. What it left: a live site with a build-hook-less, secret-less,
// bearer-less configuration, NO registry record at all (`project_test_connection` → "Unknown
// projectId"), and a tool error that named no key. Nine steps that would have succeeded never ran.
//
// WHAT THIS FILE PINS, both halves of the mandate:
//   1. A 422 on ONE key does not stop the other keys, and the record exists — as "provisioning" —
//      with a blockage that names the key and the remedy.
//   2. A mint interrupted after site creation COMPLETES on re-run, with zero duplicate resources and
//      no credential rotation.
//
// Live Netlify mode against an injected API stub that holds real state; no token and no network.

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/** An in-memory project registry, same shape the other genesis tests use. */
const memoryProjectRepository = (): ProjectRepository => {
  const records = new Map<string, ProjectConnectionConfig>();
  return {
    get: async (projectId: string) => records.get(projectId),
    list: async () => [...records.values()],
    save: async (config: ProjectConnectionConfig) => {
      records.set(config.projectId, config);
      return config;
    },
    delete: async (projectId: string) => {
      records.delete(projectId);
    }
  } as unknown as ProjectRepository;
};

/**
 * A Netlify API that behaves like one: sites and env vars are state, so a SECOND genesis run against
 * the same stub sees exactly what the first one left behind. That is the only way to test resumption
 * honestly — a stub that answers statelessly cannot tell adoption from duplication.
 */
const netlifyApi = ({ refuseEnvKeys = new Set<string>(), buildHooksFail = false, rateLimitKeys = new Set<string>() }: { refuseEnvKeys?: Set<string>; buildHooksFail?: boolean; rateLimitKeys?: Set<string> } = {}) => {
  const sites: Array<Record<string, unknown>> = [];
  const hooks: Array<Record<string, unknown>> = [];
  const siteEnv = new Map<string, unknown>();
  const calls: Array<{ method: string; url: string }> = [];

  const impl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });

    if (url.startsWith("https://api.netlify.com/api/v1/sites?name=")) {
      const name = decodeURIComponent(url.split("name=")[1]!);
      return json(200, sites.filter((site) => site.name === name));
    }
    if (url === "https://api.netlify.com/api/v1/sites" && method === "POST") {
      const name = String((JSON.parse(String(init?.body)) as { name: string }).name);
      const site = { id: `site_${name}`, name, account_id: "acct_1", ssl_url: `https://${name}.netlify.app` };
      sites.push(site);
      return json(201, site);
    }
    if (url.endsWith("/build_hooks")) {
      if (method === "GET") return json(200, hooks);
      if (buildHooksFail) return json(422, { message: "build hooks unavailable" });
      const title = String((JSON.parse(String(init?.body)) as { title: string }).title);
      const hook = { id: `hook_${hooks.length + 1}`, title, url: `https://api.netlify.com/build_hooks/hook_${hooks.length + 1}` };
      hooks.push(hook);
      return json(201, hook);
    }
    if (url.includes("/env")) {
      const [path, query] = url.split("?");
      const scopedToSite = (query ?? "").includes("site_id=");
      const keyed = /\/env\/([^?]+)$/.exec(path!);
      // A2.6: a persistent 429 on ONE key's probe — the live failure shape.
      if (keyed && rateLimitKeys.has(decodeURIComponent(keyed[1]!))) return json(429, { message: "rate limited" });
      if (keyed && method === "GET") {
        // No site id = the ACCOUNT collection. This team provides nothing account-wide in this test,
        // which is the honest shape: the inherited sink pair is a checklist item, not a blockage.
        if (!scopedToSite) return json(404, {});
        return siteEnv.has(decodeURIComponent(keyed[1]!)) ? json(200, {}) : json(404, {});
      }
      if (keyed && method === "PUT") {
        const key = decodeURIComponent(keyed[1]!);
        if (refuseEnvKeys.has(key)) return json(422, { message: `${key} is invalid` });
        siteEnv.set(key, JSON.parse(String(init?.body)));
        return json(200, {});
      }
      if (method === "POST") {
        const [variable] = JSON.parse(String(init?.body)) as Array<{ key: string }>;
        if (refuseEnvKeys.has(variable.key)) return json(422, { message: `${variable.key} is invalid` });
        siteEnv.set(variable.key, variable);
        return json(201, {});
      }
    }
    // Single-site GET (account id lookup, build-settings read).
    const single = /\/api\/v1\/sites\/([^/?]+)$/.exec(url);
    if (single && method === "GET") {
      return json(200, sites.find((site) => site.id === single[1]) ?? { id: single[1], account_id: "acct_1", build_settings: {} });
    }
    throw new Error(`unexpected Netlify call: ${method} ${url}`);
  });

  return {
    impl: impl as never,
    calls,
    /** Put a site into this stub's world without going through the API — what run 2 inherits. */
    seedSite: (name: string) => {
      sites.push({ id: `site_${name}`, name, account_id: "acct_1", ssl_url: `https://${name}.netlify.app` });
    },
    envKeys: () => [...siteEnv.keys()].sort(),
    siteCount: () => sites.length,
    hookCount: () => hooks.length,
    // Exact URL: the build-hooks path also contains "/api/v1/sites".
    siteCreatePosts: () => calls.filter((call) => call.method === "POST" && call.url === "https://api.netlify.com/api/v1/sites").length
  };
};

/** A credential repository that remembers what it minted, so a re-run can be seen to adopt it. */
const credentialRepository = () => {
  let active: { digest: string } | undefined;
  const minted: string[] = [];
  return {
    mint: async () => {
      const digest = `digest_${minted.length + 1}`;
      minted.push(digest);
      return { token: `bearer_${digest}`, digest };
    },
    activateAndRetireOtherProjectCredentials: async (_projectId: string, digest: string) => {
      active = { digest };
    },
    revokeCredential: async () => {},
    findActiveCredentialForProject: async () => active,
    mintCount: () => minted.length
  };
};

const baseEnv = (): NodeJS.ProcessEnv => ({
  NETLIFY_API_TOKEN: "netlify-test-token",
  SITE_GENESIS_NETLIFY_MODE: "live",
  CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp",
  // The one fleet-shared value this deployment holds — and the secret whose DEFAULT scope set
  // contained post_processing, which is what Netlify refused on the live mint (A2.1).
  NETLIFY_AUTH_TOKEN: "fleet-netlify-token"
  // GENESIS_SECRET_MANAGER_PROJECT deliberately unset: bearer custody then stays a checklist item
  // rather than reaching Secret Manager, which keeps this test hermetic.
});

const mint = async (
  repository: ProjectRepository,
  api: ReturnType<typeof netlifyApi>,
  credentials: ReturnType<typeof credentialRepository>,
  env: NodeJS.ProcessEnv = baseEnv()
) =>
  runSiteGenesis(
    { name: "genesis-lab-3", niche: "senior and aging pets", audience: "owners of aging dogs", ownerEmail: "vreich@kugelbrands.com" } as never,
    {
      projectRepository: repository,
      env,
      netlifyFetch: api.impl,
      credentialFetch: (async () => json(200, {})) as never,
      credentialRepository: credentials as never
    } as never
  );

describe("A2.2 — a 422 on one key does not stop the other keys", () => {
  it("records a blockage naming the key, writes every other key, and leaves the record provisioning", async () => {
    const repository = memoryProjectRepository();
    const api = netlifyApi({ refuseEnvKeys: new Set(["PDF_TOOL_STORAGE_SITE_ID"]) });
    const result = await mint(repository, api, credentialRepository());

    // ONE blockage, and it names the key and carries a remedy — the whole A2.4 contract, in situ.
    expect(result.blockages).toHaveLength(1);
    expect(result.blockages[0]).toMatchObject({ step: "netlify_set_env", key: "PDF_TOOL_STORAGE_SITE_ID", code: "netlify_api_failed", resumable: true });
    expect(result.blockages[0].remedy).toBeTruthy();

    // Every key AFTER the refused one was still written. Before A2.2 the mint stopped at the first 422.
    expect(api.envKeys()).toEqual([
      "ADMIN_EMAILS",
      "ARTIFACT_UPLOAD_TOKEN_SECRET",
      "ARTIFACT_URL_INGEST_ALLOWED_HOSTS",
      "CMS_AGENT_MCP_ENDPOINT",
      "CMS_AGENT_MCP_TOKEN",
      "NETLIFY_AUTH_TOKEN",
      "NETLIFY_BUILD_HOOK_URL",
      "NETLIFY_SITE_ID",
      "PUBLISH_SECRET",
      "ROLE_EMAILS_ADMIN",
      "TRACKING_PROJECT_ID",
      "TRACKING_SALT"
    ]);

    // The record EXISTS — the genesis-lab-3 incident left none — and says it is not finished.
    const record = await repository.get("genesis-lab-3");
    expect(record?.status).toBe("provisioning");
    expect(result.status).toBe("provisioning");
    expect(record?.clientSiteBinding).toMatchObject({ netlifySiteName: "kugel-genesis-lab-3", netlifySiteNameSource: "derived" });

    // And the checklist leads with the blockage, naming the env var.
    const blocked = result.humanChecklist.find((item) => item.id.startsWith("blocked_"));
    expect(result.humanChecklist[0]).toBe(blocked);
    expect(blocked?.envVars).toEqual(["PDF_TOOL_STORAGE_SITE_ID"]);
    expect(blocked?.detail).toContain("re-run");
  });

  it("promotes the record to active when nothing blocks", async () => {
    const repository = memoryProjectRepository();
    const result = await mint(repository, netlifyApi(), credentialRepository());
    expect(result.blockages).toEqual([]);
    expect(result.status).toBe("active");
    expect((await repository.get("genesis-lab-3"))?.status).toBe("active");
  });

  it("writes NETLIFY_AUTH_TOKEN — the live 422 — without the post_processing scope", async () => {
    const repository = memoryProjectRepository();
    const api = netlifyApi();
    const result = await mint(repository, api, credentialRepository());
    expect(result.blockages).toEqual([]);
    const write = result.ledger.find((action) => action.step === "netlify_set_env" && (action.data as { key?: string }).key === "NETLIFY_AUTH_TOKEN");
    expect((write?.data as { scopes?: string[] }).scopes).toEqual(["builds", "functions", "runtime"]);
    expect((write?.data as { droppedScopes?: string[] }).droppedScopes).toEqual(["post_processing"]);
  });
});

describe("A2.2 — a mint interrupted after site creation completes on re-run", () => {
  it("adopts the site, the hook, the env vars and the record, duplicating nothing and rotating nothing", async () => {
    const repository = memoryProjectRepository();
    const credentials = credentialRepository();

    // RUN 1 — the site is created, then the build hook is unavailable. This is the genesis-lab-3
    // shape: real infrastructure, an incomplete tenant.
    const broken = netlifyApi({ buildHooksFail: true });
    const first = await mint(repository, broken, credentials);
    expect(first.blockages.map((blockage) => blockage.step)).toContain("netlify_build_hook");
    expect(first.status).toBe("provisioning");
    expect(broken.siteCount()).toBe(1);

    // RUN 2 — the identical call, against a healthy API that still holds run 1's state.
    const healthy = netlifyApi();
    // Run 2's world already contains the site run 1 created — that is what makes it a RE-run.
    healthy.seedSite("kugel-genesis-lab-3");

    const second = await mint(repository, healthy, credentials);

    expect(second.blockages).toEqual([]);
    expect(second.status).toBe("active");
    expect((await repository.get("genesis-lab-3"))?.status).toBe("active");

    // ZERO DUPLICATE RESOURCES: no second Netlify site, exactly one build hook.
    expect(healthy.siteCount()).toBe(1);
    expect(healthy.siteCreatePosts()).toBe(0);
    expect(healthy.hookCount()).toBe(1);

    // The record was ADOPTED, not re-created — createProject would have refused project_exists, which
    // is precisely what made the old half-born tenant unrepairable.
    expect(second.ledger.filter((action) => action.step === "register_project_provisional")).toHaveLength(1);
  });

  it("does not rotate the Client Manager bearer on a re-run that finds one installed", async () => {
    const repository = memoryProjectRepository();
    const credentials = credentialRepository();
    const api = netlifyApi();

    await mint(repository, api, credentials);
    expect(credentials.mintCount()).toBe(1);

    // Second run: an ACTIVE registered credential AND a CMS_AGENT_MCP_TOKEN on the site. Re-minting
    // would install a value the live site only picks up on its next deploy — breaking a tenant that
    // currently works.
    const second = await mint(repository, api, credentials);
    expect(credentials.mintCount()).toBe(1);
    const credentialStep = second.ledger.find((action) => action.step === "cms_agent_client_manager_credential");
    expect(credentialStep?.data).toMatchObject({ rotated: false, adopted: true });
  });
});

describe("A2.2 — the honest-status invariants the first pass got wrong", () => {
  it("treats a refused object-store secret as a blockage, not a quiet checklist line", async () => {
    // PUBLISH_SECRET missing IS the genesis-lab-2 failure: every object verb on the tenant answers
    // "Server-side object storage credentials are not configured". A tenant in that state must never
    // read as "active".
    const repository = memoryProjectRepository();
    const result = await mint(repository, netlifyApi({ refuseEnvKeys: new Set(["PUBLISH_SECRET"]) }), credentialRepository());
    expect(result.blockages.map((blockage) => [blockage.step, blockage.key])).toContainEqual(["tenant_object_store_env", "PUBLISH_SECRET"]);
    expect(result.status).toBe("provisioning");
    expect((await repository.get("genesis-lab-3"))?.status).toBe("provisioning");
  });

  it("never silently promotes a tenant whose bearer is in custody but absent from the site", async () => {
    // Run 1's secret write landed and its SITE write did not. The old skip branch keyed on
    // tokenSecretRef alone, so every re-run declined to repair, recorded nothing, and promoted the
    // tenant to "active" with no bearer on it.
    const repository = memoryProjectRepository();
    await repository.save({
      projectId: "genesis-lab-3",
      name: "genesis-lab-3",
      mcpEndpointEnvVar: "GENESIS_LAB_3_MCP_ENDPOINT",
      authMode: "bearer_env",
      tokenSecretRef: "projects/cms-agent-503015/secrets/genesis-lab-3-mcp-token/versions/latest",
      allowedTools: [],
      contentContract: { contentContract: "content_source.v1" },
      publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "", autonomyMode: "autonomous" },
      status: "provisioning"
    } as unknown as ProjectConnectionConfig);

    const result = await runSiteGenesis(
      { name: "genesis-lab-3", niche: "senior and aging pets", audience: "owners of aging dogs" } as never,
      {
        projectRepository: repository,
        env: baseEnv(),
        netlifyFetch: netlifyApi().impl,
        credentialFetch: (async () => json(200, {})) as never,
        credentialRepository: credentialRepository() as never,
        // No Google metadata server here, so the stored value cannot be read back — which is the
        // honest worst case and must still refuse to promote.
        secretFetch: (async () => {
          throw new Error("no metadata server in tests");
        }) as never
      } as never
    );

    expect(result.blockages.map((blockage) => blockage.code)).toContain("tenant_token_unreadable");
    expect(result.status).toBe("provisioning");
    // And it did NOT mint a replacement: that would strand the value CMS-Agent already holds.
    expect(result.ledger.find((action) => action.step === "tenant_mcp_token_custody")?.data?.rotated).toBe(false);
  });

  it("re-mints nothing and creates no site when the record is already bound to a differently-named site", async () => {
    // A tenant bound to `genesis-lab-3` (pre-convention) must not be re-homed to `kugel-genesis-lab-3`
    // by a resume — that would orphan the site, env vars, hook and secrets the first run installed.
    const repository = memoryProjectRepository();
    await repository.save({
      projectId: "genesis-lab-3",
      name: "genesis-lab-3",
      clientSiteBinding: { netlifySiteName: "genesis-lab-3", netlifySiteId: "site_genesis-lab-3", netlifySiteNameSource: "derived" },
      mcpEndpointEnvVar: "GENESIS_LAB_3_MCP_ENDPOINT",
      authMode: "bearer_env",
      tokenEnvVar: "GENESIS_LAB_3_MCP_TOKEN",
      allowedTools: [],
      contentContract: { contentContract: "content_source.v1" },
      publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "", autonomyMode: "autonomous" },
      status: "provisioning"
    } as unknown as ProjectConnectionConfig);

    const api = netlifyApi();
    api.seedSite("genesis-lab-3");
    const result = await mint(repository, api, credentialRepository());
    expect(result.netlifySiteName).toBe("genesis-lab-3");
    expect(api.siteCreatePosts()).toBe(0);
    expect((await repository.get("genesis-lab-3"))?.clientSiteBinding?.netlifySiteName).toBe("genesis-lab-3");
  });

  it("still ABORTS when a minted bearer can be neither installed nor revoked", async () => {
    // Continuing there would leave a live, registered scoped bearer nobody intended — a security
    // regression, not a blockage. This is the one refusal `attempt` must re-throw.
    const repository = memoryProjectRepository();
    const credentials = {
      mint: async () => ({ token: "bearer_x", digest: "digest_x" }),
      activateAndRetireOtherProjectCredentials: async () => {},
      revokeCredential: async () => {
        throw new Error("store unavailable");
      },
      findActiveCredentialForProject: async () => undefined
    };
    await expect(
      runSiteGenesis(
        { name: "genesis-lab-3", niche: "senior and aging pets", audience: "owners of aging dogs" } as never,
        {
          projectRepository: repository,
          env: baseEnv(),
          netlifyFetch: netlifyApi().impl,
          // The credential verification refuses, which is what sends genesis into the revoke path.
          credentialFetch: (async () => json(401, {})) as never,
          credentialRepository: credentials as never
        } as never
      )
    ).rejects.toThrow(/credential_cleanup_failed/);
  });
});

describe("A2.6 — an unanswerable probe changes nothing", () => {
  it("does not rotate the Client Manager bearer when the site probe is rate-limited", async () => {
    const repository = memoryProjectRepository();
    const credentials = credentialRepository();

    // Run 1: clean.
    const healthy = netlifyApi();
    await mint(repository, healthy, credentials);
    expect(credentials.mintCount()).toBe(1);

    // Run 2: the CMS_AGENT_MCP_TOKEN probe is 429 on every attempt. Reading that as "absent" would
    // mint a replacement and retire the digest the live site is serving.
    const limited = netlifyApi({ rateLimitKeys: new Set(["CMS_AGENT_MCP_TOKEN"]) });
    limited.seedSite("kugel-genesis-lab-3");
    const second = await mint(repository, limited, credentials);

    expect(credentials.mintCount()).toBe(1);
    expect(second.blockages.map((blockage) => [blockage.code, blockage.key])).toContainEqual([
      "netlify_probe_unanswered",
      "CMS_AGENT_MCP_TOKEN"
    ]);
    const credentialStep = second.ledger.find((action) => action.step === "cms_agent_client_manager_credential");
    expect(credentialStep?.data).toMatchObject({ rotated: false, adopted: true, probe: "unanswered" });
    // The RUN did not finish; the record keeps "active" because this tenant was already active and a
    // transient wobble must not demote a live tenant. Two fields, two true statements.
    expect(second.mintComplete).toBe(false);
    expect(second.status).toBe("active");
  });

  it("does not re-push the tenant bearer when its probe is rate-limited", async () => {
    const repository = memoryProjectRepository();
    await repository.save({
      projectId: "genesis-lab-3",
      name: "genesis-lab-3",
      clientSiteBinding: { netlifySiteName: "kugel-genesis-lab-3", netlifySiteId: "site_kugel-genesis-lab-3", netlifySiteNameSource: "derived" },
      mcpEndpointEnvVar: "GENESIS_LAB_3_MCP_ENDPOINT",
      authMode: "bearer_env",
      tokenSecretRef: "projects/cms-agent-503015/secrets/genesis-lab-3-mcp-token/versions/latest",
      allowedTools: [],
      contentContract: { contentContract: "content_source.v1" },
      publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "", autonomyMode: "autonomous" },
      status: "provisioning"
    } as unknown as ProjectConnectionConfig);

    const limited = netlifyApi({ rateLimitKeys: new Set(["MCP_HTTP_AUTH_TOKEN"]) });
    limited.seedSite("kugel-genesis-lab-3");
    const result = await mint(repository, limited, credentialRepository());

    expect(result.blockages.map((blockage) => [blockage.code, blockage.key])).toContainEqual([
      "netlify_probe_unanswered",
      "MCP_HTTP_AUTH_TOKEN"
    ]);
    const custody = result.ledger.find((action) => action.step === "tenant_mcp_token_custody");
    expect(custody?.data).toMatchObject({ rotated: false, probe: "unanswered" });
    expect(result.status).toBe("provisioning");
  });
});
