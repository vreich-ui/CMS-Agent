import { handler as mcpHandler } from "./mcp.mjs";
import { AdminSessionError, adminSessionErrorResponse, json, requireAdminSession, type FunctionEvent, type NetlifyFunctionContext } from "../../src/agent/runtime/adminSession.js";
import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";
import { refreshRepositoryManagerForRequest } from "../../src/agent/runtime/repositories.js";

export const handler = async (event: FunctionEvent, context: NetlifyFunctionContext = {}) => {
  // Lambda-mode Netlify Blobs must be connected before any repository / getStore() call.
  connectLambdaBlobs(event);
  refreshRepositoryManagerForRequest();
  if (event.httpMethod !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });

  try {
    const session = requireAdminSession(context);
    return await mcpHandler({
      httpMethod: event.httpMethod,
      body: event.body,
      headers: {
        ...event.headers,
        authorization: `Bearer ${process.env.MCP_API_TOKEN ?? ""}`,
        // Verified-identity attribution for change history: the proxy is the only entry path
        // that has an authenticated human, so it stamps the actor/source headers server-side.
        "x-workspace-actor": JSON.stringify({ kind: "human", id: session.email }),
        "x-workspace-source": "ui"
      },
      blobs: event.blobs
    });
  } catch (error) {
    if (error instanceof AdminSessionError) return adminSessionErrorResponse(error);
    return json(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Unknown error" } });
  }
};
