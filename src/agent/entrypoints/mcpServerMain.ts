// Cloud Run MCP Service entrypoint (DIRECTION.md Phase 4a): serves the workspace MCP endpoint and
// OAuth flow — the same control plane as the Netlify Functions — from one long-lived Node process,
// co-located with the GCS state store and Vertex models. Netlify keeps serving its own copy; this
// is an additional plane the UI can switch to, not a replacement.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { HeaderMap } from "../runtime/auth.js";
import { routeControlPlaneRequest, type RouterRequest } from "../mcp/http/controlPlaneRouter.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // MCP tool payloads are small; cap defends against abuse.

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
  try {
    const request: RouterRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: normalizeHeaders(req.headers),
      body: await readBody(req)
    };
    const response = await routeControlPlaneRequest(request);
    res.writeHead(response.statusCode, response.headers);
    res.end(response.body);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "payload_too_large";
    res.writeHead(tooLarge ? 413 : 500, { "content-type": "application/json" });
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
