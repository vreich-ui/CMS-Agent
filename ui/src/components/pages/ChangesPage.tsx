import { useEffect, useState } from "react";
import { actorKindOptions, describeChangeEvent, diffRange, formatChangeTime, operationOptions, restoreTarget, summarizeDiff, type ChangedFieldSummary, type ChangeLedgerFilters } from "../../changes";
import { useChanges } from "../../hooks/useChanges";
import { getErrorMessage } from "../../hooks/useConnection";
import type { McpClient } from "../../mcp/client";
import type { WorkspaceActorKind, WorkspaceChangeEvent, WorkspaceChangeOperation } from "../../types/workspace";
import type { StatusMessage } from "../../status";

type Props = {
  client: McpClient;
  selectedProjectId: string | null;
  onStatus: (status: StatusMessage) => void;
  onError: (error: unknown) => void;
};

type DiffState = { loading: boolean; summary?: ChangedFieldSummary; error?: string };

// One expanded event: who/why/when detail, lazily-fetched field-level diff, append-only restore.
// Selection reveals in place — expanding never navigates.
function EventDetail({ event, diff, onRestore, restoring }: {
  event: WorkspaceChangeEvent;
  diff: DiffState | null;
  onRestore: (revisionId: string, nodeId: string) => void;
  restoring: boolean;
}) {
  const view = describeChangeEvent(event);
  const restorable = restoreTarget(event);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [event.eventId]);

  return <div className="change-detail">
    <dl className="change-facts">
      <dt>Actor</dt><dd>{view.actorLabel} <span className={`actor-chip actor-chip--${view.actorKind}`}>{view.actorKind}</span> via {view.sourceLabel}</dd>
      <dt>When</dt><dd>{formatChangeTime(event.createdAt)}</dd>
      <dt>Version</dt><dd>{event.workspaceVersion}</dd>
      {view.reason && <><dt>Reason</dt><dd>{view.reason}</dd></>}
      {view.runId && <><dt>Run</dt><dd><code>{view.runId}</code></dd></>}
    </dl>

    {view.structural
      ? diffRange(event)
        ? <div className="change-fields">
            {diff?.loading && <p className="muted">Loading changed fields…</p>}
            {diff?.error && <p className="muted">Diff unavailable: {diff.error}</p>}
            {diff?.summary && <>
              {diff.summary.targetFields.length > 0 && <p>
                Changed fields: {diff.summary.targetFields.map((field) => <span key={field} className="field-chip">{field}</span>)}
                <span className="muted"> (plus timestamps)</span>
              </p>}
              {diff.summary.addedNodes.length > 0 && <p>Added: {diff.summary.addedNodes.join(", ")}</p>}
              {diff.summary.removedNodes.length > 0 && <p>Removed: {diff.summary.removedNodes.join(", ")}</p>}
              {diff.summary.otherChangedNodes > 0 && <p className="muted">{diff.summary.otherChangedNodes} other node(s) also changed in this revision.</p>}
              {diff.summary.relationshipChanges > 0 && <p className="muted">{diff.summary.relationshipChanges} relationship change(s).</p>}
              {diff.summary.targetFields.length === 0 && diff.summary.addedNodes.length === 0 && diff.summary.removedNodes.length === 0 && diff.summary.otherChangedNodes === 0 && diff.summary.relationshipChanges === 0 &&
                <p className="muted">Only timestamps changed in this revision — the recorded values were already identical.</p>}
            </>}
          </div>
        : <p className="muted">This is the first recorded revision — there is nothing earlier to compare against.</p>
      : <p className="muted">This event recorded operational data without changing the workspace structure.</p>}

    {restorable && <div className="change-restore">
      {confirming
        ? <>
            <p>Restore <strong>{view.entityLabel}</strong> to its state {event.operation === "delete" ? "before this deletion" : "at this point"}? This creates a new change event — history is never rewritten or deleted.</p>
            <div className="auth-actions">
              <button disabled={restoring} onClick={() => onRestore(restorable.revisionId, restorable.nodeId)}>Confirm restore</button>
              <button className="link-button" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </>
        : <button disabled={restoring} onClick={() => setConfirming(true)}>Restore this state…</button>}
    </div>}
  </div>;
}

