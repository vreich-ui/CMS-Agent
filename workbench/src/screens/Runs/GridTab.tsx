// Tab 3 — Grid (WP-14). Airflow's grid view: one workflow, recent runs as
// columns, nodes as rows (spec/mockup.html renderRuns(), S.runtab==='grid').
// Capped to the most recent GRID_CAP runs — stated in the UI, never a silent
// truncation (HANDOFF §8). The page body must never scroll sideways; only
// `.grid` (already `overflow-x:auto` in base.css) does.

import { Card, Note } from '../../components/primitives';
import { QuickLookPopover } from '../../components/quicklook/QuickLookPopover';
import { useNodeQuickLook } from '../../components/quicklook/useNodeQuickLook';
import type { Run, Workflow } from '../../types';
import type { RunFilters } from './index';
import { nodeRunStatus, orderedNodes, runTimestamp, shortId } from './helpers';

const GRID_CAP = 9;
const DEFAULT_WORKFLOW = 'publishing_conductor';

/** U5 — one grid row (a node across the recent runs). Its own component so
 * the quick-look hover trigger (one per node) can be a single hook instance
 * shared by every cell in the row — hovering ANY cell in this row opens the
 * same node's quick-look, anchored to whichever cell the pointer is over. */
function GridRow({
  nid,
  wfId,
  recent,
  order,
  onOpen,
}: {
  nid: string;
  wfId: string;
  recent: Run[];
  order: string[];
  onOpen: (run: Run) => void;
}) {
  const ql = useNodeQuickLook(nid, wfId);
  return (
    <tr>
      <th {...ql.triggerProps}>{nid}</th>
      {recent.map((r) => {
        const st = nodeRunStatus(order, r, nid);
        return (
          <td key={r.id}>
            <button
              type="button"
              className={`cell ${st}`}
              title={`${nid} · ${st} · ${r.id.slice(-6)}`}
              aria-label={`${nid} — ${st} — run ${shortId(r.id)}`}
              onClick={() => onOpen(r)}
              {...ql.triggerProps}
            />
          </td>
        );
      })}
      <QuickLookPopover nodeId={nid} workflowId={wfId} anchor={ql.anchor} onClose={ql.close} />
    </tr>
  );
}

export function GridTab({
  runs,
  workflows,
  workflowById,
  filters,
  setFilters,
  onOpen,
}: {
  runs: Run[];
  workflows: Workflow[];
  workflowById: Record<string, Workflow>;
  filters: RunFilters;
  setFilters: (updater: (f: RunFilters) => RunFilters) => void;
  onOpen: (run: Run) => void;
}) {
  const wfId = filters.wf || DEFAULT_WORKFLOW;
  const wf = workflowById[wfId];
  const order = wf ? orderedNodes(wf) : [];
  const wfRuns = runs.filter((r) => r.wf === wfId);
  const recent = [...wfRuns].sort((a, b) => runTimestamp(b) - runTimestamp(a)).slice(0, GRID_CAP).reverse();

  return (
    <>
      <div className="filters">
        <select
          value={wfId}
          onChange={(e) => setFilters((f) => ({ ...f, wf: e.target.value }))}
          aria-label="grid workflow"
        >
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      {recent.length === 0 ? (
        <Card label="grid">
          <p style={{ margin: 0, color: 'var(--muted)' }}>No runs yet for {wf?.name ?? wfId}.</p>
        </Card>
      ) : (
        <div className="grid">
          <table>
            <thead>
              <tr>
                <th />
                {recent.map((r) => (
                  <th key={r.id}>{r.started}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {order.map((nid) => (
                <GridRow key={nid} nid={nid} wfId={wfId} recent={recent} order={order} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Note>
        Showing {recent.length} of {wfRuns.length} runs. Each column is one run, each row one node — scan across a
        row to spot when a node started failing. Regression-gate verdicts from Learning → Evaluate will mark these
        columns once available.
      </Note>
    </>
  );
}
