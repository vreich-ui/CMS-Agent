import { beforeEach, describe, expect, it } from "vitest";
import { updateProject } from "../../../src/agent/projects/projectAdmin.js";
import { resetRepositoryManager, repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { toolError } from "../../../src/agent/mcp/workspace/toolKit.js";
import { createCanonicalClientManagerAgent } from "../../../src/agent/conversations/agentDefinitions.js";

// Derived, not hardcoded: bumping the canonical prompt bumps rev and must not break these.
const CANONICAL_REV = createCanonicalClientManagerAgent().rev;

const resolve = () => {
  const definition = createWorkspaceTools({}).find((candidate) => candidate.name === "agent.resolve");
  if (!definition) throw new Error("agent.resolve is missing");
  return definition;
};

describe("agent.resolve", () => {
  beforeEach(() => {
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
  });

  it("seeds and resolves the canonical project-neutral agent without a caller-supplied id", async () => {
    const result = await resolve().execute({ role: "client_manager", project_id: "dr-lurie" }) as { ok: boolean; data: Record<string, unknown> };

    expect(result).toEqual({ ok: true, data: { agent_ref: `agt_client_manager@${CANONICAL_REV}`, name: "Client Manager", rev: CANONICAL_REV, model: "gpt-4.1", status: "active" } });
    await expect(resolve().execute({ role: "client_manager", project_id: "dr-lurie", agent_id: "node_input_triage" })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("returns typed unknown-project and disabled-project outcomes", async () => {
    await expect(resolve().execute({ role: "client_manager", project_id: "not-registered" })).rejects.toMatchObject({ code: "unknown_project" });

    await updateProject(repositoryManager.getProjectRepository(), "dr-lurie", { status: "disabled" });
    try {
      await resolve().execute({ role: "client_manager", project_id: "dr-lurie" });
      throw new Error("expected disabled project to fail");
    } catch (error) {
      expect(toolError(error)).toMatchObject({ ok: false, error: { code: "project_disabled" } });
    }
  });

  it("returns the new opaque reference after a ledgered definition revision", async () => {
    const workspace = repositoryManager.getWorkspaceRepository();
    const agent = (await workspace.listConversationalAgents())[0];
    await workspace.updateConversationalAgent(agent.id, { modelConfig: { ...agent.modelConfig, model: "gpt-4.1-mini" } }, { actor: { kind: "human", id: "editor-8" }, source: "mcp", reason: "test model revision" });

    const result = await resolve().execute({ role: "client_manager", project_id: "platform" }) as { ok: boolean; data: { agent_ref: string; rev: number; model: string } };
    const nextRev = agent.rev + 1;
    expect(result.data).toEqual(expect.objectContaining({ agent_ref: `agt_client_manager@${nextRev}`, rev: nextRev, model: "gpt-4.1-mini" }));
  });

  it("resolves the same project-neutral definition for the canonical Fernwell project", async () => {
    const result = await resolve().execute({ role: "client_manager", project_id: "fernwell" }) as { ok: boolean; data: { agent_ref: string; rev: number; model: string; status: string } };
    expect(result.data).toEqual({ agent_ref: `agt_client_manager@${CANONICAL_REV}`, name: "Client Manager", rev: CANONICAL_REV, model: "gpt-4.1", status: "active" });
  });

  it("fails closed when the canonical definition is disabled", async () => {
    const workspace = repositoryManager.getWorkspaceRepository();
    const agent = (await workspace.listConversationalAgents())[0];
    await workspace.updateConversationalAgent(agent.id, { status: "disabled" }, { actor: { kind: "human", id: "editor-9" }, source: "mcp", reason: "test disabled definition" });

    await expect(resolve().execute({ role: "client_manager", project_id: "dr-lurie" })).rejects.toMatchObject({ code: "agent_unresolved" });
  });
});