export function ChangesPage({ client, selectedProjectId, onStatus, onError }: Props) {
  const changes = useChanges(client);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const [restoring, setRestoring] = useState(false);

  const expand = (event: WorkspaceChangeEvent) => {
    const next = expandedId === event.eventId ? null : event.eventId;
    setExpandedId(next);
    if (!next) return;
    const range = diffRange(event);
    if (!range || diffs[event.eventId]) return;
    setDiffs((current) => ({ ...current, [event.eventId]: { loading: true } }));
    changes.fetchDiff(range.fromRevisionId, range.toRevisionId)
      .then((diff) => setDiffs((current) => ({ ...current, [event.eventId]: { loading: false, summary: summarizeDiff(diff, event.target.id) } })))
      .catch((cause) => setDiffs((current) => ({ ...current, [event.eventId]: { loading: false, error: getErrorMessage(cause) } })));
  };

  const handleRestore = async (revisionId: string, nodeId: string) => {
    setRestoring(true);
    try {
      await changes.restore(revisionId, nodeId);
      setExpandedId(null);
      onStatus({ tone: "success", message: `Restored ${nodeId} — recorded as a new change event at the top of the ledger.` });
    } catch (error) {
      onError(error);
    } finally {
      setRestoring(false);
    }
  };

  return <section className="tab-panel" aria-label="Changes">
    <section className="panel change-ledger-panel">
      <div className="panel-heading">
        <div>
          <h2>Changes</h2>
          <p className="muted">Every workspace change, attributed and immutable: who, what, when, and why. Restoring creates a new event.{selectedProjectId ? " The ledger is workspace-wide; project selection does not filter it." : ""}</p>
        </div>
        <button onClick={() => void changes.refresh()} disabled={changes.loading}>Refresh</button>
      </div>

      <div className="change-filters">
        <label>
          Actor
          <select value={changes.filters.actorKind ?? ""} onChange={(event) => changes.applyFilters({ ...changes.filters, actorKind: (event.target.value || undefined) as WorkspaceActorKind | undefined })}>
            {actorKindOptions.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          Operation
          <select value={changes.filters.operation ?? ""} onChange={(event) => changes.applyFilters({ ...changes.filters, operation: (event.target.value || undefined) as WorkspaceChangeOperation | undefined })}>
            {operationOptions.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>

      {changes.error && <div className="status error" role="status">{changes.error}</div>}

      {changes.events.length === 0 && !changes.loading && !changes.error
        ? <p className="empty-state">No change events match. The ledger fills as humans and agents modify the workspace.</p>
        : <ul className="change-ledger">
            {changes.events.map((event) => {
              const view = describeChangeEvent(event);
              const expanded = expandedId === event.eventId;
              return <li key={event.eventId} className="change-row">
                <button className="change-row-summary" aria-expanded={expanded} onClick={() => expand(event)}>
                  <span className={`actor-chip actor-chip--${view.actorKind}`}>{view.actorKind}</span>
                  <span className="change-row-main">
                    <strong>{view.entityLabel ? `${view.title} · ${view.entityLabel}` : view.title}</strong>
                    {view.reason && <span className="change-row-reason">{view.reason}</span>}
                  </span>
                  <span className="change-row-when">{view.when}</span>
                </button>
                {expanded && <EventDetail event={event} diff={diffs[event.eventId] ?? null} onRestore={handleRestore} restoring={restoring} />}
              </li>;
            })}
          </ul>}

      {changes.loading && <p className="muted" aria-live="polite">Loading changes…</p>}
      {changes.nextCursor && !changes.loading && <button className="link-button" onClick={changes.loadMore}>Load older changes</button>}
    </section>
  </section>;
}
