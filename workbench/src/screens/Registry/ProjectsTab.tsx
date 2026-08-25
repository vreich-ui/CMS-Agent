// Section 1 — Projects & connections. spec/mockup.html renderReg()
// 'projects' branch (~line 977); `.projcard .okmark .badmark .polbar
// .pollegend` copied verbatim. Real data note (api/fixtures/README.md):
// monetizer has neither endpoint nor token configured (ok:false) and
// fernwell is disabled — both must read unmistakably here.

import { useProjects } from '../../api/hooks';
import { Btn, Note } from '../../components/primitives';
import type { Project } from '../../types';
import { errMessage, useTestConnection } from './queries';
import { ErrorCard, LoadingCard } from './Shared';

function ProjectCard({ p }: { p: Project }) {
  const testMut = useTestConnection();
  const tot = p.pol.a + p.pol.n + p.pol.b || 1;

  return (
    <div className="projcard">
      <div className="top">
        <h3>{p.name}</h3>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)' }}>
          {p.id}
        </span>
        {p.disabled && <span className="chip cancelled">disabled</span>}
        <span style={{ marginLeft: 'auto' }} className={p.ok ? 'okmark' : 'badmark'}>
          {p.ok ? '● endpoint + token configured' : '○ endpoint unset'}
        </span>
      </div>
      <div className="polbar">
        <i className="a" style={{ width: `${(100 * p.pol.a) / tot}%` }} />
        <i className="n" style={{ width: `${(100 * p.pol.n) / tot}%` }} />
        <i className="b" style={{ width: `${(100 * p.pol.b) / tot}%` }} />
      </div>
      <div className="pollegend">
        <span>{p.pol.a} allowed</span>
        <span>{p.pol.n} needs approval</span>
        <span>{p.pol.b} blocked</span>
        <Btn
          style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 11 }}
          onClick={() => testMut.mutate({ projectId: p.id })}
          disabled={testMut.isPending}
        >
          {testMut.isPending ? 'testing…' : 'test connection'}
        </Btn>
      </div>
      {testMut.isSuccess && (
        <p
          className={testMut.data.ok ? 'okmark' : 'badmark'}
          style={{ margin: '6px 4px 0', fontSize: 11.5 }}
        >
          {testMut.data.ok ? '● ' : '○ '}
          {testMut.data.message}
          {testMut.data.latencyMs != null ? ` (${testMut.data.latencyMs}ms)` : ''}
        </p>
      )}
      {testMut.isError && (
        <p className="badmark" style={{ margin: '6px 4px 0', fontSize: 11.5 }}>
          {errMessage(testMut.error, 'Connection test failed.')}
        </p>
      )}
    </div>
  );
}

export function ProjectsTab() {
  const projectsQ = useProjects();

  if (projectsQ.isLoading) return <LoadingCard>Loading projects…</LoadingCard>;
  if (projectsQ.isError) {
    return <ErrorCard message={errMessage(projectsQ.error, 'Failed to load projects.')} />;
  }

  const projects = projectsQ.data ?? [];

  return (
    <>
      {projects.map((p) => (
        <ProjectCard key={p.id} p={p} />
      ))}
      <Note>Bar shows each project&rsquo;s tool policy: allowed · needs approval · blocked.</Note>
    </>
  );
}
