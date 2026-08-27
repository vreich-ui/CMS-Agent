/**
 * Conductor Workbench broker — HTTP server.
 *
 * Node built-ins only (node:http, node:crypto, node:fs). No framework. This
 * file wires together config, session, password, policy, mcp, cache, iap,
 * bootstrap and static into the broker's HTTP contract — the WP-04 contract
 * plus Track A's additions (single-origin static serving, IAP identity,
 * JSON-RPC batching + read caching, GET /api/bootstrap).
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, ConfigError, type Config } from "./config.js";
import {
  createSessionToken,
  verifySessionToken,
  refreshSessionToken,
  buildSessionCookie,
  buildClearedSessionCookie,
  parseCookies,
  SESSION_COOKIE_NAME,
  DEFAULT_TTL_MS,
  type SessionPayload,
} from "./session.js";
import { verifyPassword } from "./password.js";
import { checkPolicy, classifyVerb } from "./policy.js";
import { McpClient, McpError, DEFAULT_TIMEOUT_MS, READ_TIMEOUT_MS } from "./mcp.js";
import { ReadCache } from "./cache.js";
import { verifyIapJwt as defaultVerifyIapJwt, type IapVerifyResult } from "./iap.js";
import { composeBootstrap } from "./bootstrap.js";
import { createStaticHandler, type StaticHandler } from "./static.js";
import { accessSecretValue } from "./secrets.js";

const OPERATOR_NAME = "wolf";
const IAP_JWT_HEADER = "x-goog-iap-jwt-assertion";
const MAX_BATCH_SIZE = 25;

// --- Rate limiting for /api/login ------------------------------------------

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

class LoginRateLimiter {
  private attempts = new Map<string, { count: number; windowStart: number }>();

  /** Returns true if this IP is allowed to attempt a login right now. */
  check(ip: string, now: number = Date.now()): boolean {
    const entry = this.attempts.get(ip);
    if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= LOGIN_MAX_ATTEMPTS) return false;
    entry.count += 1;
    return true;
  }

  /** Periodic cleanup so the map doesn't grow unbounded over a long uptime. */
  sweep(now: number = Date.now()): void {
    for (const [ip, entry] of this.attempts) {
      if (now - entry.windowStart >= LOGIN_WINDOW_MS) this.attempts.delete(ip);
    }
  }
}

// --- Small HTTP helpers ------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/** Reads and buffers the full request body exactly once. Empty body -> "". */
async function readRawBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientIp(req: IncomingMessage): string {
  // No trusted proxy configured; socket address is the source of truth.
  return req.socket.remoteAddress ?? "unknown";
}

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Parsed JSON body for POST requests; undefined for GET or empty/invalid bodies. */
  body: unknown;
  bodyWasInvalidJson: boolean;
  /** Set by route handlers so the access log can record which verb was called. */
  setLoggedVerb: (verb: string) => void;
}

/** The operator identity a request carries, regardless of AUTH_MODE. `sessionPayload` is present
 *  only under AUTH_MODE=password (there's a signed cookie to refresh); under `iap` the identity
 *  comes fresh off the verified JWT on every request, so there is nothing to refresh. */
interface OperatorIdentity {
  operator: string;
  sessionPayload?: SessionPayload;
}

export interface BuildServerDeps {
  /** Overridable for tests — verifying a real IAP JWT needs Google's live JWKS endpoint. */
  verifyIapJwt?: (jwt: string, audience: string | undefined) => Promise<IapVerifyResult>;
  cache?: ReadCache;
  staticHandler?: StaticHandler;
}

// --- Server construction -----------------------------------------------------

