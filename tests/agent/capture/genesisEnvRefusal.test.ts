import { describe, expect, it, vi } from "vitest";
import {
  NETLIFY_DEFAULT_ENV_SCOPES,
  NETLIFY_SECRET_FORBIDDEN_SCOPES,
  NetlifyGenesisClient,
  SiteGenesisRefusal,
  netlifyEnvRemedy,
  netlifyEnvScopesFor,
  safeNetlifyErrorMessage
} from "../../../src/agent/capture/siteGenesis.js";

// A2.1 / A2.4 (2026-09-15) — THE LIVE 422, AND WHY IT WAS UNREADABLE.
//
// The mint of genesis-lab-3 answered `netlify_api_failed: POST /api/v1/accounts/<id>/env failed:
// HTTP 422` and left a half-born tenant. Two separate defects in one line:
//   1. The WRITE was illegal. NETLIFY_AUTH_TOKEN is the one secret this driver writes on the DEFAULT
//      scope set, and that set contains post_processing, which Netlify forbids on a secret value.
//   2. The REFUSAL named nothing. redactErrorBody threw away Netlify's body, so the key, the reason
//      and the way out were all absent — which is why finding the key took a live env-var read.
// Both are pinned here: the sanitizer makes the write legal, and the classifier makes any future
// refusal say which key and what to do.

type Call = { url: string; init?: Record<string, unknown> };
const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

describe("A2.1 — a secret env var may never carry the post_processing scope", () => {
  it("netlifyEnvScopesFor drops the forbidden scope for secrets and leaves non-secrets alone", () => {
    expect(netlifyEnvScopesFor([...NETLIFY_DEFAULT_ENV_SCOPES], true)).toEqual({
      scopes: ["builds", "functions", "runtime"],
      dropped: ["post_processing"]
    });
    // The whole point of keeping `builds`: the tenant repo's postbuild tracking step reads these at
    // BUILD time, so narrowing to functions-only is the live drluriescience bug.
    expect(netlifyEnvScopesFor([...NETLIFY_DEFAULT_ENV_SCOPES], true).scopes).toContain("builds");
    expect(netlifyEnvScopesFor([...NETLIFY_DEFAULT_ENV_SCOPES], false)).toEqual({ scopes: [...NETLIFY_DEFAULT_ENV_SCOPES], dropped: [] });
    expect(NETLIFY_SECRET_FORBIDDEN_SCOPES).toEqual(["post_processing"]);
  });

  it("live setEnvVar posts the sanitized scope set for a secret written on the defaults", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if ((init?.method ?? "GET") === "GET") return jsonResponse(404, {});
      return jsonResponse(201, {});
    });
    const client = new NetlifyGenesisClient("live", "tok", fetchImpl as never);
    // This is the EXACT call the fleet loop makes: isSecret, no scopes, no contexts.
    await client.setEnvVar("acct_1", "site_1", "NETLIFY_AUTH_TOKEN", "fleet-token-value", { isSecret: true });

    const post = calls.find((call) => call.init?.method === "POST");
    const body = JSON.parse(String(post?.init?.body)) as Array<{ key: string; scopes: string[]; is_secret?: boolean; values: Array<{ context: string }> }>;
    expect(body[0].key).toBe("NETLIFY_AUTH_TOKEN");
    expect(body[0].is_secret).toBe(true);
    expect(body[0].scopes).toEqual(["builds", "functions", "runtime"]);
    expect(body[0].scopes).not.toContain("post_processing");
    expect(body[0].values.map((value) => value.context)).toEqual(["production", "deploy-preview", "branch-deploy"]);

    const recorded = client.actions.find((action) => action.step === "netlify_set_env");
    expect(recorded?.data?.droppedScopes).toEqual(["post_processing"]);
    // Never silently narrowed: the drop is stated in the ledger detail, and the value is not.
    expect(recorded?.detail).toContain("post_processing");
    expect(JSON.stringify(client.actions)).not.toContain("fleet-token-value");
  });
});

