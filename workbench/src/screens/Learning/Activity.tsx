// U4 — the learning activity feed. Answers the one question the brief
// quotes Wolf asking directly: "what did it learn, and what did it
// change?" Every node edit the workspace recorded — human, agent, or
// system — newest first, each one openable in the diff & merge studio to
// inspect or amend (the "and amend it" half of the ask).
//
// Server-side vs client-side filters (see contracts/README.md's changes_list
// row and its Finding #5 — actorKind/operation/source are real, live-
// verified filter arguments on the verb itself):
//   - node        -> `nodeId`      server-side
//   - actor kind  -> `actorKind`   server-side (REQUIRED server-side per brief)
//   - change type -> `operation`   server-side (the brief's "operation" —
//                                   REQUIRED server-side; the UI calls it
//                                   "change type" because that's what an
//                                   operator reads, `operation` is the raw
//                                   field name underneath)
//   - source      -> `source`      server-side (bonus filter beyond the
//                                   brief's minimum — same contract row,
//                                   and it's exactly what separates
//                                   "learning changed this" from "a human
//                                   or an agent changed this directly")
//   - workflow    -> CLIENT-SIDE. `changes_list` has no workflow argument
//                    (contracts/README.md's table is explicit about the
//                    filter set); a node belongs to a workflow only via
//                    that workflow's own phase membership, so this filters
//                    the already-fetched page by cross-referencing
//                    target.id against every workflow's node list — the
//                    same technique AttentionStrip.tsx's
//                    buildNodeWorkflowMap already uses for the same reason.
//   - date range  -> BOTH. `from`/`to` are passed to the server (the real
//                    verb documents and honours them), but this fixture
//                    set's mock handler (src/api/client.ts, out of scope
//                    to change here) does not filter on them, so the exact
//                    same bounds are re-applied client-side too — a no-op
//                    against a live backend that already filtered, a real
//                    filter against fixture mode.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNodes, useWorkflows } from '../../api/hooks';
import { changesListEvents, type ChangeEvent } from '../../api/verbs';
import { Btn } from '../../components/primitives';
import { Skeleton } from '../../components/Skeleton';
import { useStore } from '../../store';
import type { Workflow } from '../../types';
import { readLastVisit, writeLastVisit, useActivityBaseline } from './activityNav';

// ---------------------------------------------------------------------
// Test-only failure injection — identical pattern to AttentionStrip.tsx's
// `__ATTN_FORCE_FAILURE__` (see tests/deck.spec.ts). Fixture mode's mock
// handler for changes_list always succeeds, so this is the only way to
// exercise "the call failed" deterministically in Playwright. A `window`
// global (not a module-level flag) so `page.addInitScript` can pre-arm it
// before the very first fetch on a cold load.
// ---------------------------------------------------------------------
declare global {
  interface Window {
    __ACTIVITY_FORCE_FAILURE__?: string | null;
  }
}
export function __test_setActivityFailure(message: string | null): void {
  if (typeof window !== 'undefined') window.__ACTIVITY_FORCE_FAILURE__ = message;
}
export function __test_resetActivityFailure(): void {
  __test_setActivityFailure(null);
}

interface ServerArgs {
  nodeId?: string;
  actorKind?: 'human' | 'agent' | 'system';
  operation?: string;
  source?: string;
  from?: string;
  to?: string;
}

async function fetchActivityPage(args: ServerArgs, cursor: string | undefined) {
  const forced = typeof window !== 'undefined' ? window.__ACTIVITY_FORCE_FAILURE__ : null;
  if (forced) throw new Error(forced);
  return changesListEvents({ ...args, cursor, limit: 25 });
}

function buildNodeWorkflowMap(workflows: Workflow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const wf of workflows) {
    for (const [, ids] of wf.phases) {
      for (const id of ids) if (!map.has(id)) map.set(id, wf.id);
    }
  }
  return map;
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
}

const CHANGE_KIND_LABELS: Record<string, string> = {
  'node.prompt_updated': 'Prompt updated',
  'node.playbook_delta_applied': 'Playbook delta applied',
  'node.model_config_updated': 'Model config updated',
  'node.tools_updated': 'Tools updated',
  'node.output_schema_updated': 'Output schema updated',
  'node.input_schema_updated': 'Input schema updated',
  'node.skills_updated': 'Skills updated',
};

