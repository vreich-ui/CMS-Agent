// THE SHARED NETLIFY MCP ADAPTER, EXTRACTED SO ONE FUNCTION NEVER IMPORTS ANOTHER.
//
// WHAT IS ACTUALLY BROKEN, AND WHAT IS NOT. Runs are driven by the Cloud Run planes — the
// cms-agent-mcp service and the executor jobs — and they are healthy; every MCP client and every
// node execution goes there. These Netlify functions are a second, older adapter over the same
// transport-neutral core, and since 2026-08-14 two of them have answered every request with
// HTTP 502:
//
//   Error [ERR_REQUIRE_ESM]: require() of ES Module /var/task/mcp.mts from /var/task/mcp.js
//
// `agent` and `session` on the same site are fine. The one structural difference is that
// workspace-mcp.mts imported its sibling FUNCTION (`import { handler } from "./mcp.mjs"`). A
// cross-function import makes the bundler materialise mcp as a second entry with a CommonJS interop
// wrapper — /var/task/mcp.js — which then require()s the ESM source beside it. Both functions die:
// the importer because its dependency cannot load, and mcp itself because the emitted .js shadows it.
//
// THE CONSEQUENCE THAT MATTERS is not a lost run driver — nothing routes runs here. It is the
// CONDUCTOR WORKBENCH. netlify.toml builds workbench/ with VITE_MCP_TRANSPORT=netlify, so the SPA at
// /workbench/ reaches the workspace through `/api/workspace-mcp` and nothing else
// (workbench/src/api/client.ts). The page loads; every read it attempts 502s. That is the whole
// visible symptom, and it has been the symptom since August 14.
//
// The remedy is structural rather than clever. The shared thing was never "the other function"; it
// was the Netlify request lifecycle around a transport-neutral core. That lifecycle lives here, in
// src/, where both functions import it as an ordinary module and neither is an entry point of the
// other.
//
// This also removes a standing hazard: netlify/functions/*.mts is the ONE directory where a plain
// relative import silently changes how the deployment is built. Nothing in the type system says so,
// which is why the import looked harmless for as long as it did.
import { handleMcpHttp } from "./mcpEndpoint.js";
import type { HeaderMap } from "../../runtime/auth.js";
import { connectLambdaBlobs } from "../../runtime/lambdaBlobs.js";
import { refreshRepositoryManagerForRequest } from "../../runtime/repositories.js";

export type NetlifyMcpEvent = { httpMethod: string; body: string | null; headers: HeaderMap; blobs?: string };

// Connect Lambda-mode Netlify Blobs and refresh the per-request repository manager, then dispatch.
// Blobs MUST be connected before any repository / getStore() call, which is why this is a wrapper
// and not a bare re-export of handleMcpHttp.
export const handleNetlifyMcpRequest = async (event: NetlifyMcpEvent) => {
  connectLambdaBlobs(event);
  refreshRepositoryManagerForRequest();
  return handleMcpHttp({ httpMethod: event.httpMethod, body: event.body, headers: event.headers });
};
