import { handleMcpJsonRpc } from "../../src/agent/mcp/workspace/server.js";

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

const isAuthorized = (headers: Record<string, string | undefined>) => {
  const expected = process.env.MCP_API_TOKEN;
  if (!expected) return false;
  const authorization = headers.authorization ?? headers.Authorization;
  return authorization === `Bearer ${expected}`;
};

export const handler = async (event: { httpMethod: string; body: string | null; headers: Record<string, string | undefined> }) => {
  if (event.httpMethod !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });
  if (!isAuthorized(event.headers)) return json(401, { error: { code: "unauthorized", message: "Missing or invalid bearer token." } });

  try {
    const rawBody = event.body ? JSON.parse(event.body) : {};
    if (Array.isArray(rawBody)) {
      const responses = await Promise.all(rawBody.map((message) => handleMcpJsonRpc(message)));
      return json(200, responses);
    }
    return json(200, await handleMcpJsonRpc(rawBody));
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: { code: "invalid_json", message: "Request body must be valid JSON." } });
    return json(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Unknown error" } });
  }
};