function changeKindLabel(type: string): string {
  return CHANGE_KIND_LABELS[type] ?? type.replace(/^node\./, '').replace(/_/g, ' ');
}

const ACTOR_GLYPH: Record<string, string> = { human: '◉', agent: '◆', system: '▣' };

function ActorBadge({ actor }: { actor?: ChangeEvent['actor'] }) {
  const kind = actor?.kind ?? 'unknown';
  const glyph = ACTOR_GLYPH[kind] ?? '?';
  const label = actor?.label ?? actor?.id ?? kind;
  return (
    <span className={`actor-badge actor-${kind}`}>
      <span className="actor-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="actor-kind">{kind}</span>
      <span className="actor-label">{label}</span>
    </span>
  );
}

const WHEN_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return WHEN_FMT.format(new Date(t));
}

function canOpenDiff(e: ChangeEvent): boolean {
  return Boolean(e.target?.id && e.parentRevisionId && e.resultingRevisionId);
}

/**
 * One feed entry. Exported so Flywheel.tsx's "recent activity" preview
 * column reuses the exact same row instead of a second, drifting copy.
 */
export function ActivityRow({
  event,
  isNew,
  compact,
}: {
  event: ChangeEvent;
  isNew: boolean;
  compact?: boolean;
}) {
  const openModal = useStore((s) => s.openModal);
  const nodeId = event.target?.id;
  const openable = canOpenDiff(event);

  function openDiff() {
    if (!openable || !nodeId) return;
    openModal('diff', {
      mode: 'revisions',
      node: nodeId,
      revA: event.parentRevisionId as string,
      revB: event.resultingRevisionId as string,
    });
  }

  return (
    <div className={`actrow${compact ? ' compact' : ''}${isNew ? ' act-new' : ''}`}>
      <span className="when mono">{formatWhen(event.createdAt)}</span>
      <span className="actrow-body">
        <span className="actrow-head">
          <ActorBadge actor={event.actor} />
          <span className="mono actrow-node">{nodeId ?? '—'}</span>
          <span className="actrow-kind">{changeKindLabel(event.type)}</span>
          {isNew && (
            <span className="chip-learned" title="newer than your last visit">
              new
            </span>
          )}
        </span>
        {event.reason && <p className="actrow-reason">{event.reason}</p>}
      </span>
      <Btn
        className="actrow-diffbtn"
        onClick={openDiff}
        disabled={!openable}
        title={openable ? undefined : 'This event is missing one of the two revisions needed to compare.'}
      >
        diff & merge studio
      </Btn>
    </div>
  );
}

const ACTOR_KIND_OPTIONS: Array<'human' | 'agent' | 'system'> = ['human', 'agent', 'system'];

