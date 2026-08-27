import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildServer, type BuildServerDeps } from "./index.js";
import { McpClient } from "./mcp.js";
import { hashPassword } from "./password.js";
import type { Config } from "./config.js";
import type { IapVerifyResult } from "./iap.js";

const PASSWORD = "correct-horse-battery-staple";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    sessionSecret: "s".repeat(32),
    operatorPasswordHash: "scrypt$16384$8$1$c2FsdA$aGFzaA", // overwritten per-test where login matters
    mcpUrl: "http://mock.invalid/mcp",
    mcpToken: "mock-token",
    mcpTokenSecretRef: "",
    readOnly: true,
    allowedOrigin: "http://localhost:5173",
    mockUpstream: true,
    authMode: "password",
    iapAudience: undefined,
    cacheTtlMs: 20_000,
    staticRoot: undefined,
    ...overrides,
  };
}

async function startServer(configOverrides: Partial<Config> = {}, deps: BuildServerDeps = {}) {
  const passwordHash = await hashPassword(PASSWORD);
  const config: Config = baseConfig({ operatorPasswordHash: passwordHash, ...configOverrides });
  const mcpClient = new McpClient({ url: config.mcpUrl, token: config.mcpToken, mock: true });
  const server = buildServer(config, mcpClient, deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return { server, base, config };
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header");
  return setCookie!.split(";")[0]!;
}

test("smoke: full HTTP surface — health, login, session, mcp, logout", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  await t.test("GET /api/health reports mcp reachability before login", async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; mcp: { reachable: boolean; workspaceVersion: string } };
    assert.equal(body.ok, true);
    assert.equal(body.mcp.reachable, true);
  });

  await t.test("GET /api/session reports unauthenticated with no cookie", async () => {
    const res = await fetch(`${base}/api/session`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authenticated: boolean; readOnly: boolean };
    assert.equal(body.authenticated, false);
    assert.equal(body.readOnly, true);
  });

  await t.test("POST /api/mcp without a session is rejected with 401", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verb: "workflow_list_runs" }),
    });
    assert.equal(res.status, 401);
  });

  await t.test("POST /api/login with wrong password fails with generic 401", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "definitely-wrong" }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { ok: boolean; error: { message: string } };
    assert.equal(body.ok, false);
    assert.doesNotMatch(body.error.message.toLowerCase(), /account|user|not found/);
  });

  let cookie = "";

  await t.test("POST /api/login with correct password succeeds and sets cookie", async () => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; operator: string; readOnly: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.operator, "wolf");
    assert.equal(body.readOnly, true);
    cookie = extractSessionCookie(res);
    assert.match(cookie, /^cw_session=/);
  });

  await t.test("GET /api/session with cookie reports authenticated", async () => {
    const res = await fetch(`${base}/api/session`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authenticated: boolean; operator?: string; workspace?: { ok: boolean } };
    assert.equal(body.authenticated, true);
    assert.equal(body.operator, "wolf");
    assert.equal(body.workspace?.ok, true);
  });

  await t.test("POST /api/mcp with a read verb succeeds", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ verb: "workflow_list_runs", args: {} }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; data: { mock: boolean; verb: string } };
    assert.equal(body.ok, true);
    assert.equal(body.data.mock, true);
    assert.equal(body.data.verb, "workflow_list_runs");
  });

  await t.test("POST /api/mcp with a mutating verb is blocked 403 under READ_ONLY", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ verb: "workflow_pause_run", args: { runId: "r1" } }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "read_only");
    assert.match(body.error.message, /read-only mode/i);
  });

  await t.test("POST /api/mcp with an unknown verb is blocked 400 default-deny", async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ verb: "delete_the_database" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "unknown_verb");
  });

  await t.test("POST /api/logout clears the cookie", async () => {
    const res = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
    assert.equal(res.status, 200);
    const cleared = res.headers.get("set-cookie");
    assert.ok(cleared);
    assert.match(cleared!, /Max-Age=0/);
  });

  await t.test("GET /api/session after logout (stale cookie discarded by client) is unauthenticated", async () => {
    // Simulate the browser having dropped the cookie per Max-Age=0.
    const res = await fetch(`${base}/api/session`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authenticated: boolean };
    assert.equal(body.authenticated, false);
  });
});

test("smoke: CORS reflects only the configured ALLOWED_ORIGIN", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const allowed = await fetch(`${base}/api/health`, { headers: { origin: "http://localhost:5173" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");

  const disallowed = await fetch(`${base}/api/health`, { headers: { origin: "http://evil.example" } });
  assert.equal(disallowed.headers.get("access-control-allow-origin"), null);
});

// --- Track A additions -------------------------------------------------------

test("smoke: GET / with no STATIC_ROOT configured is a clean 404, not a crash", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 404);
});

