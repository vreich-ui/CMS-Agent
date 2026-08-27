import { describe, expect, it } from "vitest";
import { handler as sessionHandler } from "../../../netlify/functions/session.mjs";
import { AdminSessionError, requireAdminSession } from "../../../src/agent/runtime/adminSession.js";

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

  // T8: these three used to drive netlify/functions/workspace-mcp.mts, the admin-session MCP proxy.
  // That function was deleted — nothing called it (the Workbench moved to the Cloud Run plane and
  // netlify.toml's own comment recorded the path as 502ing on every request), and a deployed entry
  // point nothing reaches is a live auth surface with no purpose. The GUARD it carried is not
  // deleted with it: requireAdminSession is what actually decides 401/403, and it is exercised
  // directly below, so the next function that adopts it inherits the same tested behaviour.
  const statusOf = (email?: string) => {
    try {
      requireAdminSession(context(email));
      return 200;
    } catch (error) {
      return error instanceof AdminSessionError ? error.statusCode : 500;
    }
  };

  it("requireAdminSession rejects missing identity", () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com";
    expect(statusOf()).toBe(401);
  });

  it("requireAdminSession rejects a non-admin email", () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com";
    expect(statusOf("reader@example.com")).toBe(403);
  });

  it("requireAdminSession accepts an admin email, case-insensitively", () => {
    process.env.ADMIN_EMAIL_IDS = "admin@example.com";
    expect(statusOf("Admin@Example.com")).toBe(200);
    expect(requireAdminSession(context("Admin@Example.com")).email).toBe("admin@example.com");
  });
});
