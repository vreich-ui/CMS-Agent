// Thin Netlify adapter over the transport-neutral MCP endpoint core
// (src/agent/mcp/http/mcpEndpoint.ts), mirroring the OAuth function adapters. Netlify-specific
// request lifecycle (connect Lambda Blobs, refresh the per-request repository manager) lives here;
// all auth/session/dispatch logic is shared with the Cloud Run MCP Service.
import { handleMcpHttp } from "../../src/agent/mcp/http/mcpEndpoint.js";
import type { HeaderMap } from "../../src/agent/runtime/auth.js";
import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";
import { refreshRepositoryManagerForRequest } from "../../src/agent/runtime/repositories.js";

export const handler = async (event: { httpMethod: string; body: string | null; headers: HeaderMap; blobs?: string }) => {
  // Lambda-mode Netlify Blobs must be connected before any repository / getStore() call.
  connectLambdaBlobs(event);
  refreshRepositoryManagerForRequest();
  return handleMcpHttp({ httpMethod: event.httpMethod, body: event.body, headers: event.headers });
};
