/**
 * Conductor Workbench broker — HTTP server.
 *
 * Node built-ins only (node:http, node:crypto). No framework. This file
 * wires together config, session, password, policy and mcp into the fixed
 * HTTP contract described in the WP-04 brief.
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
import { checkPolicy } from "./policy.js";
import { McpClient, McpError } from "./mcp.js";

const OPERATOR_NAME = "wolf";

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

// --- Server construction -----------------------------------------------------

export function buildServer(config: Config, mcpClient: McpClient) {
  const loginLimiter = new LoginRateLimiter();
  const sweepTimer = setInterval(() => loginLimiter.sweep(), LOGIN_WINDOW_MS).unref();

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

  /** Sliding refresh: attaches a renewed session cookie to the response. */
  function refreshCookie(res: ServerResponse, payload: SessionPayload): void {
    const { token } = refreshSessionToken(payload, config.sessionSecret, DEFAULT_TTL_MS);
    res.setHeader("Set-Cookie", buildSessionCookie(token, DEFAULT_TTL_MS));
  }

  async function handleLogin(ctx: RequestContext): Promise<void> {
    const { req, res } = ctx;
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
    const payload = getSession(req);
    if (!payload) {
      sendJson(res, 200, { authenticated: false, readOnly: config.readOnly });
      return;
    }
    refreshCookie(res, payload);
    const probe = await mcpClient.probe();
    sendJson(res, 200, {
      authenticated: true,
      operator: payload.operator,
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

  async function handleMcp(ctx: RequestContext): Promise<void> {
    const { req, res } = ctx;
    const payload = getSession(req);
    if (!payload) {
      sendJson(res, 401, {
        ok: false,
        error: { code: "unauthenticated", message: "No active session. Log in first." },
      });
      return;
    }

    if (ctx.bodyWasInvalidJson) {
      sendJson(res, 400, { ok: false, error: { code: "bad_request", message: "Invalid request body." } });
      return;
    }

    const verb = (ctx.body as { verb?: unknown } | undefined)?.verb;
    const args = (ctx.body as { args?: unknown } | undefined)?.args;

    if (typeof verb !== "string" || verb.length === 0) {
      sendJson(res, 400, { ok: false, error: { code: "bad_request", message: '"verb" is required and must be a string.' } });
      return;
    }
    ctx.setLoggedVerb(verb);

    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      sendJson(res, 400, { ok: false, error: { code: "bad_request", message: '"args" must be an object if provided.' } });
      return;
    }

    const decision = checkPolicy(verb, config.readOnly);
    if (!decision.allowed) {
      const status = decision.code === "unknown_verb" ? 400 : 403;
      sendJson(res, status, { ok: false, error: { code: decision.code, message: decision.message, verb } });
      return;
    }

    refreshCookie(res, payload);

    try {
      const data = await mcpClient.callTool(verb, (args as Record<string, unknown>) ?? {});
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      // Surface the backend's own error text verbatim; never a generic message.
      const message = err instanceof McpError || err instanceof Error ? err.message : String(err);
      sendJson(res, 502, { ok: false, error: { code: "mcp_error", message, verb } });
    }
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
        } else if (method === "POST" && path === "/api/login") {
          await handleLogin(ctx);
        } else if (method === "POST" && path === "/api/logout") {
          handleLogout(ctx);
        } else if (method === "POST" && path === "/api/mcp") {
          await handleMcp(ctx);
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

  server.on("close", () => clearInterval(sweepTimer));

  return server;
}

// --- Entry point --------------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}`;
}

if (isMainModule()) {
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

  const mcpClient = new McpClient({ url: config.mcpUrl, token: config.mcpToken, mock: config.mockUpstream });
  const server = buildServer(config, mcpClient);

  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        event: "startup",
        port: config.port,
        readOnly: config.readOnly,
        mockUpstream: config.mockUpstream,
        allowedOrigin: config.allowedOrigin,
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
}
