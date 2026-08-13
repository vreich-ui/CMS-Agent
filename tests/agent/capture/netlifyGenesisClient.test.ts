import { describe, expect, it, vi } from "vitest";
import { NetlifyGenesisClient } from "../../../src/agent/capture/siteGenesis.js";

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
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.actions.map((action) => [action.step, action.kind])).toEqual([
      ["netlify_create_site", "dry_run"],
      ["netlify_build_hook", "dry_run"],
      ["netlify_set_env", "dry_run"]
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
});
