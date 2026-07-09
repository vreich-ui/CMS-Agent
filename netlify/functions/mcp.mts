import { handleMcpJsonRpc } from "../../src/agent/mcp/workspace/server.js";
import { hasBearerToken, unauthorizedResponse, type HeaderMap } from "../../src/agent/runtime/auth.js";
import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";
import { refreshRepositoryManagerForRequest } from "../../src/agent/runtime/repositories.js";

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

const empty = (statusCode: number) => ({
  statusCode,
  headers: {},
  body: ""
});

const isMcpNotification = (message: unknown) => {
  const request = message as { id?: unknown; method?: unknown };
  return request.id === undefined && typeof request.method === "string" && request.method.startsWith("notifications/");
};

export const handler = async (event: { httpMethod: string; body: string | null; headers: HeaderMap; blobs?: string }) => {
  // Lambda-mode Netlify Blobs must be connected before any repository / getStore() call.
  connectLambdaBlobs(event);
  refreshRepositoryManagerForRequest();
  if (event.httpMethod !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });
  // TODO: Replace workspace bearer tokens with authenticated user sessions and passthrough project credentials.
  if (!hasBearerToken(event.headers, process.env.MCP_API_TOKEN)) return json(401, unauthorizedResponse);

  try {
    const rawBody = event.body ? JSON.parse(event.body) : {};
    if (Array.isArray(rawBody)) {
      const calls = rawBody.filter((message) => !isMcpNotification(message));
      if (calls.length === 0) return empty(202);
      const responses = await Promise.all(calls.map((message) => handleMcpJsonRpc(message)));
      return json(200, responses);
    }
    if (isMcpNotification(rawBody)) return empty(202);
    return json(200, await handleMcpJsonRpc(rawBody));
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: { code: "invalid_json", message: "Request body must be valid JSON." } });
    return json(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Unknown error" } });
  }
};
