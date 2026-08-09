import { beforeEach, describe, expect, it } from "vitest";
import { FERNWELL_SAFE_READ_ONLY_TOOLS, fernwellProjectConfig } from "../../../src/agent/projects/fernwell/definition.js";
import { defaultProjectConnections } from "../../../src/agent/projects/defaultProjects.js";
import { getProjectHooks } from "../../../src/agent/projects/projectHooks.js";
import { toProjectSummary } from "../../../src/agent/projects/projectRegistry.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { resetRepositoryManager, repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { toolError } from "../../../src/agent/mcp/workspace/toolKit.js";

const resolveTool = () => {
  const tool = createWorkspaceTools({}).find((candidate) => candidate.name === "agent.resolve");
  if (!tool) throw new Error("agent.resolve is missing");
  return tool;
};

describe("Fernwell CA5 project registration", () => {
  beforeEach(() => {
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
  });

  it("registers only the canonical fernwell slug with the Platform-derived identity", async () => {
    const repository = new MemoryProjectRepository();
    const project = await repository.get("fernwell");

    expect(project).toMatchObject({
      projectId: "fernwell",
      name: "Fernwell",
      status: "active",
      mcpEndpointEnvVar: "FERNWELL_MCP_ENDPOINT",
      tokenEnvVar: "FERNWELL_MCP_TOKEN",
      objectDialect: {
        siteObjectId: "site_fernwell",
        taxonomyRegistryObjectId: "tax_fernwell",
        voiceObjectId: "voice_fernwell",
        objectIdSource: "server_minted"
      }
    });
    expect((await repository.list()).map(({ projectId }) => projectId)).toContain("fernwell");
    expect((await repository.get("site_fernwell"))).toBeUndefined();
    expect(defaultProjectConnections.filter(({ projectId }) => projectId === "fernwell")).toHaveLength(1);
  });

  it("keeps provisioning idempotent and preserves existing default projects", async () => {
    const repository = new MemoryProjectRepository();
    const first = await repository.get("fernwell");
    const second = await repository.get("fernwell");

    expect(second).toEqual(first);
    expect((await repository.list()).map(({ projectId }) => projectId)).toEqual(["dr-lurie", "fernwell", "monetizer", "pdf-tool", "platform"]);
    expect((await repository.get("dr-lurie"))?.status).toBe("active");
    expect((await repository.get("platform"))?.status).toBe("active");
  });

  it("resolves the canonical client_manager for Fernwell and fails closed when Fernwell is disabled", async () => {
    const resolved = await resolveTool().execute({ role: "client_manager", project_id: "fernwell" }) as { ok: boolean; data: Record<string, unknown> };
    expect(resolved).toEqual({ ok: true, data: { agent_ref: "agt_client_manager@1", name: "Client Manager", rev: 1, model: "gpt-4.1", status: "active" } });

    await updateProject(repositoryManager.getProjectRepository(), "fernwell", { status: "disabled" });
    try {
      await resolveTool().execute({ role: "client_manager", project_id: "fernwell" });
      throw new Error("expected disabled Fernwell to fail");
    } catch (error) {
      expect(toolError(error)).toMatchObject({ ok: false, error: { code: "project_disabled" } });
    }
  });

  it("keeps Fernwell connection metadata secret-free and supplies its knowledge and voice hooks", () => {
    const summary = toProjectSummary(fernwellProjectConfig, {
      FERNWELL_MCP_ENDPOINT: "https://secret.example/mcp",
      FERNWELL_MCP_TOKEN: "secret-token"
    } as unknown as NodeJS.ProcessEnv);
    expect(JSON.stringify(summary)).not.toContain("secret-token");
    expect(JSON.stringify(summary)).not.toContain("https://secret.example/mcp");
    expect(getProjectHooks("fernwell")?.knowledge).toMatchObject({ projectId: "fernwell" });
    expect(getProjectHooks("fernwell")?.editorialVoiceFallback).toMatchObject({ name: "Fernwell — considered, unhurried" });
    expect(fernwellProjectConfig.allowedTools).toEqual([...FERNWELL_SAFE_READ_ONLY_TOOLS]);
    expect(fernwellProjectConfig.objectDialect).toMatchObject({ siteObjectId: "site_fernwell", taxonomyRegistryObjectId: "tax_fernwell" });
  });
});
