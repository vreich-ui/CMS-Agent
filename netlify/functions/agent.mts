import { ZodError } from "zod";
import { validateRequest } from "../../src/agent/runtime/validateRequest.js";
import { getProject, ProjectNotFoundError } from "../../src/agent/projects/agentProfiles.js";
import { runAgent } from "../../src/agent/runtime/runAgent.js";
import { hasBearerToken, unauthorizedResponse, type HeaderMap } from "../../src/agent/runtime/auth.js";
import { connectLambdaBlobs } from "../../src/agent/runtime/lambdaBlobs.js";
import { refreshRepositoryManagerForRequest } from "../../src/agent/runtime/repositories.js";

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

export const handler = async (event: { httpMethod: string; body: string | null; headers: HeaderMap; blobs?: string }) => {
  // Lambda-mode Netlify Blobs must be connected before any repository / getStore() call.
  connectLambdaBlobs(event);
  refreshRepositoryManagerForRequest();
  if (event.httpMethod !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });
  // TODO: Replace workspace bearer tokens with authenticated user sessions and passthrough project credentials.
  if (!hasBearerToken(event.headers, process.env.AGENT_API_TOKEN)) return json(401, unauthorizedResponse);

  try {
    const rawBody = event.body ? JSON.parse(event.body) : {};
    const request = validateRequest(rawBody);
    const project = getProject(request.projectId);
    const response = await runAgent(request, project);
    return json(200, response);
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: { code: "invalid_json", message: "Request body must be valid JSON." } });
    if (error instanceof ZodError) return json(400, { error: { code: "validation_error", issues: error.issues } });
    if (error instanceof ProjectNotFoundError) return json(404, { error: { code: error.code, message: error.message } });
    const message = error instanceof Error ? error.message : "Unknown error";
    return json(500, { error: { code: "internal_error", message } });
  }
};