describe("A2.4 — netlify_api_failed becomes a structured, actionable refusal", () => {
  const refusalFor = async (status: number, body: unknown, key = "NETLIFY_AUTH_TOKEN", options: Record<string, unknown> = { isSecret: true }) => {
    const fetchImpl = vi.fn(async (_url: string, init?: Record<string, unknown>) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse(404, {});
      return jsonResponse(status, body);
    });
    const client = new NetlifyGenesisClient("live", "tok", fetchImpl as never);
    try {
      await client.setEnvVar("acct_1", "site_1", key, "super-secret-value", options);
    } catch (error) {
      return error as SiteGenesisRefusal;
    }
    throw new Error("expected a refusal");
  };

  it("a 422 on the env POST carries the key, the status and a remedy", async () => {
    const refusal = await refusalFor(422, { code: 422, message: "scopes is invalid" });
    expect(refusal).toBeInstanceOf(SiteGenesisRefusal);
    expect(refusal.code).toBe("netlify_api_failed");
    expect(refusal.key).toBe("NETLIFY_AUTH_TOKEN");
    expect(refusal.step).toBe("netlify_set_env");
    expect(refusal.netlifyStatus).toBe(422);
    expect(refusal.remedy).toBeTruthy();
    expect(refusal.resumable).toBe(true);
    // The old message was `POST /…/env failed: HTTP 422` and nothing else.
    expect(refusal.message).toContain("NETLIFY_AUTH_TOKEN");
    expect(refusal.safeSummary).toContain("NETLIFY_AUTH_TOKEN");
  });

  it("repeats Netlify's own words for a NON-secret write, redacted against the value sent", async () => {
    const refusal = await refusalFor(422, { message: "value genesis-lab-3 is not permitted" }, "TRACKING_PROJECT_ID", {});
    expect(refusal.netlifyMessage).toContain("not permitted");
  });

  it("never repeats the error body for a SECRET write — a PUT body can carry the PREVIOUS value", async () => {
    // The redaction list can only ever hold the value THIS call sent, so on the rotation path
    // (existing key -> PUT) Netlify's echo of values[] could carry a value nothing here can subtract.
    // For a secret the body is therefore dropped outright; the key and the remedy carry the meaning.
    const refusal = await refusalFor(422, { message: "value super-secret-value is not permitted" });
    expect(refusal.netlifyMessage).toBeUndefined();
    expect(JSON.stringify({ message: refusal.message, remedy: refusal.remedy, summary: refusal.safeSummary })).not.toContain("super-secret-value");
  });

  it("remedies are specific per status and cause", () => {
    const base = { isSecret: true, scopes: [...NETLIFY_DEFAULT_ENV_SCOPES], contexts: ["production"], valueEmpty: false };
    expect(netlifyEnvRemedy(422, "NETLIFY_AUTH_TOKEN", undefined, base)).toContain("post_processing");
    expect(netlifyEnvRemedy(422, "NETLIFY_BUILD_HOOK_URL", undefined, { ...base, scopes: ["functions"], valueEmpty: true })).toContain("empty value");
    // The platform #758 suspect: a key derived from a hyphenated slug is not a legal Netlify name.
    expect(netlifyEnvRemedy(422, "NETLIFY_BUILD_HOOK_URL__GENESIS-LAB-3", undefined, { ...base, scopes: ["functions"] })).toContain("legal Netlify env var name");
    expect(netlifyEnvRemedy(401, "TRACKING_PROJECT_ID", undefined, { ...base, isSecret: false })).toContain("NETLIFY_API_TOKEN");
    expect(netlifyEnvRemedy(422, "TRACKING_PROJECT_ID", undefined, { ...base, isSecret: false, contexts: ["all"] })).toContain("PUT");
  });

  it("safeNetlifyErrorMessage truncates and ignores short values", () => {
    expect(safeNetlifyErrorMessage(undefined, [])).toBeUndefined();
    expect(safeNetlifyErrorMessage("a".repeat(600), [])).toHaveLength(401);
    expect(safeNetlifyErrorMessage("value is ab", ["ab"])).toBe("value is ab");
  });
});

