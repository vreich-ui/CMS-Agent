import { describe, expect, it } from "vitest";
import { effectiveToolPermission, toToolPolicyMap, type ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { createProject, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";

const baseConfig = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig => ({
  projectId: "acme",
  name: "Acme",
  mcpEndpointEnvVar: "ACME_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "ACME_MCP_TOKEN",
  allowedTools: ["read_thing"],
  contentContract: { contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" },
  publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, description: "" },
  status: "active",
  ...overrides
});

describe("effectiveToolPermission precedence", () => {
  it("defaults to blocked (deny-all) when nothing is configured", () => {
    expect(effectiveToolPermission(baseConfig(), "unknown_tool")).toBe("blocked");
  });

  it("treats legacy allowedTools entries as allowed", () => {
    expect(effectiveToolPermission(baseConfig(), "read_thing")).toBe("allowed");
  });

  it("falls back to defaultToolPolicy for tools not otherwise named", () => {
    expect(effectiveToolPermission(baseConfig({ defaultToolPolicy: "allowed" }), "anything")).toBe("allowed");
    expect(effectiveToolPermission(baseConfig({ defaultToolPolicy: "needs_approval" }), "anything")).toBe("needs_approval");
  });

  it("lets an explicit toolPolicies entry win over allowedTools and the default", () => {
    const config = baseConfig({ defaultToolPolicy: "allowed", toolPolicies: { read_thing: "blocked", danger: "needs_approval" } });
    expect(effectiveToolPermission(config, "read_thing")).toBe("blocked"); // beats allowedTools
    expect(effectiveToolPermission(config, "danger")).toBe("needs_approval"); // beats default allowed
    expect(effectiveToolPermission(config, "other")).toBe("allowed"); // default
  });
});

describe("toToolPolicyMap", () => {
  it("folds allowedTools in as allowed, then applies overrides", () => {
    const map = toToolPolicyMap(baseConfig({ toolPolicies: { read_thing: "blocked", extra: "needs_approval" } }));
    expect(map).toEqual({ read_thing: "blocked", extra: "needs_approval" });
  });
});

describe("project.update round-trips the three-state policy", () => {
  it("persists defaultToolPolicy and toolPolicies through create + update", async () => {
    const repository = new MemoryProjectRepository();
    await createProject(repository, {
      projectId: "acme-daily",
      name: "Acme Daily",
      mcpEndpointEnvVar: "ACME_DAILY_MCP_ENDPOINT",
      authMode: "bearer_env",
      tokenEnvVar: "ACME_DAILY_MCP_TOKEN",
      allowedTools: [],
      defaultToolPolicy: "allowed",
      toolPolicies: { risky: "needs_approval" },
      contentContract: { contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" },
      status: "active"
    });

    const created = await repository.get("acme-daily");
    expect(created?.defaultToolPolicy).toBe("allowed");
    expect(effectiveToolPermission(created!, "risky")).toBe("needs_approval");
    expect(effectiveToolPermission(created!, "whatever")).toBe("allowed");

    const summary = await updateProject(repository, "acme-daily", { toolPolicies: { risky: "blocked" } });
    expect(summary.toolPolicies).toMatchObject({ risky: "blocked" });
    expect(summary.defaultToolPolicy).toBe("allowed");

    const updated = await repository.get("acme-daily");
    expect(effectiveToolPermission(updated!, "risky")).toBe("blocked");
  });

  it("rejects an invalid permission value at the schema boundary", () => {
    expect(projectUpdateSchema.safeParse({ toolPolicies: { x: "sometimes" } }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ defaultToolPolicy: "maybe" }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ defaultToolPolicy: "allowed", toolPolicies: { x: "blocked" } }).success).toBe(true);
  });
});
