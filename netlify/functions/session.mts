import { AdminSessionError, adminSessionErrorResponse, json, requireAdminSession, type FunctionEvent, type NetlifyFunctionContext } from "../../src/agent/runtime/adminSession.js";

export const handler = async (event: FunctionEvent, context: NetlifyFunctionContext = {}) => {
  if (event.httpMethod !== "GET") return json(405, { error: { code: "method_not_allowed", message: "Use GET." } });

  try {
    return json(200, requireAdminSession(context));
  } catch (error) {
    if (error instanceof AdminSessionError) return adminSessionErrorResponse(error);
    return json(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Unknown error" } });
  }
};
