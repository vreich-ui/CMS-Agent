// Framework-free model for the conversational agent surface. Kept out of the component so the
// rules (what counts as a change, when a save is blocked, how prompt state reads) are testable in
// the node environment, matching the nodeInspector.ts split.

export type ConversationalAgentPromptState = "canonical" | "superseded" | "diverged";

export type ConversationalAgentView = {
  id: string;
  role: string;
  name: string;
  prompt: string;
  promptState: ConversationalAgentPromptState;
  modelConfig: { provider: string; model: string; timeoutMs: number; maxOutputTokens: number };
  skills: string[];
  status: "active" | "disabled";
  rev: number;
  updatedAt: string;
};

export type AgentListResult = { agents: ConversationalAgentView[]; workspaceVersion: number };
export type AgentWriteResult = { agent: ConversationalAgentView; workspaceVersion: number };

export type AgentDraft = { name: string; prompt: string };

export const draftFromAgent = (agent: ConversationalAgentView): AgentDraft => ({
  name: agent.name,
  prompt: agent.prompt
});

export type AgentDraftChange = { field: keyof AgentDraft; label: string };

/** Only changed fields travel, so a save never rewrites a field the operator did not touch. */
export function agentDraftChanges(agent: ConversationalAgentView, draft: AgentDraft): AgentDraftChange[] {
  const changes: AgentDraftChange[] = [];
  if (draft.name.trim() !== agent.name) changes.push({ field: "name", label: "Name" });
  if (draft.prompt !== agent.prompt) changes.push({ field: "prompt", label: "Prompt" });
  return changes;
}

export function buildAgentPatch(agent: ConversationalAgentView, draft: AgentDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const change of agentDraftChanges(agent, draft)) {
    patch[change.field] = change.field === "name" ? draft.name.trim() : draft[change.field];
  }
  return patch;
}

// Same floor as a node write: an unexplained prompt change is unreviewable later in the ledger.
export const MIN_AGENT_REASON_LENGTH = 8;
export const MAX_AGENT_PROMPT_LENGTH = 24_000;

export function agentSaveBlockers(
  agent: ConversationalAgentView | null,
  draft: AgentDraft,
  reason: string,
  workspaceVersion: number | null
): string[] {
  const blockers: string[] = [];
  if (!agent) return ["No agent definition is loaded."];
  if (workspaceVersion === null) blockers.push("Workspace version is unknown; reload before saving.");
  if (agentDraftChanges(agent, draft).length === 0) blockers.push("Nothing has changed yet.");
  if (!draft.name.trim()) blockers.push("Name cannot be empty.");
  if (!draft.prompt.trim()) blockers.push("Prompt cannot be empty.");
  if (draft.prompt.length > MAX_AGENT_PROMPT_LENGTH) blockers.push(`Prompt is ${draft.prompt.length} characters; the limit is ${MAX_AGENT_PROMPT_LENGTH}.`);
  if (reason.trim().length < MIN_AGENT_REASON_LENGTH) blockers.push(`Give a reason of at least ${MIN_AGENT_REASON_LENGTH} characters.`);
  return blockers;
}

/**
 * What the operator is looking at, said plainly. "Superseded" is the one that needs an action:
 * the workspace is running an older shipped prompt than the deployed code carries.
 */
export function promptStateSummary(state: ConversationalAgentPromptState): { label: string; detail: string; tone: "neutral" | "warning" } {
  if (state === "canonical") {
    return { label: "Shipped default", detail: "This is the prompt that ships with the current deployment. No local edits.", tone: "neutral" };
  }
  if (state === "superseded") {
    return {
      label: "Older shipped default",
      detail: "This workspace still holds a previous shipped prompt. Reconnecting or resolving the agent upgrades it automatically; saving your own text here keeps it as an edit instead.",
      tone: "warning"
    };
  }
  return { label: "Edited here", detail: "This prompt was edited in this workspace and no longer matches the shipped default.", tone: "neutral" };
}
