import { describe, expect, it, vi } from "vitest";
import { NetlifyGenesisClient, SiteGenesisRefusal } from "../../../src/agent/capture/siteGenesis.js";

// T12.11 — the genesis driver's own Netlify API surface, both modes:
//   dry_run — ZERO network; every intended action recorded on the ledger with synthetic ids.
//   live    — request shapes pinned against create-site.mjs's proven patterns (idempotent
//             lookup-then-create site, build-hooks POST, env-var check-then-POST/PUT with the
//             POST-takes-an-ARRAY rule), bearer only ever in the Authorization header, and env
//             values never landing in the ledger.
// No real token exists anywhere near these tests; live mode runs against an injected fetch stub.

type Call = { url: string; init?: Record<string, unknown> };

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("NetlifyGenesisClient", () => {
  it("dry_run mode records every action with synthetic ids and never touches the network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("dry_run must never call fetch");
    });
    const client = new NetlifyGenesisClient("dry_run", "unused-token", fetchImpl as never);
    const site = await client.createSite("acme-site");
    expect(site.siteId).toBe("dryrun_site_acme-site");
    const hook = await client.createBuildHook(site.siteId, "genesis hook");
    expect(hook.hookId).toBe(`dryrun_hook_${site.siteId}`);
    await client.setEnvVar("acct", site.siteId, "TRACKING_PROJECT_ID", "trk_acme");
    await client.rebuildAndWaitForPublishedDeploy(site.siteId);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.actions.map((action) => [action.step, action.kind])).toEqual([
      ["netlify_create_site", "dry_run"],
      ["netlify_build_hook", "dry_run"],
      ["netlify_set_env", "dry_run"],
      ["netlify_credential_rebuild", "dry_run"]
    ]);
    // Names only, never values: the env value must not appear anywhere in the ledger.
    expect(JSON.stringify(client.actions)).not.toContain("trk_acme");
  });

  it("live mode: idempotent site create (lookup first, reuse an existing site by name)", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if (url.startsWith("https://api.netlify.com/api/v1/sites?name=")) {
        return jsonResponse(200, [{ id: "site_123", name: "acme-site", account_id: "acct_1" }]);
      }
      throw new Error(`unexpected: ${url}`);
    });
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never);
    const site = await client.createSite("acme-site");
    expect(site).toMatchObject({ siteId: "site_123", accountId: "acct_1" });
    expect(calls).toHaveLength(1); // no POST when the lookup finds the site
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok_live_test");
  });

  it("live mode: creates the site when the lookup misses, then build hook and env var shapes", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if (url.startsWith("https://api.netlify.com/api/v1/sites?name=")) return jsonResponse(200, []);
      if (url === "https://api.netlify.com/api/v1/sites") return jsonResponse(201, { id: "site_new", account_id: "acct_9" });
      if (url === "https://api.netlify.com/api/v1/sites/site_new/build_hooks") return jsonResponse(201, { id: "hook_7", url: "https://api.netlify.com/build_hooks/hook_7" });
      if (url.startsWith("https://api.netlify.com/api/v1/accounts/acct_9/env/NETLIFY_BUILD_HOOK_URL")) {
        return (init?.method ?? "GET") === "GET" ? jsonResponse(404, {}) : jsonResponse(200, {});
      }
      if (url.startsWith("https://api.netlify.com/api/v1/accounts/acct_9/env?site_id=site_new")) return jsonResponse(200, {});
      throw new Error(`unexpected: ${url}`);
    });
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never);
    const site = await client.createSite("fresh-site");
    expect(site.siteId).toBe("site_new");
    const hook = await client.createBuildHook(site.siteId, "genesis hook");
    expect(hook.url).toBe("https://api.netlify.com/build_hooks/hook_7");
    await client.setEnvVar("acct_9", site.siteId, "NETLIFY_BUILD_HOOK_URL", hook.url!, { isSecret: true });

    const post = calls.find((call) => call.url === "https://api.netlify.com/api/v1/sites")!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ name: "fresh-site" });
    // Env var: missing (404) → POST to the collection with an ARRAY payload, secret-flagged.
    const envPost = calls.find((call) => call.url.includes("/env?site_id=site_new") && call.init?.method === "POST")!;
    const payload = JSON.parse(envPost.init!.body as string);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]).toMatchObject({ key: "NETLIFY_BUILD_HOOK_URL", is_secret: true });
    // The ledger records the NAME only — the capability URL value never lands in the audit trail.
    expect(JSON.stringify(client.actions)).not.toContain("build_hooks/hook_7");
  });

  it("live mode: an existing env var is replaced via PUT with a single object payload", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if (url.includes("/env/TRACKING_PROJECT_ID")) return jsonResponse(200, {});
      throw new Error(`unexpected: ${url}`);
    });
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never);
    await client.setEnvVar("acct_1", "site_123", "TRACKING_PROJECT_ID", "trk_acme");
    const put = calls.find((call) => call.init?.method === "PUT")!;
    const payload = JSON.parse(put.init!.body as string);
    expect(Array.isArray(payload)).toBe(false);
    expect(payload).toMatchObject({ key: "TRACKING_PROJECT_ID" });
  });

  // T21.8 — a Netlify constraint learned live: context "all" includes the `dev` context, and `dev`
  // forbids secret values, so a secret written with context "all" is refused by the API. Secrets are
  // therefore always written as the three contexts they may legally occupy.
  it("live mode: a secret env var is written per-context — production/deploy-preview/branch-deploy, never `all`", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if (url.includes("/env/TRACKING_SINK_TOKEN")) return (init?.method ?? "GET") === "GET" ? jsonResponse(404, {}) : jsonResponse(200, {});
      if (url.includes("/env?site_id=site_123")) return jsonResponse(200, {});
      throw new Error(`unexpected: ${url}`);
    });
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never);
    await client.setEnvVar("acct_1", "site_123", "TRACKING_SINK_TOKEN", "fleet-sink-token", { isSecret: true });

    const post = calls.find((call) => call.init?.method === "POST")!;
    const variable = JSON.parse(post.init!.body as string)[0];
    expect(variable.is_secret).toBe(true);
    expect(variable.values.map((value: { context: string }) => value.context)).toEqual(["production", "deploy-preview", "branch-deploy"]);
    expect(variable.values.map((value: { context: string }) => value.context)).not.toContain("all");
    // Scopes: `builds` is required — the tenant repo's postbuild tracking-dims-push reads the
    // tracking env at BUILD time, and a functions-only scope makes it silently no-op.
    expect(variable.scopes).toContain("builds");
    expect(variable.scopes).toContain("functions");
    // Names, scopes and contexts on the ledger; the value never.
    expect(JSON.stringify(client.actions)).not.toContain("fleet-sink-token");
    expect((client.actions[0].data as { contexts: string[] }).contexts).toEqual(["production", "deploy-preview", "branch-deploy"]);
  });

  it("refuses to write a secret with context `all` rather than letting Netlify answer with an opaque 4xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never);
    const error = await client
      .setEnvVar("acct_1", "site_123", "TRACKING_SINK_TOKEN", "fleet-sink-token", { isSecret: true, context: "all" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SiteGenesisRefusal);
    expect((error as SiteGenesisRefusal).code).toBe("netlify_secret_context_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("live mode: a NON-secret env var still rides context `all` with the default build-inclusive scopes", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if (url.includes("/env/TRACKING_PROJECT_ID")) return jsonResponse(200, {});
      throw new Error(`unexpected: ${url}`);
    });
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never);
    await client.setEnvVar("acct_1", "site_123", "TRACKING_PROJECT_ID", "acme");
    const variable = JSON.parse(calls.find((call) => call.init?.method === "PUT")!.init!.body as string);
    expect(variable.values).toEqual([{ value: "acme", context: "all" }]);
    expect(variable.scopes).toEqual(["builds", "functions", "runtime", "post_processing"]);
    expect(variable.is_secret).toBeUndefined();
  });

  it("schedules an env-refresh build and waits until that exact deploy is published", async () => {
    const calls: Call[] = [];
    const sleep = vi.fn(async () => undefined);
    let deployReads = 0;
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if (url.includes("/sites/site_123/builds?title=")) return jsonResponse(200, { id: "build_1", deploy_id: "deploy_1" });
      if (url.endsWith("/deploys/deploy_1")) {
        deployReads += 1;
        return jsonResponse(200, { id: "deploy_1", state: deployReads === 1 ? "building" : "ready" });
      }
      if (url.endsWith("/sites/site_123")) return jsonResponse(200, { published_deploy: { id: "deploy_1", state: "ready" } });
      throw new Error(`unexpected: ${url}`);
    });
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never, sleep);

    await expect(client.rebuildAndWaitForPublishedDeploy("site_123", { maxAttempts: 3, pollIntervalMs: 1 })).resolves.toEqual({ deployId: "deploy_1" });

    expect(sleep).toHaveBeenCalledOnce();
    expect(calls[0]).toMatchObject({ init: { method: "POST" } });
    expect(JSON.stringify(client.actions)).toContain("netlify_credential_rebuild");
  });
  // A short Netlify degradation used to be indistinguishable from a revoked token: both surfaced as
  // a bare `netlify_api_failed`, and both were terminal. These three pin the split.
  it("live mode: retries a retryable 5xx and succeeds without ever surfacing a refusal", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.startsWith("https://api.netlify.com/api/v1/sites?name=")) throw new Error(`unexpected: ${url}`);
      attempts += 1;
      return attempts < 3
        ? jsonResponse(503, { message: "upstream unavailable" })
        : jsonResponse(200, [{ id: "site_123", name: "acme-site", account_id: "acct_1" }]);
    });
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never, sleep);

    await expect(client.resolveExistingSite("acme-site")).resolves.toMatchObject({ siteId: "site_123", accountId: "acct_1" });
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("live mode: exhausting the retry budget reports METHOD, path and status — never the response body", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => jsonResponse(503, { message: "netlify-internal-detail" }));
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never, sleep);

    const error = await client.resolveExistingSite("acme-site").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SiteGenesisRefusal);
    expect((error as SiteGenesisRefusal).code).toBe("netlify_api_failed");
    expect((error as SiteGenesisRefusal).safeSummary).toBe("GET /api/v1/sites HTTP 503");
    // The summary is the half that gets REPORTED, so it must carry no upstream body and no query
    // string — only what an operator needs to tell a wobble from a refusal.
    expect((error as SiteGenesisRefusal).safeSummary).not.toContain("netlify-internal-detail");
    expect((error as SiteGenesisRefusal).safeSummary).not.toContain("acme-site");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("live mode: refuses a 401 immediately — retrying a credential that will not improve only delays the answer", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => jsonResponse(401, { message: "unauthorized" }));
    const client = new NetlifyGenesisClient("live", "tok_live_test", fetchImpl as never, sleep);

    const error = await client.resolveExistingSite("acme-site").catch((thrown: unknown) => thrown);
    expect((error as SiteGenesisRefusal).safeSummary).toBe("GET /api/v1/sites HTTP 401");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
