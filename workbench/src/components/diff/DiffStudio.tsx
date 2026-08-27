// U2 — the diff & merge studio. Replaces the History tab's raw-JSON-with-
// strikethrough diff (Wolf: "unreadable") with a readable, type-aware diff
// (prose gets word-level highlighting; every other field gets a
// field-by-field row; a deep object gets pretty-printed + line/word-diffed,
// never a JSON.stringify wall) — and a third, EDITABLE pane so an operator
// can act on what they're looking at instead of just reading it.
//
// ============================== params ======================================
// Flat strings only — they round-trip through the URL (see overlay/types.ts).
//
//   mode        required. Names the comparison:
//                 'revisions' — two revisions of one node's history
//                 'canonical' — the stored node vs the canonical prompt
//                               (first observed this session — the same
//                               baseline PromptTab's own "Diff vs canonical"
//                               uses, Shared.tsx's canonicalPromptFor)
//                 'effective' — the node's own prompt vs node_get_effective_
//                               prompt, playbook/skill injection banded
//                 'proposal'  — current prompt vs an optimizer proposal
//                 'pair'      — a Learning → Compare candidate pair
//   node        required for every mode — the node id being compared.
//   revA        'revisions' mode — the FROM revision id.
//   revB        'revisions' mode — the TO revision id.
//   proposalId  'proposal' mode — the optimizer proposal id.
//   pairIndex   'pair' mode — index into the Compare screen's queue.
//
// Missing/unresolvable params never render a blank modal or throw — see
// buildDiffData()'s error branches, one per named failure.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as verbs from '../../api/verbs';
import type { ChangeEvent } from '../../api/verbs';
import { useNode } from '../../api/hooks';
import { useEffectivePrompt } from '../../screens/Workbench/queries';
import { canonicalPromptFor } from '../../screens/Workbench/tabs/Shared';
import { ActionCancelledError } from '../../api/confirmAction';
import { IS_MOCK, IS_READ_ONLY } from '../../api/client';
import { Modal } from '../overlay/Modal';
import { overlayKey } from '../../overlay/types';
import { saveDraft, readDraft, clearDraft } from '../../overlay/drafts';
import { setNextConfirmTrigger } from '../ConfirmDialog';
import { toast } from '../Toasts';
import { Btn, Card } from '../primitives';
import { Skeleton } from '../Skeleton';
import { ProseDiffView } from './ProseDiffView';
import { FieldsDiffView } from './FieldsDiffView';
import { diffFields } from './structuredDiff';
import { autoMergeText, computeProseDiff } from './textDiff';
import comparePairsFixture from '../../api/fixtures/comparePairs.json';
import type { ComparePair } from '../../types';

type Mode = 'revisions' | 'canonical' | 'effective' | 'proposal' | 'pair';

const QUEUE = comparePairsFixture as ComparePair[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// "remember the choice for the session" — a module-level default, not
// localStorage: resets on a real reload, holds steady across every
// open/close of the studio within this tab.
let sessionLayout: 'split' | 'inline' = 'split';

interface DiffMeta {
  label: string;
  actorLabel?: string;
  actorKind?: string;
  reason?: string;
  when?: string;
}

interface DiffData {
  nodeId: string;
  leftLabel: string;
  rightLabel: string;
  leftMeta: DiffMeta;
  rightMeta: DiffMeta;
  leftPrompt: string;
  rightPrompt: string;
  leftSnapshot?: Record<string, unknown> | null;
  rightSnapshot?: Record<string, unknown> | null;
  playbookLayer?: boolean;
  restorable?: { leftRevisionId?: string; rightRevisionId?: string };
  note?: string;
  savable: boolean;
  /** Which side the Result pane seeds from by default. Every mode defaults
   * to the auto-merge; 'pair' mode seeds from the champion instead — two
   * independently-written candidates aren't a revision history, so
   * auto-merging them line-by-line would just manufacture conflict
   * markers between two unrelated pieces of prose. */
  defaultSeed: 'left' | 'right' | 'merge';
}

type DiffResult = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: DiffData };

function shortId(id: string): string {
  return id.length > 14 ? `…${id.slice(-10)}` : id;
}

