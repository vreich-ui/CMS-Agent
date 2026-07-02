import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/agent.mjs";

const body = { projectId: "project-a", workflow: "publish_only", input: "Draft this", dryRun: true };

const event = (token?: string) => ({
  httpMethod: "POST",
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body)
});

describe("agent endpoint authentication", () => {
  beforeEach(() => {
    process.env.AGENT_API_TOKEN = "agent-test-token";
  });

  it("rejects requests without bearer authorization", async () => {
    const response = await handler(event());
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("unauthorized");
  });

  it("rejects requests with an invalid bearer token", async () => {
    const response = await handler(event("wrong-token"));
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe("unauthorized");
  });

  it("runs agent workflows with a valid bearer token", async () => {
    const response = await handler(event("agent-test-token"));
    const json = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(json.projectId).toBe("project-a");
    expect(json.workflow).toBe("publish_only");
  });
});
