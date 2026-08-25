// Section 3 — Tool registry: all 42 live tools (api/fixtures/README.md — the
// mockup's TOOLS array was a 10-tool excerpt, not the full registry).
// `.toolrow` copied verbatim from spec/mockup.html renderReg() 'tools'
// branch (~line 992). 42 flat rows is a lot to scan, so tools are grouped
// by their MCP namespace prefix (workspace.*, project.*, file.*, …  — 13
// natural families already implicit in every tool id) with a read/write
// filter (reusing the existing `.seg` control, no new CSS) on top.

import { useMemo, useState } from 'react';
import { useTools } from '../../api/hooks';
import { Lbl, RiskBadge } from '../../components/primitives';
import type { Risk, ToolDef } from '../../types';
import { errMessage } from './queries';
import { ErrorCard, LoadingCard } from './Shared';

type RiskFilter = 'all' | Risk;
const FILTERS: RiskFilter[] = ['all', 'read', 'write'];

function namespaceOf(id: string): string {
  const i = id.indexOf('.');
  return i === -1 ? id : id.slice(0, i);
}

function groupByNamespace(tools: ToolDef[]): Array<[string, ToolDef[]]> {
  const map = new Map<string, ToolDef[]>();
  for (const t of tools) {
    const ns = namespaceOf(t.id);
    const list = map.get(ns);
    if (list) list.push(t);
    else map.set(ns, [t]);
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
}

export function ToolsTab() {
  const toolsQ = useTools();
  const [filter, setFilter] = useState<RiskFilter>('all');

  const tools = toolsQ.data ?? [];
  const filtered = filter === 'all' ? tools : tools.filter((t) => t.risk === filter);
  const groups = useMemo(() => groupByNamespace(filtered), [filtered]);

  if (toolsQ.isLoading) return <LoadingCard>Loading tool registry…</LoadingCard>;
  if (toolsQ.isError) {
    return <ErrorCard message={errMessage(toolsQ.error, 'Failed to load tools.')} />;
  }

  return (
    <div className="projcard">
      <div className="top">
        <h3>Controlled tool registry</h3>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)' }}>
          {tools.length} tools · {groups.length} groups shown
        </span>
        <div className="seg" style={{ marginLeft: 'auto', width: 200 }}>
          {FILTERS.map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>
      {groups.map(([ns, group]) => (
        <div key={ns} style={{ marginTop: 12 }}>
          <Lbl>
            {ns} · {group.length}
          </Lbl>
          {group.map((t) => (
            <div className="toolrow" key={t.id}>
              <span className="tn">{t.id}</span>
              <span className="td">{t.desc}</span>
              <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)' }}>
                {t.sideEffect}
              </span>
              <RiskBadge risk={t.risk} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