export function Activity() {
  const [nodeId, setNodeId] = useState('');
  const [actorKind, setActorKind] = useState<'' | 'human' | 'agent' | 'system'>('');
  const [operation, setOperation] = useState('');
  const [source, setSource] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const nodesQ = useNodes();
  const workflowsQ = useWorkflows();
  const baselineQ = useActivityBaseline();

  const nodeWorkflowMap = useMemo(() => buildNodeWorkflowMap(workflowsQ.data ?? []), [workflowsQ.data]);
  const nodes = useMemo(() => [...(nodesQ.data ?? [])].sort((a, b) => a.id.localeCompare(b.id)), [nodesQ.data]);
  const operationOptions = useMemo(
    () => distinct((baselineQ.data?.events ?? []).map((e) => e.operation)),
    [baselineQ.data],
  );
  const sourceOptions = useMemo(
    () => distinct((baselineQ.data?.events ?? []).map((e) => e.source)),
    [baselineQ.data],
  );

  const from = fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined;
  const to = toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined;

  const serverArgs: ServerArgs = useMemo(
    () => ({
      nodeId: nodeId || undefined,
      actorKind: actorKind || undefined,
      operation: operation || undefined,
      source: source || undefined,
      from,
      to,
    }),
    [nodeId, actorKind, operation, source, from, to],
  );

  const feedQ = useInfiniteQuery({
    queryKey: ['changes', 'activity-feed', serverArgs],
    queryFn: ({ pageParam }) => fetchActivityPage(serverArgs, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  // "Visiting" this feed is what marks everything caught up — captured
  // BEFORE the write below, so this mount's own rows still show "new"
  // against the visit that came before it, then the boundary moves for
  // next time. Same two-step (read-then-write-after-paint) Rail.tsx uses
  // for the identical key.
  const lastVisitRef = useRef<number>(readLastVisit());
  useEffect(() => {
    writeLastVisit(Date.now());
  }, []);

  const rawEvents = useMemo(() => (feedQ.data?.pages ?? []).flatMap((p) => p.events), [feedQ.data]);
  const events = useMemo(() => {
    let list = rawEvents;
    if (workflowId) list = list.filter((e) => nodeWorkflowMap.get(e.target?.id ?? '') === workflowId);
    if (from) list = list.filter((e) => Date.parse(e.createdAt) >= Date.parse(from));
    if (to) list = list.filter((e) => Date.parse(e.createdAt) <= Date.parse(to));
    return [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [rawEvents, workflowId, nodeWorkflowMap, from, to]);

  const filtersBar = (
    <div className="filters">
      <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} aria-label="filter by workflow">
        <option value="">workflow: all</option>
        {(workflowsQ.data ?? []).map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label="filter by node">
        <option value="">node: all</option>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.id}
          </option>
        ))}
      </select>
      <select
        value={actorKind}
        onChange={(e) => setActorKind(e.target.value as '' | 'human' | 'agent' | 'system')}
        aria-label="filter by actor kind"
      >
        <option value="">actor: all</option>
        {ACTOR_KIND_OPTIONS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <select value={operation} onChange={(e) => setOperation(e.target.value)} aria-label="filter by change type">
        <option value="">change type: all</option>
        {operationOptions.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="filter by source">
        <option value="">source: all</option>
        {sourceOptions.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <input
        type="date"
        value={fromDate}
        onChange={(e) => setFromDate(e.target.value)}
        aria-label="filter from date"
      />
      <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="filter to date" />
    </div>
  );

  if (feedQ.isLoading) {
    return (
      <section className="card act-strip act-strip--loading" aria-busy="true" aria-label="Activity">
        <span className="lbl">activity</span>
        {filtersBar}
        <Skeleton lines={4} />
      </section>
    );
  }

  if (feedQ.isError) {
    return (
      <section className="card act-strip act-strip--error" role="alert" aria-label="Activity">
        <span className="lbl">activity</span>
        {filtersBar}
        <p className="attn-error-msg">
          The activity feed could not load — that is not the same thing as nothing having changed.
        </p>
        <p className="mono attn-error-detail">
          {feedQ.error instanceof Error ? feedQ.error.message : 'changes_list failed.'}
        </p>
        <Btn onClick={() => feedQ.refetch()}>Retry</Btn>
      </section>
    );
  }

  return (
    <section className="card act-strip act-strip--items" aria-label="Activity">
      <span className="lbl">activity · {events.length} shown</span>
      {filtersBar}
      {events.length === 0 ? (
        <p className="note act-strip--empty" style={{ marginTop: 0 }}>
          No changes match these filters — nothing recorded, or narrow filters. Try widening the actor, node, or
          date range above.
        </p>
      ) : (
        <div className="actlist">
          {events.map((e) => (
            <ActivityRow key={e.eventId} event={e} isNew={Date.parse(e.createdAt) > lastVisitRef.current} />
          ))}
        </div>
      )}
      {feedQ.hasNextPage && (
        <Btn onClick={() => feedQ.fetchNextPage()} disabled={feedQ.isFetchingNextPage} style={{ marginTop: 10 }}>
          {feedQ.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Btn>
      )}
      <p className="note">
        changes_list · server-filtered by node, actor kind, change type (operation), and source; workflow and date
        range narrow the results shown here
      </p>
    </section>
  );
}
