// Section 2 — Keys & auth: the honest version. Keys live in env vars and
// secret managers; this screen shows presence and source, never values, and
// there is no input element anywhere on it (tests/registry.spec.ts asserts
// that as a security property). Per-project rows come from projects.json's
// endpointEnvVar/tokenEnvVar/endpointSource/tokenSource fields — not a
// hardcoded list — plus a clearly-separated workspace-level group and a
// group for the auth broker added in server/ (see server/README.md).

import type { ReactNode } from 'react';
import { useProjects, useSession } from '../../api/hooks';
import { Note } from '../../components/primitives';
import type { Project } from '../../types';
import { errMessage } from './queries';
import { ErrorCard, LoadingCard } from './Shared';

interface KeyRow {
  name: string;
  source: string;
  status: ReactNode;
}

function setStatus(): ReactNode {
  return <span className="okmark">● set</span>;
}

function unsetStatus(reason: string): ReactNode {
  return <span className="badmark">○ unset — {reason}</span>;
}

function envVarName(p: Project, kind: 'endpoint' | 'token'): string {
  const fallback = `${p.id.toUpperCase().replace(/-/g, '_')}_MCP_${kind === 'endpoint' ? 'ENDPOINT' : 'TOKEN'}`;
  return kind === 'endpoint' ? (p.endpointEnvVar ?? fallback) : (p.tokenEnvVar ?? fallback);
}

function projectKeyRows(p: Project): KeyRow[] {
  const endpointSource = p.endpointSource;
  const tokenSource = p.tokenSource;
  const endpointSet = Boolean(endpointSource) && endpointSource !== 'unset';
  const tokenSet = Boolean(tokenSource) && tokenSource !== 'unset';

  return [
    {
      name: envVarName(p, 'endpoint'),
      source: endpointSet ? (endpointSource as string) : '—',
      status: endpointSet
        ? setStatus()
        : unsetStatus(`${p.name} calls have nothing to reach.`),
    },
    {
      name: envVarName(p, 'token'),
      source: tokenSet ? (tokenSource as string) : '—',
      status: tokenSet ? setStatus() : unsetStatus(`${p.name} runs will refuse.`),
    },
  ];
}

const WORKSPACE_KEYS: KeyRow[] = [
  { name: 'WEB_PROVIDER', source: 'env', status: setStatus() },
  { name: 'OPENAI_API_KEY', source: 'env', status: setStatus() },
];

function KeyRowLine({ row }: { row: KeyRow }) {
  return (
    <div className="keyrow">
      <span>{row.name}</span>
      <span className="src">{row.source}</span>
      {row.status}
    </div>
  );
}

export function KeysTab() {
  const projectsQ = useProjects();
  const sessionQ = useSession();

  if (projectsQ.isLoading || sessionQ.isLoading) return <LoadingCard>Loading key inventory…</LoadingCard>;
  if (projectsQ.isError) {
    return <ErrorCard message={errMessage(projectsQ.error, 'Failed to load projects.')} />;
  }

  const projects = projectsQ.data ?? [];
  const session = sessionQ.data;
  const sessionErr = sessionQ.isError;

  const brokerRows: KeyRow[] = [
    {
      name: 'SESSION_SECRET',
      source: 'server env (server/.env)',
      status: session?.authenticated
        ? setStatus()
        : unsetStatus('no active session to infer presence from'),
    },
    {
      name: 'OPERATOR_PASSWORD_HASH',
      source: 'server env — server/README.md §1 (npm run hash)',
      status: session?.authenticated
        ? setStatus()
        : unsetStatus('no active session to infer presence from'),
    },
    {
      name: 'CMS_AGENT_MCP_URL',
      source: 'server env or Secret Manager',
      status: session?.workspace?.ok
        ? setStatus()
        : unsetStatus('workspace not reported reachable'),
    },
    {
      name: 'CMS_AGENT_MCP_TOKEN',
      source: 'server env or Secret Manager',
      status: session?.workspace?.ok
        ? setStatus()
        : unsetStatus('workspace not reported reachable'),
    },
    {
      name: 'READ_ONLY',
      source: 'server env (defaults to 1 / on)',
      status: session ? (
        <span className="okmark">● {session.readOnly ? 'on — mutations blocked' : 'off — mutations enabled'}</span>
      ) : (
        <span className="badmark">○ unknown — no active session</span>
      ),
    },
  ];

  return (
    <>
      <div className="projcard">
        <div className="top">
          <h3>Keys & auth</h3>
        </div>
        <Note>
          Keys live in env vars and secret managers — this screen shows presence and source, never
          values, and nothing here is an input field. Rotation is a runbook (server/README.md §1), not
          a form on this page.
        </Note>
        {projects.map((p) => projectKeyRows(p).map((row) => <KeyRowLine key={row.name} row={row} />))}
      </div>

      <div className="projcard">
        <div className="top">
          <h3>Workspace-level</h3>
        </div>
        {WORKSPACE_KEYS.map((row) => (
          <KeyRowLine key={row.name} row={row} />
        ))}
      </div>

      <div className="projcard">
        <div className="top">
          <h3>Authentication broker</h3>
        </div>
        <Note>
          server/ (WP-04) fronts the single operator's own session — a password login exchanged for a
          signed httpOnly cookie, never the MCP bearer token itself. These rows are inferred from the
          active session where possible, not read directly (the browser never sees server env values).
        </Note>
        {sessionErr && <p style={{ color: 'var(--bad)', fontSize: 12, margin: '0 0 8px' }}>{errMessage(sessionQ.error, 'Session check failed.')}</p>}
        {brokerRows.map((row) => (
          <KeyRowLine key={row.name} row={row} />
        ))}
      </div>
    </>
  );
}
