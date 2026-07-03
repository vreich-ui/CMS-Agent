import { describe, expect, it } from "vitest";
import { handler as sessionHandler } from "../../../netlify/functions/session.mjs";
import { handler as workspaceMcpHandler } from "../../../netlify/functions/workspace-mcp.mjs";

const event = (method: string, body: unknown = null) => ({
  httpMethod: method,
  headers: {},
  body: body === null ? null : JSON.stringify(body)
});

const context = (email?: string) => email ? { clientContext: { user: { email } } } : {};

describe("Netlify Identity admin session", () => {
  it("session function rejects missing identity", async () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com";
    const response = await sessionHandler(event("GET"), context());

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).authorized).toBe(false);
  });

  it("session function rejects non-admin email", async () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com";
    const response = await sessionHandler(event("GET"), context("reader@example.com"));

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ authenticated: true, authorized: false, email: "reader@example.com" });
  });

  it("session function accepts admin email", async () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com,owner@example.com";
    const response = await sessionHandler(event("GET"), context("Owner@Example.com"));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ authenticated: true, authorized: true, email: "owner@example.com" });
  });

  it("workspace-mcp proxy rejects missing identity", async () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com";
    const response = await workspaceMcpHandler(event("POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), context());

    expect(response.statusCode).toBe(401);
  });

  it("workspace-mcp proxy rejects non-admin email", async () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com";
    const response = await workspaceMcpHandler(event("POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), context("reader@example.com"));

    expect(response.statusCode).toBe(403);
  });

  it("workspace-mcp proxy forwards authorized requests using the server-side MCP_API_TOKEN", async () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com";
    process.env.MCP_API_TOKEN = "server-only-token";
    const response = await workspaceMcpHandler(event("POST", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), context("admin@example.com"));
    const payload = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(payload.result.serverInfo.name).toBe("publishing-workspace-mcp");
  });
});
