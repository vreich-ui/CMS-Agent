import { useEffect, useMemo, useState } from "react";
import { useConversationalAgents } from "../../hooks/useConversationalAgents";
import { classifyWriteFailure, type WriteFailure } from "../../nodeInspector";
import {
  agentDraftChanges,
  agentSaveBlockers,
  buildAgentPatch,
  draftFromAgent,
  promptStateSummary,
  MAX_AGENT_PROMPT_LENGTH,
  type AgentDraft,
  type ConversationalAgentView
} from "../../conversationalAgents";
import type { McpClient } from "../../mcp/client";
import type { StatusMessage } from "../../status";

type Props = {
  client: McpClient;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

/**
 * The house rules surface: the conversational agent prompt that governs every client editor chat.
 *
 * Write discipline is deliberately the same as NodeInspector's — mandatory reason, an explicit
 * diff before the write, a confirm step, and a workspace-version guard — because this prompt has a
 * wider blast radius than any single node: it is shared by every tenant.
 */
export function AgentsPage({ client, onStatus, onError }: Props) {
  const { agents, workspaceVersion, loading, error, refresh, updateAgent } = useConversationalAgents(client);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDraft>({ name: "", prompt: "" });
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);

  const agent = useMemo<ConversationalAgentView | null>(
    () => agents.find((candidate) => candidate.id === selectedId) ?? agents[0] ?? null,
    [agents, selectedId]
  );

  // Reset the draft whenever the underlying definition changes identity or revision, so a
  // concurrent edit elsewhere never leaves a stale draft silently sitting on top of new text.
  useEffect(() => {
    if (!agent) return;
    setDraft(draftFromAgent(agent));
    setReason("");
    setConfirming(false);
    setFailure(null);
  }, [agent?.id, agent?.rev]);

  const changes = agent ? agentDraftChanges(agent, draft) : [];
  const blockers = agentSaveBlockers(agent, draft, reason, workspaceVersion);
  const promptState = agent ? promptStateSummary(agent.promptState) : null;

  const save = async () => {
    if (!agent || blockers.length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      const summary = `Updated ${changes.map((change) => change.label.toLowerCase()).join(" and ")} on ${agent.name}`;
      const result = await updateAgent(agent.id, buildAgentPatch(agent, draft), reason, summary);
      setConfirming(false);
      setReason("");
      onStatus({ tone: "success", message: `Saved. ${agent.name} is now revision ${result.agent.rev}; open conversations re-resolve on their next turn.` });
    } catch (cause) {
      setFailure(classifyWriteFailure(cause));
      onError(cause);
    } finally {
      setSaving(false);
    }
  };

  return <section className="tab-panel" aria-label="Agents">
    <section className="panel agents-panel">
    <div className="panel-heading">
      <div>
        <h2>Conversational agents</h2>
        <p className="muted">
          The shared instructions behind every client editor chat. One definition serves every tenant, so an edit here
          changes the behaviour of all of them. Tenant knowledge and brand voice are supplied separately, per project.
        </p>
      </div>
      <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
    </div>

    {error && <div className="status error" role="status">
      {error}
      <p className="muted">If this connection uses a scoped token, it may not carry the agent tools.</p>
    </div>}

    {agents.length > 1 && <nav className="agent-switcher" aria-label="Agent definitions">
      {agents.map((candidate) => <button
        key={candidate.id}
        type="button"
        aria-pressed={candidate.id === agent?.id}
        onClick={() => setSelectedId(candidate.id)}
      >{candidate.name}</button>)}
    </nav>}

    {agent && <article className="agent-detail">
      <dl className="agent-meta">
        <div><dt>Role</dt><dd>{agent.role}</dd></div>
        <div><dt>Revision</dt><dd>r{agent.rev}</dd></div>
        <div><dt>Status</dt><dd>{agent.status}</dd></div>
        <div><dt>Model</dt><dd>{agent.modelConfig.provider} · {agent.modelConfig.model}</dd></div>
      </dl>

      {promptState && <div className={`status ${promptState.tone === "warning" ? "warning" : "info"}`} role="status">
        <strong>{promptState.label}.</strong> {promptState.detail}
      </div>}

      {failure && <div className="status error" role="status">
        <strong>{failure.code || "Save failed"}.</strong> {failure.message}
        <p>{failure.recovery}</p>
        {failure.kind === "conflict" && <button type="button" onClick={() => void refresh()}>Reload workspace</button>}
      </div>}

      <label>
        <span>Name</span>
        <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
      </label>

      <label>
        <span>House rules prompt</span>
        <textarea
          className="agent-prompt"
          rows={24}
          spellCheck={false}
          value={draft.prompt}
          onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
        />
      </label>
      <p className="muted">{draft.prompt.length} / {MAX_AGENT_PROMPT_LENGTH} characters</p>

      <label>
        <span>Why are you changing this?</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Recorded in the change ledger next to the before and after text"
        />
      </label>

      {changes.length > 0 && <p className="muted" role="status">
        Will change: {changes.map((change) => change.label).join(", ")}. Guarded against workspace version {workspaceVersion ?? "unknown"}.
      </p>}

      {blockers.length > 0 && <ul className="agent-blockers">
        {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
      </ul>}

      {!confirming && <button type="button" disabled={blockers.length > 0 || saving} onClick={() => setConfirming(true)}>
        Review and save
      </button>}

      {confirming && <div className="agent-confirm">
        <p>
          This replaces the shared instructions for every client editor chat, and bumps the definition revision so open
          conversations re-resolve on their next turn.
        </p>
        <button type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Confirm save"}</button>
        <button type="button" disabled={saving} onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
    </article>}

    {!agent && !loading && !error && <p className="muted">No conversational agent definitions are available on this connection.</p>}
    </section>
  </section>;
}
