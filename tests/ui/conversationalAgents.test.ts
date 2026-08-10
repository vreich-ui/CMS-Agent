import { describe, expect, it } from "vitest";
import {
  agentDraftChanges,
  agentSaveBlockers,
  buildAgentPatch,
  draftFromAgent,
  promptStateSummary,
  MAX_AGENT_PROMPT_LENGTH,
  type ConversationalAgentView
} from "../../ui/src/conversationalAgents.js";

const agent: ConversationalAgentView = {
  id: "agt_client_manager",
  role: "client_manager",
  name: "Client Manager",
  prompt: "House rules.",
  promptState: "canonical",
  modelConfig: { provider: "openai", model: "gpt-4.1", timeoutMs: 90_000, maxOutputTokens: 16_000 },
  skills: [],
  status: "active",
  rev: 2,
  updatedAt: "2026-08-10T00:00:00.000Z"
};

describe("conversational agent draft model", () => {
  it("reports no change for an untouched draft", () => {
    expect(agentDraftChanges(agent, draftFromAgent(agent))).toEqual([]);
    expect(buildAgentPatch(agent, draftFromAgent(agent))).toEqual({});
  });

  it("sends only the fields that actually changed", () => {
    const patch = buildAgentPatch(agent, { name: agent.name, prompt: "House rules, revised." });
    expect(patch).toEqual({ prompt: "House rules, revised." });
    expect(Object.keys(patch)).not.toContain("name");
  });

  it("trims a renamed agent but treats whitespace-only edits as no change", () => {
    expect(buildAgentPatch(agent, { name: "  Client Manager  ", prompt: agent.prompt })).toEqual({});
    expect(buildAgentPatch(agent, { name: "  Renamed  ", prompt: agent.prompt })).toEqual({ name: "Renamed" });
  });

  it("blocks a save with no change, no reason, an empty prompt, or an unknown version", () => {
    const unchanged = agentSaveBlockers(agent, draftFromAgent(agent), "a good long reason", 4);
    expect(unchanged).toContain("Nothing has changed yet.");

    const noReason = agentSaveBlockers(agent, { name: agent.name, prompt: "Changed." }, "short", 4);
    expect(noReason.some((blocker) => /at least 8 characters/.test(blocker))).toBe(true);

    const empty = agentSaveBlockers(agent, { name: agent.name, prompt: "   " }, "a good long reason", 4);
    expect(empty).toContain("Prompt cannot be empty.");

    const noVersion = agentSaveBlockers(agent, { name: agent.name, prompt: "Changed." }, "a good long reason", null);
    expect(noVersion).toContain("Workspace version is unknown; reload before saving.");
  });

  it("blocks a prompt beyond the server's stored limit before the write is attempted", () => {
    const oversized = "x".repeat(MAX_AGENT_PROMPT_LENGTH + 1);
    expect(agentSaveBlockers(agent, { name: agent.name, prompt: oversized }, "a good long reason", 4)
      .some((blocker) => /limit is 24000/.test(blocker))).toBe(true);
  });

  it("clears every blocker for a well-formed edit", () => {
    expect(agentSaveBlockers(agent, { name: agent.name, prompt: "Changed." }, "a good long reason", 4)).toEqual([]);
  });

  it("flags an older shipped prompt as the only state needing attention", () => {
    expect(promptStateSummary("canonical").tone).toBe("neutral");
    expect(promptStateSummary("diverged").tone).toBe("neutral");
    expect(promptStateSummary("superseded").tone).toBe("warning");
    expect(promptStateSummary("diverged").label).toMatch(/edited/i);
  });
});
