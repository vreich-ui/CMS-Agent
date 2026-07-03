import { describe, expect, it } from "vitest";
import { getAccessScreen } from "../../ui/src/accessState.js";
import type { AccessSessionState } from "../../ui/src/accessState.js";

const loggedOut: AccessSessionState = { loading: false, authenticated: false, authorized: false };

describe("workspace identity access screens", () => {
  it("logged-out state renders the minimal login screen", () => {
    const screen = getAccessScreen(true, loggedOut);

    expect(screen).toEqual({ kind: "login", eyebrow: "CMS-Agent", title: "Workspace login required", button: "Log in with Google", error: undefined });
  });

  it("login screen no longer contains the removed Netlify Identity sentence", () => {
    const screenText = Object.values(getAccessScreen(true, loggedOut)).join(" ");

    expect(screenText).not.toContain("Sign in with Google through Netlify Identity to access the CMS-Agent workspace.");
  });

  it("successful identity user triggers the session verification state", () => {
    const screen = getAccessScreen(true, { loading: true, authenticated: true, authorized: false, email: "admin@example.com" });

    expect(screen).toMatchObject({ kind: "verifying" });
    if (screen.kind !== "verifying") throw new Error("Expected verifying screen");
    expect(screen.title).toBe("Login complete, verifying access…");
  });

  it("authorized session renders the workspace", () => {
    const screen = getAccessScreen(true, { loading: false, authenticated: true, authorized: true, email: "admin@example.com", accessToken: "redacted" });

    expect(screen).toEqual({ kind: "workspace" });
  });

  it("unauthorized session renders not-authorized with the user email", () => {
    const screen = getAccessScreen(true, { loading: false, authenticated: true, authorized: false, email: "reader@example.com" });

    expect(screen).toMatchObject({ kind: "unauthorized", title: "Not authorized", email: "reader@example.com" });
  });
});
