import { describe, expect, it } from "vitest";
import { buildToolRows, effectivePermission, nextToolPolicies, summarizePermissions } from "../../ui/src/toolPermissions.js";
import type { ProjectSummary, ProjectToolsResult, ToolPermission } from "../../ui/src/types/workspace.js";

// The real server summary (toProjectSummary) folds allowedTools into toolPolicies as "allowed"; the
// fixture mirrors that so the UI model — which works off the flattened map — is exercised faithfully.
const summary = (defaultToolPolicy: ToolPermission, toolPolicies: Record<string, ToolPermission>, allowedTools: string[] = []): ProjectSummary => ({
  projectId: "dr-lurie",
  name: "Dr. Lurie",
  authMode: "bearer_env",
  allowedTools,
  defaultToolPolicy,
  toolPolicies: { ...Object.fromEntries(allowedTools.map((tool) => [tool, "allowed" as ToolPermission])), ...toolPolicies },
  contentContract: { contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" },
  publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, description: "" },
  status: "active",
  connection: { endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN" }
});

const toolsResult = (names: string[]): ProjectToolsResult => ({
  ok: true,
  projectId: "dr-lurie",
  connection: { endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN" },
  tools: names.map((name) => ({ name, description: `${name} desc` })),
  allowedTools: [],
  defaultToolPolicy: "allowed",
  toolPolicies: {}
});

describe("effectivePermission", () => {
  it("uses the override when present, else the default", () => {
    expect(effectivePermission(summary("allowed", { wipe: "needs_approval" }), "wipe")).toBe("needs_approval");
    expect(effectivePermission(summary("allowed", { wipe: "needs_approval" }), "anything")).toBe("allowed");
    expect(effectivePermission(summary("blocked", {}), "anything")).toBe("blocked");
  });
});

describe("buildToolRows", () => {
  it("merges the remote tool list with policy and marks explicit overrides", () => {
    const rows = buildToolRows(summary("allowed", { wipe_blob_stores: "needs_approval" }), toolsResult(["object_publish", "wipe_blob_stores", "ping"]));
    expect(rows.map((row) => row.name)).toEqual(["object_publish", "ping", "wipe_blob_stores"]); // sorted
    expect(rows.find((row) => row.name === "object_publish")).toMatchObject({ permission: "allowed", explicit: false });
    expect(rows.find((row) => row.name === "wipe_blob_stores")).toMatchObject({ permission: "needs_approval", explicit: true });
    expect(rows.find((row) => row.name === "ping")?.description).toBe("ping desc");
  });

  it("falls back to policy/allowedTools names when the remote list is unavailable", () => {
    const rows = buildToolRows(summary("blocked", { held: "needs_approval" }, ["read_thing"]), null);
    expect(rows.map((row) => row.name)).toEqual(["held", "read_thing"]);
    expect(rows.find((row) => row.name === "read_thing")?.permission).toBe("allowed");
    expect(rows.find((row) => row.name === "held")?.permission).toBe("needs_approval");
  });
});

describe("summarizePermissions", () => {
  it("counts each state", () => {
    const rows = buildToolRows(summary("allowed", { a: "blocked", b: "needs_approval" }), toolsResult(["a", "b", "c", "d"]));
    expect(summarizePermissions(rows)).toEqual({ allowed: 2, needs_approval: 1, blocked: 1 });
  });
});

describe("nextToolPolicies", () => {
  it("adds an override that differs from the default", () => {
    expect(nextToolPolicies(summary("allowed", {}), "x", "blocked")).toEqual({ x: "blocked" });
  });

  it("drops an override that equals the default so the stored map stays minimal", () => {
    // Re-allowing a tool under a default of allowed removes its explicit entry entirely.
    expect(nextToolPolicies(summary("allowed", { x: "blocked" }), "x", "allowed")).toEqual({});
  });

  it("keeps other overrides intact", () => {
    expect(nextToolPolicies(summary("allowed", { keep: "needs_approval" }), "x", "blocked")).toEqual({ keep: "needs_approval", x: "blocked" });
  });
});
