// W5 — THE CLIENT MANAGER PAGE.
//
// This used to be a read-only card: the agent's name, its model, and the word "diverged". The
// agent it describes is the one every editor's admin chat talks to — its prompt IS the editorial
// policy of this workspace — and it was the only prompt in the system an operator could not read,
// let alone change, from the Workbench. Every node's prompt has had an editor since WP-31.
//
// Four things, in the order an operator needs them:
//   1. The prompt, in full, editable, with `promptState` saying whether what is on screen is the
//      shipped text, an older shipped text, or somebody's edit.
//   2. Model configuration and skills, so "why did it answer like that" has somewhere to start.
//   3. Revision history — the agent's own changes, not the workspace's.
//   4. What it has actually been SAYING (agent.list_conversations), which no surface showed.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as verbs from '../../api/verbs';
import { ActionCancelledError } from '../../api/confirmAction';
import { IS_READ_ONLY } from '../../api/client';
import { useAgents } from '../../api/hooks';
import { Btn, Chip, KV, Lbl } from '../../components/primitives';
import { Skeleton } from '../../components/Skeleton';
import { toast } from '../../components/Toasts';
import { errMessage } from './queries';
import { ErrorCard, LoadingCard } from './Shared';

const PROMPT_STATE_COPY: Record<string, string> = {
  canonical: 'the shipped text, unchanged',
  diverged: 'an operator edit — this workspace is running something the build does not ship',
  stale: 'an older shipped text — a newer canonical prompt exists and this workspace has not taken it',
};