test("smoke: AUTH_MODE=iap — no header is unauthenticated, a verified assertion authenticates as its own email", async (t) => {
  let sawHeaderJwt = "";
  const fakeVerify = async (jwt: string, _aud: string | undefined): Promise<IapVerifyResult> => {
    sawHeaderJwt = jwt;
    if (jwt === "good-assertion") return { ok: true, email: "wolf@example.com", payload: {} };
    return { ok: false, error: "bad assertion" };
  };
  const { server, base } = await startServer({ authMode: "iap" }, { verifyIapJwt: fakeVerify });
  t.after(() => server.close());

  const noHeader = await fetch(`${base}/api/session`);
  assert.equal((await noHeader.json() as { authenticated: boolean }).authenticated, false);

  const denied = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verb: "workflow_list_runs" }),
  });
  assert.equal(denied.status, 401);

  const authed = await fetch(`${base}/api/session`, { headers: { "X-Goog-IAP-JWT-Assertion": "good-assertion" } });
  const authedBody = (await authed.json()) as { authenticated: boolean; operator?: string };
  assert.equal(authedBody.authenticated, true);
  assert.equal(authedBody.operator, "wolf@example.com");
  assert.equal(sawHeaderJwt, "good-assertion");

  const badJwt = await fetch(`${base}/api/session`, { headers: { "X-Goog-IAP-JWT-Assertion": "forged" } });
  assert.equal((await badJwt.json() as { authenticated: boolean }).authenticated, false);
});

test("smoke: AUTH_MODE=iap — /api/login is disabled with an operator-worded explanation, not a password check", async (t) => {
  const fakeVerify = async (): Promise<IapVerifyResult> => ({ ok: false, error: "n/a" });
  const { server, base } = await startServer({ authMode: "iap" }, { verifyIapJwt: fakeVerify });
  t.after(() => server.close());

  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "iap_mode");
  assert.doesNotMatch(body.error.message.toLowerCase(), /env|auth_mode/);
});

test("smoke: POST /api/mcp batch — mixed allow/deny verbs come back in order, one HTTP 200, per-item envelopes", async (t) => {
  const { server, base } = await startServer({ readOnly: true });
  t.after(() => server.close());

  const loginRes = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      calls: [
        { verb: "workflow_list_runs", args: {} },
        { verb: "workflow_pause_run", args: { runId: "r1" } }, // blocked: READ_ONLY
        { verb: "not_a_real_verb" }, // blocked: unknown
        { verb: "tool_list" },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { results: Array<{ ok: boolean; data?: unknown; error?: { code: string } }> };
  assert.equal(body.results.length, 4);
  assert.equal(body.results[0]!.ok, true);
  assert.equal(body.results[1]!.ok, false);
  assert.equal(body.results[1]!.error!.code, "read_only");
  assert.equal(body.results[2]!.ok, false);
  assert.equal(body.results[2]!.error!.code, "unknown_verb");
  assert.equal(body.results[3]!.ok, true);
});

test("smoke: POST /api/mcp batch requires an authenticated session, same as the single-call path", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ calls: [{ verb: "workflow_list_runs" }] }),
  });
  assert.equal(res.status, 401);
});

test("smoke: GET /api/bootstrap returns the composed shape and requires auth", async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const noAuth = await fetch(`${base}/api/bootstrap`);
  assert.equal(noAuth.status, 401);

  const loginRes = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

  const res = await fetch(`${base}/api/bootstrap`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  for (const key of ["workflows", "graphs", "nodeSummaries", "recentRuns", "attention", "workspaceVersion", "capturedAt"]) {
    assert.ok(key in body, `bootstrap response missing "${key}"`);
  }
});

test("smoke: read verbs are cached for repeat calls; a mutating call invalidates the cache", async (t) => {
  let upstreamToolCalls = 0;
  const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { name?: string } };
    if (parsed.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }), {
        status: 200,
        headers: { "mcp-session-id": "sess-1", "content-type": "application/json" },
      });
    }
    if (parsed.method === "notifications/initialized") {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    upstreamToolCalls += 1;
    const ok = parsed.params?.name !== "workflow_pause_run" ? { ok: true, data: { call: upstreamToolCalls } } : { ok: true, data: {} };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [{ type: "text", text: JSON.stringify(ok) }] } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const passwordHash = await hashPassword(PASSWORD);
  const config = baseConfig({ operatorPasswordHash: passwordHash, mockUpstream: false, readOnly: false });
  const mcpClient = new McpClient({ url: config.mcpUrl, token: "t", fetchImpl: fetchStub });
  const server = buildServer(config, mcpClient);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => server.close());

  const loginRes = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
  const call = () =>
    fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ verb: "workflow_list_runs", args: {} }),
    }).then((r) => r.json() as Promise<{ ok: boolean; data: { call: number } }>);

  const first = await call();
  const second = await call();
  assert.equal(first.data.call, second.data.call, "second call should be served from cache, same upstream call number");
  assert.equal(upstreamToolCalls, 1);

  // A mutating call invalidates the cache — the next read must hit upstream again.
  await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ verb: "workflow_pause_run", args: { runId: "r1" } }),
  });
  assert.equal(upstreamToolCalls, 2);

  const third = await call();
  assert.equal(upstreamToolCalls, 3);
  assert.notEqual(third.data.call, first.data.call);
});
