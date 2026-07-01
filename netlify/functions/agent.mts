import { ZodError } from "zod";
import { validateRequest } from "../../src/agent/runtime/validateRequest.js";
import { getProject } from "../../src/agent/projects/registry.js";
import { runAgent } from "../../src/agent/runtime/runAgent.js";

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

export const handler = async (event: { httpMethod: string; body: string | null }) => {
  if (event.httpMethod !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });

  try {
    const rawBody = event.body ? JSON.parse(event.body) : {};
    const request = validateRequest(rawBody);
    const project = getProject(request.projectId);
    const response = await runAgent(request, project);
    return json(200, response);
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: { code: "invalid_json", message: "Request body must be valid JSON." } });
    if (error instanceof ZodError) return json(400, { error: { code: "validation_error", issues: error.issues } });
    const message = error instanceof Error ? error.message : "Unknown error";
    const statusCode = message.startsWith("Unknown projectId") ? 404 : 500;
    return json(statusCode, { error: { code: statusCode === 404 ? "project_not_found" : "internal_error", message } });
  }
};