export function buildServer(config: Config, mcpClient: McpClient, deps: BuildServerDeps = {}) {
  const loginLimiter = new LoginRateLimiter();
  const sweepTimer = setInterval(() => loginLimiter.sweep(), LOGIN_WINDOW_MS).unref();

  const cache = deps.cache ?? new ReadCache({ ttlMs: config.cacheTtlMs });
  const cacheSweepTimer = setInterval(() => cache.sweep(), Math.max(config.cacheTtlMs, 1000)).unref();
  const staticHandler = deps.staticHandler ?? createStaticHandler(config.staticRoot);
  const verifyIapAssertion = deps.verifyIapJwt ?? ((jwt: string, aud: string | undefined) => defaultVerifyIapJwt(jwt, aud));

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && origin === config.allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", config.allowedOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  function getSession(req: IncomingMessage): SessionPayload | null {
    const cookies = parseCookies(req.headers.cookie);
    return verifySessionToken(cookies[SESSION_COOKIE_NAME], config.sessionSecret);
  }

  /** Sliding refresh: attaches a renewed session cookie to the response. Password mode only. */
  function refreshCookie(res: ServerResponse, payload: SessionPayload): void {
    const { token } = refreshSessionToken(payload, config.sessionSecret, DEFAULT_TTL_MS);
    res.setHeader("Set-Cookie", buildSessionCookie(token, DEFAULT_TTL_MS));
  }

  /**
   * Resolves who's asking, the way this deployment is configured to decide that:
   *  - AUTH_MODE=password: the signed session cookie (unchanged WP-04 behavior).
   *  - AUTH_MODE=iap (default): the verified `X-Goog-IAP-JWT-Assertion` header — NOT the plain
   *    `X-Goog-Authenticated-User-Email` header IAP also sets, which is spoofable if this service
   *    is ever reached off-IAP (see iap.ts's header comment). Returns null on any failure to
   *    verify; the caller always turns that into a uniform 401, never a diagnostic of why.
   */
  async function resolveOperator(req: IncomingMessage): Promise<OperatorIdentity | null> {
    if (config.authMode === "password") {
      const payload = getSession(req);
      return payload ? { operator: payload.operator, sessionPayload: payload } : null;
    }
    const raw = req.headers[IAP_JWT_HEADER];
    const jwt = Array.isArray(raw) ? raw[0] : raw;
    if (!jwt) return null;
    const result = await verifyIapAssertion(jwt, config.iapAudience);
    return result.ok ? { operator: result.email } : null;
  }

  async function handleLogin(ctx: RequestContext): Promise<void> {
    const { req, res } = ctx;

    if (config.authMode === "iap") {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: "iap_mode",
          message:
            "This deployment signs you in automatically through Google — there's no password to enter here. If you're stuck on a login screen, make sure you're signed into the right Google account and reload the page.",
        },
      });
      return;
    }

    const ip = clientIp(req);
    if (!loginLimiter.check(ip)) {
      sendJson(res, 429, {
        ok: false,
        error: { code: "rate_limited", message: "Too many login attempts. Try again later." },
      });
      return;
    }

    if (ctx.bodyWasInvalidJson) {
      sendJson(res, 400, { ok: false, error: { code: "bad_request", message: "Invalid request body." } });
      return;
    }

    const password = (ctx.body as { password?: unknown } | undefined)?.password;
    const GENERIC_FAIL = {
      ok: false as const,
      error: { code: "invalid_credentials", message: "Incorrect password." },
    };

    if (typeof password !== "string" || password.length === 0) {
      sendJson(res, 401, GENERIC_FAIL);
      return;
    }

    const valid = await verifyPassword(password, config.operatorPasswordHash);
    if (!valid) {
      sendJson(res, 401, GENERIC_FAIL);
      return;
    }

    const { token } = createSessionToken(OPERATOR_NAME, config.sessionSecret, DEFAULT_TTL_MS);
    sendJson(
      res,
      200,
      { ok: true, operator: OPERATOR_NAME, readOnly: config.readOnly },
      { "Set-Cookie": buildSessionCookie(token, DEFAULT_TTL_MS) }
    );
  }

  function handleLogout(ctx: RequestContext): void {
    sendJson(ctx.res, 200, { ok: true }, { "Set-Cookie": buildClearedSessionCookie() });
  }

  async function handleSession(ctx: RequestContext): Promise<void> {
    const { req, res } = ctx;
    const identity = await resolveOperator(req);
    if (!identity) {
      sendJson(res, 200, { authenticated: false, readOnly: config.readOnly });
      return;
    }
    if (identity.sessionPayload) refreshCookie(res, identity.sessionPayload);
    const probe = await mcpClient.probe();
    sendJson(res, 200, {
      authenticated: true,
      operator: identity.operator,
      readOnly: config.readOnly,
      workspace: { version: probe.workspaceVersion, ok: probe.reachable },
    });
  }

  async function handleHealth(ctx: RequestContext): Promise<void> {
    const probe = await mcpClient.probe();
    sendJson(ctx.res, 200, {
      ok: true,
      mcp: { reachable: probe.reachable, workspaceVersion: probe.workspaceVersion },
    });
  }

  const UNAUTHENTICATED_MESSAGE =
    config.authMode === "iap"
      ? "Google sign-in (IAP) couldn't verify who you are for this request. Reloading the page usually fixes this; if it keeps happening, ask whoever manages this deployment to check IAP is set up in front of it."
      : "No active session. Log in first.";

  /** Runs one verb through policy + the read cache + the upstream MCP client. Used by the classic
   *  single-call /api/mcp path. */
  async function callVerbWithPolicy(
    verb: string,
    args: Record<string, unknown>
  ): Promise<{ ok: true; data: unknown } | { ok: false; status: number; code: string; message: string }> {
    const decision = checkPolicy(verb, config.readOnly);
    if (!decision.allowed) {
      return { ok: false, status: decision.code === "unknown_verb" ? 400 : 403, code: decision.code!, message: decision.message! };
    }

    const cls = classifyVerb(verb);
    const timeoutMs = cls === "read" ? READ_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

    if (cls === "read") {
      const cached = cache.get(verb, args);
      if (cached !== undefined) return { ok: true, data: cached };
    }

    try {
      const data = await mcpClient.callTool(verb, args, timeoutMs);
      if (cls === "read") cache.set(verb, args, data);
      if (cls === "mutating") cache.invalidate();
      return { ok: true, data };
    } catch (err) {
      // A mutating call that threw may still have changed the workspace (e.g. it succeeded
      // upstream but the response was malformed) — invalidate regardless of outcome so a stale
      // read is never handed back after an ambiguous mutation.
      if (cls === "mutating") cache.invalidate();
      const message = err instanceof McpError || err instanceof Error ? err.message : String(err);
      return { ok: false, status: 502, code: "mcp_error", message };
    }
  }

  interface BatchOutcome {
    ok: true;
    data: unknown;
  }
  interface BatchFailure {
    ok: false;
    error: { code: string; message: string; verb: string };
  }

  /** Runs a batch of verb calls as ONE upstream JSON-RPC array request (mcp.ts's
   *  `callToolsBatch`) — policy-denied and cache-hit entries never reach that call at all, so the
   *  upstream batch only ever contains what genuinely needs a network round trip. */
  async function handleMcpBatch(specs: Array<{ verb: string; args: Record<string, unknown> }>): Promise<Array<BatchOutcome | BatchFailure>> {
    const outcomes: Array<BatchOutcome | BatchFailure> = new Array(specs.length);
    const pending: Array<{ index: number; verb: string; args: Record<string, unknown>; cls: "read" | "mutating" }> = [];
    let anyMutatingPending = false;

    specs.forEach((spec, i) => {
      const decision = checkPolicy(spec.verb, config.readOnly);
      if (!decision.allowed) {
        outcomes[i] = { ok: false, error: { code: decision.code!, message: decision.message!, verb: spec.verb } };
        return;
      }
      const cls = classifyVerb(spec.verb) as "read" | "mutating";
      if (cls === "read") {
        const cached = cache.get(spec.verb, spec.args);
        if (cached !== undefined) {
          outcomes[i] = { ok: true, data: cached };
          return;
        }
      } else {
        anyMutatingPending = true;
      }
      pending.push({ index: i, verb: spec.verb, args: spec.args, cls });
    });

    if (pending.length > 0) {
      const timeoutMs = pending.some((p) => p.cls === "mutating") ? DEFAULT_TIMEOUT_MS : READ_TIMEOUT_MS;
      const results = await mcpClient.callToolsBatch(
        pending.map((p) => ({ verb: p.verb, args: p.args })),
        timeoutMs
      );
      results.forEach((r, j) => {
        const p = pending[j]!;
        if (r.ok) {
          if (p.cls === "read") cache.set(p.verb, p.args, r.data);
          outcomes[p.index] = { ok: true, data: r.data };
        } else {
          outcomes[p.index] = { ok: false, error: { code: "mcp_error", message: r.error, verb: p.verb } };
        }
      });
    }

    if (anyMutatingPending) cache.invalidate();
    return outcomes;
  }

  async function handleMcp(ctx: RequestContext): Promise<void> {
    const { req, res } = ctx;
    const identity = await resolveOperator(req);
    if (!identity) {
      sendJson(res, 401, { ok: false, error: { code: "unauthenticated", message: UNAUTHENTICATED_MESSAGE } });
      return;
    }

    if (ctx.bodyWasInvalidJson) {
      sendJson(res, 400, { ok: false, error: { code: "bad_request", message: "Invalid request body." } });
      return;
    }

    const rawBody = ctx.body as { verb?: unknown; args?: unknown; calls?: unknown } | undefined;

    // --- batch path: { calls: [{verb, args?}, ...] } -> { results: [...] } -----------------
    if (rawBody && Array.isArray(rawBody.calls)) {
      const rawCalls = rawBody.calls;
      if (rawCalls.length === 0) {
        sendJson(res, 400, { ok: false, error: { code: "bad_request", message: '"calls" must be a non-empty array.' } });
        return;
      }
      if (rawCalls.length > MAX_BATCH_SIZE) {
        sendJson(res, 400, {
          ok: false,
          error: { code: "bad_request", message: `"calls" has ${rawCalls.length} entries; the limit is ${MAX_BATCH_SIZE}.` },
        });
        return;
      }

      const specs: Array<{ verb: string; args: Record<string, unknown> }> = [];
      for (const raw of rawCalls) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          sendJson(res, 400, { ok: false, error: { code: "bad_request", message: "Each entry in \"calls\" must be an object." } });
          return;
        }
        const entry = raw as { verb?: unknown; args?: unknown };
        if (typeof entry.verb !== "string" || entry.verb.length === 0) {
          sendJson(res, 400, { ok: false, error: { code: "bad_request", message: 'Each entry in "calls" needs a string "verb".' } });
          return;
        }
        if (entry.args !== undefined && (typeof entry.args !== "object" || entry.args === null || Array.isArray(entry.args))) {
          sendJson(res, 400, { ok: false, error: { code: "bad_request", message: `"args" for "${entry.verb}" must be an object if provided.` } });
          return;
        }
        specs.push({ verb: entry.verb, args: (entry.args as Record<string, unknown> | undefined) ?? {} });
      }

      ctx.setLoggedVerb(`batch(${specs.map((s) => s.verb).join(",")})`);
      if (identity.sessionPayload) refreshCookie(res, identity.sessionPayload);

      const results = await handleMcpBatch(specs);
      sendJson(res, 200, { results });
      return;
    }

    // --- classic single-call path: { verb, args? } -> { ok, data } | { ok, error } ---------
    const verb = rawBody?.verb;
    const args = rawBody?.args;

    if (typeof verb !== "string" || verb.length === 0) {
      sendJson(res, 400, { ok: false, error: { code: "bad_request", message: '"verb" is required and must be a string.' } });
      return;
    }
    ctx.setLoggedVerb(verb);

    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      sendJson(res, 400, { ok: false, error: { code: "bad_request", message: '"args" must be an object if provided.' } });
      return;
    }

    if (identity.sessionPayload) refreshCookie(res, identity.sessionPayload);

    const outcome = await callVerbWithPolicy(verb, (args as Record<string, unknown> | undefined) ?? {});
    if (!outcome.ok) {
      sendJson(res, outcome.status, { ok: false, error: { code: outcome.code, message: outcome.message, verb } });
      return;
    }
    sendJson(res, 200, { ok: true, data: outcome.data });
  }

  const BOOTSTRAP_CACHE_KEY = "__bootstrap__";

  async function handleBootstrap(ctx: RequestContext): Promise<void> {
    const { req, res } = ctx;
    const identity = await resolveOperator(req);
    if (!identity) {
      sendJson(res, 401, { ok: false, error: { code: "unauthenticated", message: UNAUTHENTICATED_MESSAGE } });
      return;
    }
    if (identity.sessionPayload) refreshCookie(res, identity.sessionPayload);

    const cached = cache.get(BOOTSTRAP_CACHE_KEY, {});
    if (cached !== undefined) {
      sendJson(res, 200, cached);
      return;
    }

    const response = await composeBootstrap(mcpClient, {
      timeoutMs: READ_TIMEOUT_MS,
      workspaceVersion: String(cache.version),
    });
    cache.set(BOOTSTRAP_CACHE_KEY, {}, response);
    sendJson(res, 200, response);
  }

  const server = createHttpServer((req, res) => {
    const start = process.hrtime.bigint();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://internal");
    const path = url.pathname;

    let loggedVerb: string | undefined;
    const origEnd = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      // Access log: method, path, verb, status, duration. Never bodies/headers/args.
      console.log(
        JSON.stringify({
          method,
          path,
          verb: loggedVerb,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
        })
      );
      return origEnd(...args);
    }) as typeof res.end;

    applyCors(req, res);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    void (async () => {
      try {
        let body: unknown;
        let bodyWasInvalidJson = false;
        if (method === "POST") {
          const raw = await readRawBody(req);
          if (raw.length === 0) {
            body = {};
          } else {
            try {
              body = JSON.parse(raw);
            } catch {
              bodyWasInvalidJson = true;
            }
          }
        }

        const ctx: RequestContext = {
          req,
          res,
          body,
          bodyWasInvalidJson,
          setLoggedVerb: (verb: string) => {
            loggedVerb = verb;
          },
        };

        if (method === "GET" && path === "/api/health") {
          await handleHealth(ctx);
        } else if (method === "GET" && path === "/api/session") {
          await handleSession(ctx);
        } else if (method === "GET" && path === "/api/bootstrap") {
          await handleBootstrap(ctx);
        } else if (method === "POST" && path === "/api/login") {
          await handleLogin(ctx);
        } else if (method === "POST" && path === "/api/logout") {
          handleLogout(ctx);
        } else if (method === "POST" && path === "/api/mcp") {
          await handleMcp(ctx);
        } else if (path.startsWith("/api/")) {
          sendJson(res, 404, { ok: false, error: { code: "not_found", message: `No route for ${method} ${path}.` } });
        } else if (method === "GET") {
          // Single-origin static serving (A1.1): the built SPA, with SPA-route fallback to
          // index.html, for everything that isn't under /api/*.
          staticHandler.serve(path, res);
        } else {
          sendJson(res, 404, { ok: false, error: { code: "not_found", message: `No route for ${method} ${path}.` } });
        }
      } catch (err) {
        console.error("Unhandled request error:", err instanceof Error ? err.message : err);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: { code: "internal_error", message: "Internal server error." } });
        }
      }
    })();
  });

  server.on("close", () => {
    clearInterval(sweepTimer);
    clearInterval(cacheSweepTimer);
  });

  return server;
}

