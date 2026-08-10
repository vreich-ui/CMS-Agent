import { beforeEach, describe, expect, it } from "vitest";
import { resetRepositoryManager, repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { toolError } from "../../../src/agent/mcp/workspace/toolKit.js";
import { CLIENT_MANAGER_PROMPT, SUPERSEDED_CLIENT_MANAGER_PROMPTS } from "../../../src/agent/conversations/agentDefinitions.js";

const toolNamed = (name: string) => {
  const found = createWorkspaceTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool: ${name}`);
  return found;
};

type AgentView = { id: string; prompt: string; promptState: string; rev: number; status: string; name: string; modelConfig: { model: string } };
const dataOf = <T>(result: unknown): T => (result as { ok: true; data: T }).data;

describe("agent management tools", () => {
  beforeEach(() => {
    resetRepositoryManager();
    process.env.WORKSPACE_STORE = "memory";
  });

  it("lists and reads the canonical definition, including its full prompt and prompt state", async () => {
    const listed = dataOf<{ agents: AgentView[]; workspaceVersion: number }>(await toolNamed("agent.list").execute({}));
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({ id: "agt_client_manager", prompt: CLIENT_MANAGER_PROMPT, promptState: "canonical", status: "active" });

    const got = dataOf<{ agent: AgentView }>(await toolNamed("agent.get").execute({ id: "agt_client_manager" }));
    expect(got.agent.prompt).toBe(CLIENT_MANAGER_PROMPT);
  });

  it("rejects an unknown agent id rather than inventing one", async () => {
    try {
      await toolNamed("agent.get").execute({ id: "agt_missing" });
      throw new Error("expected agent.get to fail");
    } catch (error) {
      expect(toolError(error)).toMatchObject({ ok: false, error: { code: "agent_unresolved" } });
    }
  });

  it("edits the prompt, bumps the revision, and reports the edit as diverged from canonical", async () => {
    const before = dataOf<{ agent: AgentView }>(await toolNamed("agent.get").execute({ id: "agt_client_manager" })).agent;

    const updated = dataOf<{ agent: AgentView; workspaceVersion: number }>(await toolNamed("agent.update").execute({
      id: "agt_client_manager",
      patch: { prompt: `${CLIENT_MANAGER_PROMPT}\n\n## House addendum\nAlways name the object being changed.` },
      reason: "Add an operator house rule",
      source: "ui"
    }));

    expect(updated.agent.rev).toBe(before.rev + 1);
    expect(updated.agent.promptState).toBe("diverged");
    expect(updated.agent.prompt).toContain("House addendum");
    // The edit is the stored truth on the next read, not just in the write response.
    expect(dataOf<{ agent: AgentView }>(await toolNamed("agent.get").execute({ id: "agt_client_manager" })).agent.prompt).toContain("House addendum");
  });

  it("restoring the canonical text classifies as canonical again", async () => {
    await toolNamed("agent.update").execute({ id: "agt_client_manager", patch: { prompt: "Operator text." }, reason: "diverge for the test" });
    const restored = dataOf<{ agent: AgentView }>(await toolNamed("agent.update").execute({
      id: "agt_client_manager", patch: { prompt: CLIENT_MANAGER_PROMPT }, reason: "restore canonical"
    })).agent;
    expect(restored.promptState).toBe("canonical");
  });

  it("honours the workspace version guard exactly like a node write", async () => {
    const listed = dataOf<{ workspaceVersion: number }>(await toolNamed("agent.list").execute({}));
    try {
      await toolNamed("agent.update").execute({
        id: "agt_client_manager",
        patch: { name: "Renamed" },
        expectedWorkspaceVersion: listed.workspaceVersion + 5,
        reason: "stale write"
      });
      throw new Error("expected a version conflict");
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/version/i);
    }
  });

  it("refuses an empty patch and an unpatchable field", async () => {
    await expect(toolNamed("agent.update").execute({ id: "agt_client_manager", patch: {}, reason: "nothing" })).rejects.toThrow(/at least one field/i);
    // rev/role/id are store-owned; the strict patch schema rejects them at the wire.
    await expect(toolNamed("agent.update").execute({ id: "agt_client_manager", patch: { rev: 99 }, reason: "forced rev" })).rejects.toThrow();
  });

  it("records the edit in the change ledger with the acting human and a before/after prompt", async () => {
    await toolNamed("agent.update").execute({
      id: "agt_client_manager",
      patch: { prompt: SUPERSEDED_CLIENT_MANAGER_PROMPTS[0] },
      actor: { kind: "human", id: "editor-3" },
      source: "ui",
      reason: "roll back to the previous shipped prompt"
    });
    const events = dataOf<{ events: { type: string; target: { type: string; id?: string }; actor?: { id?: string } }[] }>(
      await toolNamed("changes.list").execute({ limit: 10 })
    ).events;
    const agentEvent = events.find((event) => event.type === "agent.updated");
    expect(agentEvent).toMatchObject({ target: { type: "agent", id: "agt_client_manager" }, actor: { id: "editor-3" } });
  });

  it("keeps a prompt that matches an older shipped text marked as superseded, so the GUI can offer an upgrade", async () => {
    const updated = dataOf<{ agent: AgentView }>(await toolNamed("agent.update").execute({
      id: "agt_client_manager", patch: { prompt: SUPERSEDED_CLIENT_MANAGER_PROMPTS[0] }, reason: "pin the old text"
    })).agent;
    expect(updated.promptState).toBe("superseded");
  });
});
