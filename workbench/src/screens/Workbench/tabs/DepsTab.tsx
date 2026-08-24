// Dependencies tab — mirrors spec/mockup.html's S.tab==='deps' branch. The
// re-seed sentence is verbatim per the WP-12 brief (HANDOFF §7.4 review gate).
//
// fixtures/README.md: fit_adjudicator's kind/risk/fan are live-unknown, not
// invented — normalizeNode() (mockStore.ts, not ours to edit) has to default
// them to satisfy WorkflowNode's non-nullable fields, so `kind === 'unknown'`
// is the sentinel this tab uses to show an honest "—" instead of trusting
// those defaults as real facts.

import { Card, KV, RiskBadge } from '../../../components/primitives';
import type { WorkflowNode } from '../../../types';

export function DepsTab({ node }: { node: WorkflowNode }) {
  const unknown = node.kind === 'unknown';
  return (
    <Card
      label={
        <>
          dependencies <span className="pin pinned">pinned to seed</span>
        </>
      }
    >
      <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>
        Topology — edges, risk level, new nodes — is pinned to the canonical definitions. Changing it requires{' '}
        <span className="mono">npm run nodes:update</span> + redeploy; the store overlay does not carry it. This tab
        tells you that instead of pretending.
      </p>
      <KV>
        <span className="k">depends on</span>
        <span className="mono" style={{ fontSize: 12 }}>
          {unknown ? '— unknown (not in workspace_get_node)' : node.fan ? `⇐ ${node.fan} upstream node${node.fan > 1 ? 's' : ''}` : 'entry node'}
        </span>
        <span className="k">risk level</span>
        <span>{unknown ? <span className="mono">—</span> : <RiskBadge risk={node.risk} />}</span>
        <span className="k">kind</span>
        <span className="mono" style={{ fontSize: 12 }}>
          {node.kind}
        </span>
      </KV>
    </Card>
  );
}
