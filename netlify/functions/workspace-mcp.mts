// This used to be `import { handler as mcpHandler } from "./mcp.mjs"` — a sibling FUNCTION import,
// which made the bundler emit a CommonJS wrapper (/var/task/mcp.js) that require()d the ESM source
// beside it and 502'd both functions. This one is the Conductor Workbench's only data path, so the
// Workbench has been unable to read the workspace since 2026-08-14. The shared lifecycle is an
// ordinary src/ module now; neither function is an entry point of the other. See netlifyMcpAdapter.ts.
import { handleNetlifyMcpRequest } from "../../src/agent/mcp/http/netlifyMcpAdapter.js";
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
    return await handleNetlifyMcpRequest({
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
