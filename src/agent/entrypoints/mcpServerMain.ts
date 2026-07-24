// Cloud Run MCP Service entrypoint (DIRECTION.md Phase 4a): serves the workspace MCP endpoint and
// OAuth flow — the same control plane as the Netlify Functions — from one long-lived Node process,
// co-located with the GCS state store and Vertex models. Netlify keeps serving its own copy; this
// is an additional plane the UI can switch to, not a replacement.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { HeaderMap } from "../runtime/auth.js";
import { routeControlPlaneRequest, type RouterRequest } from "../mcp/http/controlPlaneRouter.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // MCP tool payloads are small; cap defends against abuse.

// CORS (browser control-plane access). Netlify's mcp.mts adapter serves the same UI it's deployed
// with (same-origin) and has no CORS layer; the Cloud Run Service is the plane a browser reaches
// cross-origin (VITE_CLOUD_RUN_MCP_URL), so CORS lives here rather than in the shared
// controlPlaneRouter/mcpEndpoint core — auth/session/dispatch behavior for non-OPTIONS requests is
// untouched. OPTIONS preflight is answered before any auth check (a preflight carries no
// credentials, so requiring a bearer token here — the pre-fix behavior — fails preflight before the
// real request is ever attempted). Allow-listed origins come from MCP_ALLOWED_ORIGINS
// (comma-separated); unset means an empty allow-list, so every origin is denied by default — no
// wildcard default is shipped. An explicit "*" entry opts an operator into allowing any origin.
const CORS_ALLOWED_METHODS = "POST, OPTIONS";
const CORS_ALLOWED_HEADERS = "authorization, content-type, mcp-session-id, mcp-protocol-version";
const CORS_EXPOSED_HEADERS = "mcp-session-id, mcp-protocol-version";
const CORS_MAX_AGE_SECONDS = "86400";

export const parseAllowedOrigins = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((origin) => origin.trim()).filter((origin) => origin.length > 0);

export const isOriginAllowed = (origin: string | undefined, allowedOrigins: string[]): boolean =>
  !!origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin));

// Headers added to every actual (non-OPTIONS) response when the request's Origin is on the
// allow-list; {} — no CORS headers at all — when it is not, so the browser itself blocks the
// response from being read by script. The origin is always echoed back verbatim (never "*"), even
// when the allow-list contains a literal "*" entry.
export const corsResponseHeaders = (origin: string | undefined, allowedOrigins: string[]): Record<string, string> =>
  isOriginAllowed(origin, allowedOrigins)
    ? { "access-control-allow-origin": origin!, "access-control-expose-headers": CORS_EXPOSED_HEADERS, vary: "origin" }
    : {};

// Headers for an OPTIONS preflight response: the base response headers above plus the
// preflight-only directives (allowed methods/headers, cache duration for the preflight result).
export const corsPreflightHeaders = (origin: string | undefined, allowedOrigins: string[]): Record<string, string> => {
  const base = corsResponseHeaders(origin, allowedOrigins);
  if (!Object.keys(base).length) return {};
  return { ...base, "access-control-allow-methods": CORS_ALLOWED_METHODS, "access-control-allow-headers": CORS_ALLOWED_HEADERS, "access-control-max-age": CORS_MAX_AGE_SECONDS };
};

const normalizeHeaders = (raw: NodeJS.Dict<string | string[]>): HeaderMap => {
  const headers: HeaderMap = {};
  for (const [key, value] of Object.entries(raw)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
  return headers;
};

const readBody = (req: IncomingMessage): Promise<string | null> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { reject(new Error("payload_too_large")); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : null));
  req.on("error", reject);
});

export async function handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin;
  const allowedOrigins = parseAllowedOrigins(process.env.MCP_ALLOWED_ORIGINS);

  // Preflight is answered before touching auth, session, or routing — and before reading the body —
  // so it never depends on (or requires) a bearer token.
  if ((req.method ?? "").toUpperCase() === "OPTIONS") {
    res.writeHead(204, corsPreflightHeaders(origin, allowedOrigins));
    res.end();
    return;
  }

  try {
    const request: RouterRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: normalizeHeaders(req.headers),
      body: await readBody(req)
    };
    const response = await routeControlPlaneRequest(request);
    res.writeHead(response.statusCode, { ...response.headers, ...corsResponseHeaders(origin, allowedOrigins) });
    res.end(response.body);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "payload_too_large";
    res.writeHead(tooLarge ? 413 : 500, { "content-type": "application/json", ...corsResponseHeaders(origin, allowedOrigins) });
    res.end(JSON.stringify({ error: { code: tooLarge ? "payload_too_large" : "internal_error", message: tooLarge ? "Request body exceeds the limit." : "Unhandled server error." } }));
  }
}

export function startMcpServer(port = Number(process.env.PORT ?? 8080)) {
  // Fail fast on store misconfiguration and register the GCS transport before the first request
  // (the repository manager is built lazily, so startup registration is always early enough).
  bootstrapWorkspaceStore();
  const server = createServer((req, res) => { void handleNodeRequest(req, res); });
  server.listen(port, () => console.error(`CMS-Agent MCP control plane listening on :${port} (store=${process.env.WORKSPACE_STORE ?? "memory"})`));

  // Cloud Run sends SIGTERM before reclaiming an instance; stop accepting connections and drain.
  const shutdown = (signal: string) => { console.error(`${signal} received — draining connections.`); server.close(() => process.exit(0)); };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => shutdown(signal));
  return server;
}