function PromptEditor({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const detailQ = useQuery({ queryKey: ['agent', agentId], queryFn: () => verbs.agentGet({ agentId }) });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const stored = detailQ.data?.prompt ?? '';
  const value = draft ?? stored;
  const dirty = draft !== null && draft !== stored;

  async function save() {
    setSaving(true);
    try {
      await verbs.agentUpdatePrompt({ agentId, prompt: value });
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['agent', agentId] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['agentChanges', agentId] });
      toast('Prompt saved', `${agentId}'s revision was bumped — the next admin-chat turn re-resolves against it.`);
    } catch (error) {
      if (error instanceof ActionCancelledError) return;
      toast('Save failed', error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  if (detailQ.isLoading) return <Skeleton lines={5} />;
  if (detailQ.isError) return <ErrorCard message={errMessage(detailQ.error, 'Failed to load the agent prompt.')} />;

  return (
    <div id="client-manager-prompt">
      <div className="editnote">
        <Lbl>
          stored prompt{' '}
          <span className={`pin ${detailQ.data?.promptState === 'canonical' ? 'live' : ''}`}>
            {detailQ.data?.promptState ?? 'unknown'}
          </span>
        </Lbl>
        <Btn
          variant="pri"
          disabled={!dirty || saving || IS_READ_ONLY}
          title={IS_READ_ONLY ? 'This build is read-only.' : !dirty ? 'No change to save.' : undefined}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save prompt'}
        </Btn>
      </div>
      <p className="note">{PROMPT_STATE_COPY[detailQ.data?.promptState ?? ''] ?? 'Prompt state unknown.'}</p>
      <textarea
        id="client-manager-prompt-text"
        className="mono"
        value={value}
        readOnly={IS_READ_ONLY}
        onChange={(e) => setDraft(e.target.value)}
        style={{ width: '100%', minHeight: 260, fontSize: 12, lineHeight: 1.55 }}
      />
    </div>
  );
}

function RevisionHistory({ agentId }: { agentId: string }) {
  // The AGENT's own changes, not the workspace's: `changes_list` is scoped by nodeId, and a
  // conversational agent's id occupies that axis for its own edits.
  const changesQ = useQuery({
    queryKey: ['agentChanges', agentId],
    queryFn: () => verbs.changesList({ nodeId: agentId }),
    retry: false,
  });
  if (changesQ.isLoading) return <Skeleton lines={2} />;
  if (changesQ.isError) return <p className="note">Revision history unavailable: {errMessage(changesQ.error, 'changes_list failed.')}</p>;
  const changes = changesQ.data ?? [];
  if (!changes.length) return <p className="note">No recorded revisions for this agent yet.</p>;
  return (
    <div id="client-manager-history">
      {changes.slice(0, 10).map((change) => (
        <div key={change.id} className="mono" style={{ fontSize: 11.5, padding: '3px 0', borderBottom: '1px solid var(--line2)' }}>
          {change.when} · {change.author ?? 'unknown actor'} · {change.field}
        </div>
      ))}
    </div>
  );
}

function Conversations({ agentId }: { agentId: string }) {
  const conversationsQ = useQuery({
    queryKey: ['agentConversations', agentId],
    queryFn: () => verbs.agentListConversations({ agentId, limit: 10 }),
    retry: false,
  });

  if (conversationsQ.isLoading) return <Skeleton lines={3} />;
  if (conversationsQ.isError) {
    return <p className="note">Conversations unavailable: {errMessage(conversationsQ.error, 'agent_list_conversations failed.')}</p>;
  }
  const { conversations = [], scanCapped } = conversationsQ.data ?? {};
  if (!conversations.length) {
    return (
      <p className="note" id="client-manager-conversations-empty">
        No turns recorded for this agent in CMS-Agent&rsquo;s own mirror. That is not the same as
        &ldquo;this agent has never been used&rdquo;: the human-facing transcript lives in the
        platform&rsquo;s ChatDoc, and this mirror is bounded audit history.
      </p>
    );
  }
  return (
    <div id="client-manager-conversations">
      {scanCapped && (
        <p className="note">
          Older conversations were not examined — this is the newest page, not the whole history.
        </p>
      )}
      {conversations.map((conversation) => (
        <div key={conversation.conversationId} style={{ marginBottom: 14 }}>
          <Lbl>
            <span className="mono">{conversation.conversationId}</span> · {conversation.projectId} ·{' '}
            {conversation.turnCount} turn{conversation.turnCount === 1 ? '' : 's'}
            {conversation.trimmedTurnCount ? ` · ${conversation.trimmedTurnCount} older turns trimmed` : ''}
          </Lbl>
          {conversation.turns.map((turn) => (
            <div key={turn.turnId} style={{ padding: '6px 0', borderBottom: '1px solid var(--line2)' }}>
              <div className="mono" style={{ fontSize: 11 }}>
                {turn.actor.kind} {turn.actor.id} · {turn.createdAt} · {turn.usage.totalTokens} tokens · $
                {turn.usage.costUsdEstimate.toFixed(4)}
              </div>
              {turn.request.latestMessagePreview && (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>“{turn.request.latestMessagePreview}”</div>
              )}
              {turn.assistantText && <div style={{ fontSize: 12.5, marginTop: 3 }}>{turn.assistantText}</div>}
              {turn.proposedToolCalls.length > 0 && (
                <div className="mono" style={{ fontSize: 11, marginTop: 3 }}>
                  proposed: {turn.proposedToolCalls.map((call) => call.name).join(' · ')}
                  <span className="note"> — proposals for the platform to gate; CMS-Agent executes none of them.</span>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function AgentsTab() {
  const agentsQ = useAgents();

  if (agentsQ.isLoading) return <LoadingCard>Loading agents…</LoadingCard>;
  if (agentsQ.isError) return <ErrorCard message={errMessage(agentsQ.error, 'Failed to load agents.')} />;

  const agents = agentsQ.data ?? [];
  if (agents.length === 0) {
    return (
      <div className="projcard">
        <div className="top">
          <h3>Agents</h3>
        </div>
        <p style={{ color: 'var(--faint)', margin: 0 }}>No agents registered.</p>
      </div>
    );
  }

  return (
    <>
      {agents.map((a) => (
        <div className="projcard" key={a.id}>
          <div className="top">
            <h3>{a.name}</h3>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)' }}>
              {a.id} · rev {a.rev}
            </span>
            <Chip status={a.status === 'active' ? 'completed' : 'blocked'}>{a.status ?? 'active'}</Chip>
          </div>
          <KV>
            <span className="k">role</span>
            <span>
              {a.role} — the editors&rsquo; admin-chat agent (their surface, not this operator console)
            </span>
            <span className="k">model</span>
            <span className="mono" style={{ fontSize: 11.5 }}>
              {a.model}
            </span>
            <span className="k">skills</span>
            <span className="mono" style={{ fontSize: 11.5 }}>
              {a.skills.length > 0 ? a.skills.join(' · ') : '—'}
            </span>
          </KV>

          <PromptEditor agentId={a.id} />

          <Lbl>revisions</Lbl>
          <RevisionHistory agentId={a.id} />

          <Lbl>conversations</Lbl>
          <Conversations agentId={a.id} />
        </div>
      ))}
    </>
  );
}
