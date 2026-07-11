import { handleMcpJsonRpc } from "../../src/agent/mcp/workspace/server.js";
import type { WorkspaceToolContext } from "../../src/agent/mcp/workspace/tools.js";
import { workspaceActorKinds, workspaceChangeSources, type WorkspaceActor, type WorkspaceChangeSource } from "../../src/agent/workspace/changeTypes.js";
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

// Attribution context for change history. The secure proxy (workspace-mcp) stamps a verified
// human actor via these headers after identity checks; direct bearer-token callers default to an
// agent actor. This is attribution, not authorization — a bearer holder could self-describe.
const parseActorHeader = (value: string | undefined): WorkspaceActor | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { kind?: unknown; id?: unknown; label?: unknown };
    if (typeof parsed?.kind !== "string" || !(workspaceActorKinds as readonly string[]).includes(parsed.kind)) return undefined;
    return {
      kind: parsed.kind as WorkspaceActor["kind"],
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      label: typeof parsed.label === "string" ? parsed.label : undefined
    };
  } catch {
    return undefined;
  }
};

const parseSourceHeader = (value: string | undefined): WorkspaceChangeSource | undefined =>
  value && (workspaceChangeSources as readonly string[]).includes(value) ? value as WorkspaceChangeSource : undefined;

const buildToolContext = (headers: HeaderMap): WorkspaceToolContext => ({
  actor: parseActorHeader(headers["x-workspace-actor"]) ?? { kind: "agent" },
  source: parseSourceHeader(headers["x-workspace-source"]) ?? "mcp",
  requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
});

export const handler = async (event: { httpMethod: string; body: string | null; headers: HeaderMap; blobs?: string }) => {
  // Lambda-mode Netlify Blobs must be connected before any repository / getStore() call.
  connectLambdaBlobs(event);
  refreshRepositoryManagerForRequest();
  if (event.httpMethod !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });
  // TODO: Replace workspace bearer tokens with authenticated user sessions and passthrough project credentials.
  if (!hasBearerToken(event.headers, process.env.MCP_API_TOKEN)) return json(401, unauthorizedResponse);

  try {
    const context = buildToolContext(event.headers);
    const rawBody = event.body ? JSON.parse(event.body) : {};
    if (Array.isArray(rawBody)) {
      const calls = rawBody.filter((message) => !isMcpNotification(message));
      if (calls.length === 0) return empty(202);
      const responses = await Promise.all(calls.map((message) => handleMcpJsonRpc(message, context)));
      return json(200, responses);
    }
    if (isMcpNotification(rawBody)) return empty(202);
    return json(200, await handleMcpJsonRpc(rawBody, context));
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: { code: "invalid_json", message: "Request body must be valid JSON." } });
    return json(500, { error: { code: "internal_error", message: error instanceof Error ? error.message : "Unknown error" } });
  }
};
