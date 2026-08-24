import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildServer } from "./index.js";
import { McpClient } from "./mcp.js";
import { hashPassword } from "./password.js";
import type { Config } from "./config.js";

const PASSWORD = "correct-horse-battery-staple";

async function startServer() {
  const passwordHash = await hashPassword(PASSWORD);
  const config: Config = {
    port: 0,
    sessionSecret: "s".repeat(32),
    operatorPasswordHash: passwordHash,
    mcpUrl: "http://mock.invalid/mcp",
    mcpToken: "mock-token",
    readOnly: true,
    allowedOrigin: "http://localhost:5173",
    mockUpstream: true,
  };
  const mcpClient = new McpClient({ url: config.mcpUrl, token: config.mcpToken, mock: true });
  const server = buildServer(config, mcpClient);
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
    assert.match(body.error.message, /READ_ONLY/);
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