function metaFromEvent(e: ChangeEvent | undefined, fallbackLabel: string): DiffMeta {
  if (!e) return { label: fallbackLabel };
  return {
    label: fallbackLabel,
    actorLabel: e.actor?.label ?? e.actor?.id ?? e.actor?.kind,
    actorKind: e.actor?.kind,
    reason: e.reason,
    when: e.createdAt,
  };
}

export function DiffStudio({ params, onClose }: { params: Record<string, string>; onClose: () => void }) {
  const mode = (params.mode ?? '') as Mode | '';
  const node = params.node ?? '';
  const qc = useQueryClient();

  // -- every query the five modes might need, gated by `enabled` so only
  // the one this mode actually uses ever fires (same pattern as
  // screens/Workbench/queries.ts). --
  const eventsQ = useQuery({
    queryKey: ['changeEvents', node],
    queryFn: () => verbs.changesListEvents({ nodeId: node }),
    enabled: mode === 'revisions' && Boolean(node),
  });
  const nodeQ = useNode(node || null, {
    enabled: (mode === 'canonical' || mode === 'effective' || mode === 'proposal') && Boolean(node),
  });
  const effectiveQ = useEffectivePrompt(node || null, { enabled: mode === 'effective' && Boolean(node) });
  const optimizerQ = useQuery({
    queryKey: ['optimizerStatus', node],
    queryFn: () => verbs.optimizerStatus({ nodeId: node }),
    enabled: mode === 'proposal' && Boolean(node),
  });

  const result: DiffResult = useMemo(() => {
    if (!mode) return { status: 'error', message: 'No comparison mode given — nothing to compare.' };
    if (!node) return { status: 'error', message: 'No node given — nothing to compare.' };

    if (mode === 'revisions') {
      const revA = params.revA ?? '';
      const revB = params.revB ?? '';
      if (!revA || !revB) {
        return { status: 'error', message: 'This comparison needs both revA and revB — one or both are missing.' };
      }
      if (eventsQ.isLoading) return { status: 'loading' };
      if (eventsQ.isError) return { status: 'error', message: eventsQ.error instanceof Error ? eventsQ.error.message : 'Failed to load change history.' };
      const events = eventsQ.data?.events ?? [];
      const snapshotOf = new Map<string, unknown>();
      const producedBy = new Map<string, ChangeEvent>();
      for (const e of events) {
        if (e.parentRevisionId && !snapshotOf.has(e.parentRevisionId)) snapshotOf.set(e.parentRevisionId, e.before);
        if (e.resultingRevisionId) {
          snapshotOf.set(e.resultingRevisionId, e.after);
          producedBy.set(e.resultingRevisionId, e);
        }
      }
      const snapA = snapshotOf.get(revA);
      const snapB = snapshotOf.get(revB);
      const missing = [snapA === undefined ? revA : null, snapB === undefined ? revB : null].filter(Boolean);
      if (missing.length > 0) {
        return {
          status: 'error',
          message: `Revision${missing.length > 1 ? 's' : ''} ${missing.join(' and ')} ${missing.length > 1 ? "don't" : "doesn't"} appear in ${node}'s recorded change history.`,
        };
      }
      const eventA = producedBy.get(revA);
      const eventB = producedBy.get(revB);
      const leftSnapshot = isRecord(snapA) ? snapA : null;
      const rightSnapshot = isRecord(snapB) ? snapB : null;
      const data: DiffData = {
        nodeId: node,
        leftLabel: `revision ${shortId(revA)}`,
        rightLabel: `revision ${shortId(revB)}`,
        leftMeta: metaFromEvent(eventA, 'no recorded event produced this revision — likely the earliest known state'),
        rightMeta: metaFromEvent(eventB, 'no recorded event produced this revision'),
        leftPrompt: typeof leftSnapshot?.prompt === 'string' ? leftSnapshot.prompt : '',
        rightPrompt: typeof rightSnapshot?.prompt === 'string' ? rightSnapshot.prompt : '',
        leftSnapshot,
        rightSnapshot,
        restorable: { leftRevisionId: revA, rightRevisionId: revB },
        savable: true,
        defaultSeed: 'merge',
      };
      return { status: 'ready', data };
    }

    if (mode === 'canonical') {
      if (!IS_MOCK) {
        return { status: 'error', message: "Stored vs canonical is only available in fixture mode — no live verb returns a node's seeded definition." };
      }
      if (nodeQ.isLoading) return { status: 'loading' };
      if (nodeQ.isError) return { status: 'error', message: nodeQ.error instanceof Error ? nodeQ.error.message : 'Failed to load the node.' };
      if (!nodeQ.data) return { status: 'error', message: `Node "${node}" was not found.` };
      const stored = nodeQ.data.prompt ?? '';
      const canonical = canonicalPromptFor(node, stored);
      const data: DiffData = {
        nodeId: node,
        leftLabel: 'canonical (first observed this session)',
        rightLabel: 'stored (current)',
        leftMeta: { label: 'canonical snapshot' },
        rightMeta: { label: 'current node record', when: nodeQ.data.updatedAt },
        leftPrompt: canonical,
        rightPrompt: stored,
        savable: true,
        defaultSeed: 'merge',
        note: 'Canonical here is the prompt first observed this session for this node — the same baseline the Prompt tab\'s own "Diff vs canonical" view uses, not a persisted seed record.',
      };
      return { status: 'ready', data };
    }

    if (mode === 'effective') {
      // U7 polish — error checked before loading (mirrors Rail.tsx's
      // P2-02 fix): two independent queries, so checking the combined
      // loading first used to hide an already-final error on one query
      // behind "loading" for as long as the other was still in flight.
      if (nodeQ.isError) return { status: 'error', message: nodeQ.error instanceof Error ? nodeQ.error.message : 'Failed to load the node.' };
      if (effectiveQ.isError) return { status: 'error', message: effectiveQ.error instanceof Error ? effectiveQ.error.message : 'Failed to resolve the effective prompt.' };
      if (nodeQ.isLoading || effectiveQ.isLoading) return { status: 'loading' };
      if (!nodeQ.data) return { status: 'error', message: `Node "${node}" was not found.` };
      const stored = nodeQ.data.prompt ?? '';
      const effective = effectiveQ.data?.prompt ?? '';
      const identical = stored === effective;
      const data: DiffData = {
        nodeId: node,
        leftLabel: 'stored (operator-authored)',
        rightLabel: 'effective (resolved at run time)',
        leftMeta: { label: 'stored prompt' },
        rightMeta: {
          label: `effective prompt · source: ${effectiveQ.data?.source ?? 'unknown'}${effectiveQ.data?.diverged ? ' · diverged' : ''}`,
        },
        leftPrompt: stored,
        rightPrompt: effective,
        playbookLayer: true,
        savable: true,
        defaultSeed: 'merge',
        note: identical
          ? 'Stored and effective are identical — node_get_effective_prompt echoes the stored prompt in fixture mode, so there is no playbook/skill injection to show here. Lines that only appear on the right would be labelled "playbook injection".'
          : 'Lines that only appear on the right are labelled "playbook injection" — content the node did not author itself.',
      };
      return { status: 'ready', data };
    }

    if (mode === 'proposal') {
      const proposalId = params.proposalId ?? '';
      if (!proposalId) return { status: 'error', message: 'No proposalId given — nothing to compare against.' };
      // U7 polish — error checked before loading, same reasoning as the
      // 'effective' branch above.
      if (nodeQ.isError) return { status: 'error', message: nodeQ.error instanceof Error ? nodeQ.error.message : 'Failed to load the node.' };
      if (optimizerQ.isError) return { status: 'error', message: optimizerQ.error instanceof Error ? optimizerQ.error.message : 'Failed to load optimizer status.' };
      if (nodeQ.isLoading || optimizerQ.isLoading) return { status: 'loading' };
      if (!nodeQ.data) return { status: 'error', message: `Node "${node}" was not found.` };
      const proposals = optimizerQ.data?.proposals ?? [];
      const proposal = proposals.find((p) => isRecord(p) && p.proposalId === proposalId);
      if (!proposal || !isRecord(proposal)) {
        return {
          status: 'error',
          message: `Proposal ${proposalId} not found for node ${node} — optimizer_status returned no matching proposal (proposals aren't persisted across calls in fixture mode).`,
        };
      }
      const promptDiff = typeof proposal.promptDiff === 'string' ? proposal.promptDiff : '';
      if (!promptDiff) {
        return { status: 'error', message: `Proposal ${proposalId} has no prompt diff recorded (optimizer_propose returned an empty promptDiff).` };
      }
      const data: DiffData = {
        nodeId: node,
        leftLabel: 'current',
        rightLabel: 'proposed (raw promptDiff field)',
        leftMeta: { label: 'current stored prompt' },
        rightMeta: { label: `optimizer proposal ${proposalId}`, when: typeof proposal.createdAt === 'string' ? proposal.createdAt : undefined },
        leftPrompt: nodeQ.data.prompt ?? '',
        rightPrompt: promptDiff,
        savable: true,
        defaultSeed: 'merge',
        note: 'This optimizer proposal only exposes one promptDiff field, not separate before/after prompt text — shown here as the right-hand side verbatim.',
      };
      return { status: 'ready', data };
    }

    // mode === 'pair'
    const pairIndexRaw = params.pairIndex ?? '';
    const idx = Number(pairIndexRaw);
    if (pairIndexRaw === '' || !Number.isInteger(idx)) {
      return { status: 'error', message: 'No valid pairIndex given — nothing to compare.' };
    }
    const pair = QUEUE[idx];
    if (!pair) {
      return { status: 'error', message: `No compare pair at index ${idx} — the illustrative queue has ${QUEUE.length} pair(s).` };
    }
    if (pair.kind !== 'text') {
      return { status: 'error', message: `Compare pair ${idx} is a "${pair.kind}" candidate — edit-on-top only supports text candidates.` };
    }
    const data: DiffData = {
      nodeId: pair.node,
      leftLabel: `Candidate A${pair.champ === 'A' ? ' (preferred)' : ''}`,
      rightLabel: `Candidate B${pair.champ === 'B' ? ' (preferred)' : ''}`,
      leftMeta: { label: pair.brief },
      rightMeta: { label: `node: ${pair.node}` },
      leftPrompt: pair.a,
      rightPrompt: pair.b,
      savable: false,
      defaultSeed: pair.champ === 'A' ? 'left' : 'right',
      note: "Compare pairs hold generated candidate content, not this node's prompt — no verb exists to persist edited candidate text yet. Use Copy to take it elsewhere.",
    };
    return { status: 'ready', data };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, node, params.revA, params.revB, params.proposalId, params.pairIndex, eventsQ.data, eventsQ.isLoading, eventsQ.isError, nodeQ.data, nodeQ.isLoading, nodeQ.isError, effectiveQ.data, effectiveQ.isLoading, effectiveQ.isError, optimizerQ.data, optimizerQ.isLoading, optimizerQ.isError]);

  // ------------------------------ layout state -------------------------------
  // "remember the choice for the session" — a module-level default, not
  // localStorage: resets on a real reload, holds steady across every open/
  // close of the studio within this tab.
  const [layout, setLayoutState] = useState<'split' | 'inline'>(sessionLayout);
  function setLayout(v: 'split' | 'inline') {
    sessionLayout = v;
    setLayoutState(v);
  }
  const [fullSize, setFullSize] = useState(false);

  // ------------------------------ result pane ---------------------------------
  const draftKey = overlayKey({ kind: 'diff', params });
  const [resultText, setResultText] = useState<string | null>(() => readDraft<string>(draftKey) ?? null);
  const resultRef = useRef(resultText);
  useEffect(() => {
    resultRef.current = resultText;
  }, [resultText]);
  const committedRef = useRef(false);

  useEffect(() => {
    if (resultText !== null) return; // draft already restored, or already seeded
    if (result.status !== 'ready') return;
    const { leftPrompt, rightPrompt, leftLabel, rightLabel, defaultSeed } = result.data;
    if (defaultSeed === 'left') setResultText(leftPrompt);
    else if (defaultSeed === 'right') setResultText(rightPrompt);
    else setResultText(autoMergeText(leftPrompt, rightPrompt, leftLabel, rightLabel).text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Escape must never lose typed work — persist on unmount, clear only on commit.
  useEffect(() => {
    return () => {
      if (!committedRef.current && resultRef.current !== null) saveDraft(draftKey, resultRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<'left' | 'right' | null>(null);

  const nonPromptChangedFields = useMemo(() => {
    if (result.status !== 'ready') return [];
    if (!result.data.leftSnapshot || !result.data.rightSnapshot) return [];
    return diffFields(result.data.leftSnapshot, result.data.rightSnapshot, { exclude: ['prompt'] }).changed.map((r) => r.key);
  }, [result]);

  async function handleSave(triggerEl: HTMLElement | null) {
    if (result.status !== 'ready' || resultText === null || saving) return;
    setNextConfirmTrigger(triggerEl);
    setSaving(true);
    try {
      await verbs.workspaceUpdateNodePrompt({ nodeId: result.data.nodeId, prompt: resultText });
      committedRef.current = true;
      clearDraft(draftKey);
      await qc.invalidateQueries({ queryKey: ['node', result.data.nodeId] });
      await qc.invalidateQueries({ queryKey: ['effectivePrompt', result.data.nodeId] });
      await qc.invalidateQueries({ queryKey: ['changes', result.data.nodeId] });
      const caveat =
        nonPromptChangedFields.length > 0
          ? ` — this comparison also changed ${nonPromptChangedFields.join(', ')}; those need their own verb(s) and this studio doesn't write them yet, so only the prompt was saved.`
          : '';
      toast('Prompt saved', `workspace_update_node_prompt → ${result.data.nodeId}${caveat}`);
      onClose();
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Save failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRestore(side: 'left' | 'right', triggerEl: HTMLElement | null) {
    if (result.status !== 'ready' || restoring) return;
    const revisionId = side === 'left' ? result.data.restorable?.leftRevisionId : result.data.restorable?.rightRevisionId;
    if (!revisionId) return;
    setNextConfirmTrigger(triggerEl);
    setRestoring(side);
    try {
      await verbs.changesRestore({ nodeId: result.data.nodeId, revisionId });
      await qc.invalidateQueries({ queryKey: ['node', result.data.nodeId] });
      await qc.invalidateQueries({ queryKey: ['changes', result.data.nodeId] });
      toast('Restored', `changes_restore → ${result.data.nodeId} @ ${revisionId}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Restore failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRestoring(null);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(resultText ?? '');
      toast('Copied', 'Result pane text copied to clipboard.');
    } catch {
      toast('Copy failed', 'Clipboard access was blocked by the browser.');
    }
  }

  function seedFrom(which: 'left' | 'right' | 'merge') {
    if (result.status !== 'ready') return;
    if (which === 'left') setResultText(result.data.leftPrompt);
    else if (which === 'right') setResultText(result.data.rightPrompt);
    else setResultText(autoMergeText(result.data.leftPrompt, result.data.rightPrompt, result.data.leftLabel, result.data.rightLabel).text);
  }

  const sub =
    result.status === 'ready' ? `${result.data.leftLabel} → ${result.data.rightLabel} · ${result.data.nodeId}` : mode ? `${mode} · ${node || '—'}` : undefined;

  return (
    <Modal open onClose={onClose} title="Diff & merge studio" size={fullSize ? 'full' : 'work'} sub={sub}>
      {result.status === 'loading' && <Skeleton lines={6} />}

      {result.status === 'error' && (
        <Card label="nothing to compare">
          <p className="note" style={{ marginTop: 0 }}>
            {result.message}
          </p>
        </Card>
      )}

      {result.status === 'ready' && (
        <>
          <div className="dsmeta">
            <div className="dsmetaside">
              <span className="lbl">{result.data.leftLabel}</span>
              <MetaLine meta={result.data.leftMeta} />
            </div>
            <div className="dsmetaside">
              <span className="lbl">{result.data.rightLabel}</span>
              <MetaLine meta={result.data.rightMeta} />
            </div>
          </div>

          <div className="dscontrols">
            <div className="seg" style={{ maxWidth: 220 }}>
              <button type="button" className={layout === 'split' ? 'on' : ''} aria-pressed={layout === 'split'} onClick={() => setLayout('split')}>
                side by side
              </button>
              <button type="button" className={layout === 'inline' ? 'on' : ''} aria-pressed={layout === 'inline'} onClick={() => setLayout('inline')}>
                inline
              </button>
            </div>
            <Btn aria-pressed={fullSize} onClick={() => setFullSize((v) => !v)} style={{ marginLeft: 8 }}>
              {fullSize ? 'exit full' : 'full screen'}
            </Btn>
          </div>

          <Card label="prompt">
            <ProseDiffView
              lines={computeProseDiff(result.data.leftPrompt, result.data.rightPrompt)}
              layout={layout}
              leftLabel={result.data.leftLabel}
              rightLabel={result.data.rightLabel}
              playbookLayer={result.data.playbookLayer}
            />
          </Card>

          {(result.data.leftSnapshot || result.data.rightSnapshot) && (
            <Card label="other fields">
              <FieldsDiffView before={result.data.leftSnapshot} after={result.data.rightSnapshot} />
            </Card>
          )}

          {result.data.note && <p className="note">{result.data.note}</p>}

          <Card label="result — edit on top of the comparison">
            <div className="editnote" style={{ marginTop: 0 }}>
              <Btn onClick={() => seedFrom('left')}>seed: {result.data.leftLabel}</Btn>
              <Btn onClick={() => seedFrom('right')}>seed: {result.data.rightLabel}</Btn>
              <Btn onClick={() => seedFrom('merge')}>seed: auto-merge</Btn>
            </div>
            <label htmlFor="diffstudio-result" className="lbl" style={{ display: 'block', margin: '10px 0 6px' }}>
              result (editable)
            </label>
            <textarea
              id="diffstudio-result"
              className="mono"
              style={{
                width: '100%',
                minHeight: fullSize ? 360 : 200,
                background: 'var(--bg)',
                color: 'var(--ink)',
                border: '1px solid var(--line2)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 12,
                resize: 'vertical',
              }}
              value={resultText ?? ''}
              onChange={(e) => setResultText(e.target.value)}
              disabled={IS_READ_ONLY}
              spellCheck={false}
            />
            {!result.data.savable && <p className="note">{result.data.note}</p>}
            {result.data.savable && nonPromptChangedFields.length > 0 && (
              <p className="note" style={{ color: 'var(--acc)' }}>
                This comparison also changed {nonPromptChangedFields.join(', ')} — saving here only writes the prompt
                (workspace_update_node_prompt); those other fields need their own verb, and this studio doesn&rsquo;t
                write them yet.
              </p>
            )}
            <div className="editnote">
              <Btn
                variant="pri"
                disabled={!result.data.savable || IS_READ_ONLY || saving || resultText === null}
                title={!result.data.savable ? 'Nothing writable in this comparison — see the note above.' : undefined}
                onClick={(e) => handleSave(e.currentTarget)}
              >
                {saving ? 'Saving…' : 'Save as new revision'}
              </Btn>
              {result.data.restorable?.leftRevisionId && (
                <Btn disabled={IS_READ_ONLY || Boolean(restoring)} onClick={(e) => handleRestore('left', e.currentTarget)}>
                  {restoring === 'left' ? 'restoring…' : `Restore ${result.data.leftLabel}`}
                </Btn>
              )}
              {result.data.restorable?.rightRevisionId && (
                <Btn disabled={IS_READ_ONLY || Boolean(restoring)} onClick={(e) => handleRestore('right', e.currentTarget)}>
                  {restoring === 'right' ? 'restoring…' : `Restore ${result.data.rightLabel}`}
                </Btn>
              )}
              <Btn onClick={handleCopy}>Copy result</Btn>
            </div>
          </Card>
        </>
      )}
    </Modal>
  );
}

function MetaLine({ meta }: { meta: DiffMeta }) {
  return (
    <div className="note" style={{ marginTop: 4 }}>
      {meta.actorLabel && (
        <div>
          <span className="chip">{meta.actorKind ?? 'actor'}</span> {meta.actorLabel}
        </div>
      )}
      {meta.reason && <div style={{ marginTop: 2 }}>{meta.reason}</div>}
      {meta.when && <div style={{ marginTop: 2 }}>{new Date(meta.when).toLocaleString()}</div>}
      {!meta.actorLabel && !meta.reason && !meta.when && <div>{meta.label}</div>}
    </div>
  );
}