describe("A2.2 — the build hook is adopted, never duplicated", () => {
  it("re-running genesis adopts a build hook with the same title", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if (url.endsWith("/build_hooks") && (init?.method ?? "GET") === "GET") {
        return jsonResponse(200, [{ id: "hook_existing", title: "site.duplicate genesis (genesis-lab-3)", url: "https://api.netlify.com/build_hooks/hook_existing" }]);
      }
      throw new Error(`a re-run must not POST a second build hook: ${url}`);
    });
    const client = new NetlifyGenesisClient("live", "tok", fetchImpl as never);
    const hook = await client.createBuildHook("site_1", "site.duplicate genesis (genesis-lab-3)");
    expect(hook.hookId).toBe("hook_existing");
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    expect(client.actions.find((action) => action.step === "netlify_build_hook")?.data?.adopted).toBe(true);
  });

  it("creates the hook when no hook of that title exists", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      if (url.endsWith("/build_hooks") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [{ id: "hook_other", title: "something else" }]);
      if (url.endsWith("/build_hooks")) return jsonResponse(201, { id: "hook_new", url: "https://api.netlify.com/build_hooks/hook_new" });
      throw new Error(`unexpected: ${url}`);
    });
    const client = new NetlifyGenesisClient("live", "tok", fetchImpl as never);
    expect((await client.createBuildHook("site_1", "site.duplicate genesis (genesis-lab-3)")).hookId).toBe("hook_new");
  });
});

// A2.6 (2026-09-15) — WHAT THE LIVE RATE LIMIT TAUGHT.
//
// Three genesis runs inside four minutes rate-limited the account's env API, and ONE 429 produced
// THIRTEEN blockages on a tenant whose environment was completely intact. Two causes, both here:
//   1. `request()` retries 429/5xx with backoff; the three read-before-write PROBES called fetchImpl
//      directly and had no retry at all — the call shape genesis makes most often was the one shape
//      that could not survive a wobble.
//   2. Both callers of the site probe used `.catch(() => false)`, reading "could not ask" as "not
//      set" — and then took a repair path that ROTATES a live tenant's Client Manager bearer.
describe("A2.6 — the existence probe retries, and an unanswered probe is not a 'no'", () => {
  const retryingClient = (statuses: number[]) => {
    const seen: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: Record<string, unknown>) => {
      if ((init?.method ?? "GET") !== "GET") return jsonResponse(201, {});
      const status = statuses[Math.min(call, statuses.length - 1)]!;
      call += 1;
      seen.push(status);
      return jsonResponse(status, {});
    });
    // No real sleeping: the backoff is injected.
    return { client: new NetlifyGenesisClient("live", "tok", fetchImpl as never, async () => {}), seen, calls: () => call };
  };

  it("retries a 429 on the site-scoped probe and answers once Netlify does", async () => {
    const { client, calls } = retryingClient([429, 429, 200]);
    await expect(client.siteEnvVarExists("acct_1", "site_1", "MCP_HTTP_AUTH_TOKEN")).resolves.toBe(true);
    expect(calls()).toBe(3);
  });

  it("retries a 429 on the ACCOUNT probe too", async () => {
    const { client, calls } = retryingClient([429, 200]);
    await expect(client.accountEnvVarExists("acct_1", "TRACKING_SINK_URL")).resolves.toBe(true);
    expect(calls()).toBe(2);
  });

  it("does NOT retry a 404 — that is an answer, not a failure", async () => {
    const { client, calls } = retryingClient([404]);
    await expect(client.siteEnvVarExists("acct_1", "site_1", "PUBLISH_SECRET")).resolves.toBe(false);
    expect(calls()).toBe(1);
  });

  it("refuses rather than guessing when every attempt is rate-limited", async () => {
    const { client, calls } = retryingClient([429]);
    await expect(client.siteEnvVarExists("acct_1", "site_1", "MCP_HTTP_AUTH_TOKEN")).rejects.toThrow(/429/);
    expect(calls()).toBe(3);
  });

  it("setEnvVar's own read-before-write retries too, then writes", async () => {
    const calls: Call[] = [];
    let gets = 0;
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if ((init?.method ?? "GET") === "GET") {
        gets += 1;
        return gets < 3 ? jsonResponse(429, {}) : jsonResponse(404, {});
      }
      return jsonResponse(201, {});
    });
    const client = new NetlifyGenesisClient("live", "tok", fetchImpl as never, async () => {});
    await client.setEnvVar("acct_1", "site_1", "TRACKING_PROJECT_ID", "genesis-lab-3");
    expect(gets).toBe(3);
    // A 404 after the retries means CREATE: the collection POST, not the per-key PUT.
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
  });
});
