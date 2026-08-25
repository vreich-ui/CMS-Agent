// Section 5 — Agents. spec/mockup.html renderReg() 'agents' branch
// (~line 990). Real data (api/fixtures/README.md): exactly one agent exists
// workspace-wide, agt_client_manager — it serves the editors' admin-chat
// surface (platform admin-agent-chat → client_manager), not this operator
// console, which this screen says explicitly rather than leaving implicit.

import { useAgents } from '../../api/hooks';
import { Chip, KV } from '../../components/primitives';
import { errMessage } from './queries';
import { ErrorCard, LoadingCard } from './Shared';

export function AgentsTab() {
  const agentsQ = useAgents();

  if (agentsQ.isLoading) return <LoadingCard>Loading agents…</LoadingCard>;
  if (agentsQ.isError) {
    return <ErrorCard message={errMessage(agentsQ.error, 'Failed to load agents.')} />;
  }

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
            <Chip status="completed">active</Chip>
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
            <span className="k">prompt</span>
            <span>{a.promptState === 'diverged' ? 'diverged from canonical' : a.promptState}</span>
            <span className="k">skills</span>
            <span className="mono" style={{ fontSize: 11.5 }}>
              {a.skills.length > 0 ? a.skills.join(' · ') : '—'}
            </span>
          </KV>
        </div>
      ))}
    </>
  );
}