// --- Entry point --------------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}`;
}

if (isMainModule()) {
  void (async () => {
    let config: Config;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`Startup failed: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    // Token custody (A1.2): Secret Manager is the source of truth for a real deploy; the plain
    // env var is the local-dev/MOCK_UPSTREAM fallback config.ts already validated. Resolved once,
    // here, and handed straight to McpClient — it is never written back onto `config`, never
    // logged, and this is the only place in the process that ever sees it read out of Secret
    // Manager.
    let mcpToken = config.mcpToken;
    if (config.mcpTokenSecretRef) {
      const resolved = await accessSecretValue(config.mcpTokenSecretRef);
      if (!resolved.ok) {
        console.error(`Startup failed: could not resolve CMS_AGENT_MCP_TOKEN_SECRET: ${resolved.error}`);
        process.exit(1);
      }
      mcpToken = resolved.value;
    }

    const mcpClient = new McpClient({ url: config.mcpUrl, token: mcpToken, mock: config.mockUpstream });
    const server = buildServer(config, mcpClient);

    server.listen(config.port, () => {
      console.log(
        JSON.stringify({
          event: "startup",
          port: config.port,
          readOnly: config.readOnly,
          authMode: config.authMode,
          mockUpstream: config.mockUpstream,
          allowedOrigin: config.allowedOrigin,
          staticRoot: config.staticRoot ?? null,
          tokenSource: config.mcpTokenSecretRef ? "secret_manager" : "env",
        })
      );
    });

    const shutdown = async () => {
      console.log(JSON.stringify({ event: "shutdown" }));
      await mcpClient.shutdown();
      server.close(() => process.exit(0));
      // Force-exit if close hangs.
      setTimeout(() => process.exit(0), 2000).unref();
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  })();
}
