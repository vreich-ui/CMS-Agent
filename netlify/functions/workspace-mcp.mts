import { handler as mcpHandler } from "./mcp.mjs";
import { AdminSessionError, adminSessionErrorResponse, json, requireAdminSession, type FunctionEvent, type NetlifyFunctionContext } from "../../src/agent/runtime/adminSession.js";

export const handler = async (event: FunctionEvent, context: NetlifyFunctionContext = {}) => {
  if (event.httpMethod !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });

  try {
    requireAdminSession(context);
    return await mcpHandler({
      httpMethod: event.httpMethod,
      body: event.body,
      headers: { ...event.headers, authorization: `Bearer ${process.env.MCP_API_TOKEN ?? ""}` }
    });
  } catch (error) {
    if (error instanceof AdminSessionError) return adminSessionErrorResponse(error);
    return json(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Unknown error" } });
  }
};
