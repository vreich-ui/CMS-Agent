// Learning → Compare (WP-52). Pairwise A/B on candidate outputs. The done-
// criterion is literal — "ten verdicts must take under twenty seconds by
// keyboard alone" — so this screen is designed around that, not around the
// rest of the app's one-mutation-one-modal convention:
//
//   - Keys 1/2/0/x record a verdict with no modifier and no confirm step,
//     advancing to the next pair immediately.
//   - Blind mode (default on) hides which candidate is the champion; the
//     reveal happens in the "last verdict" strip and the toast right after
//     recording, never by delaying the advance.
//   - Every verdict still calls the real, confirm-gated `feedback_record`
//     verb (never callVerb/confirmAction directly) — but a full-screen
//     modal per verdict would make the twenty-second budget impossible, so
//     while this screen is mounted it swaps in a silent confirm handler via
//     `setConfirmHandler` (an exported, designed-for-override extension
//     point — see api/confirmAction.ts — not a modification of that file)
//     and restores the real modal on unmount. feedback_record is never
//     `danger`, and read-only mode still refuses it before the handler is
//     even asked, so nothing here weakens either safety mechanism — it only
//     removes a click that this one screen was explicitly speced not to
//     have.
//   - The mutation itself is fired in the background (not awaited before
//     advancing) so a slow network never stalls the next keystroke; a
//     failed call surfaces as a toast rather than silently losing the
//     verdict.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import comparePairsFixture from '../../api/fixtures/comparePairs.json';
import * as verbs from '../../api/verbs';
import { setConfirmHandler } from '../../api/confirmAction';
import { requestConfirm } from '../../components/ConfirmDialog';
import { Btn } from '../../components/primitives';
import { toast } from '../../components/Toasts';
import { useStore } from '../../store';
import type { ComparePair } from '../../types';

// No live "compare queue" verb exists on this MCP surface (see
// api/fixtures/README.md) — these three pairs are the mockup's CMP_QUEUE,
// reshaped, and are illustrative rather than real work. Said plainly in the
// UI below rather than presented as a live queue.
const QUEUE = comparePairsFixture as ComparePair[];

type Verdict = 'A' | 'B' | 'tie' | 'bad';

function verdictLabel(v: Verdict): string {
  return v === 'A' ? 'A preferred' : v === 'B' ? 'B preferred' : v === 'tie' ? 'tie' : 'both bad';
}

function candidateBody(pair: ComparePair, side: 'A' | 'B') {
  const val = side === 'A' ? pair.a : pair.b;
  if (pair.kind === 'text') return <div className="body">{val}</div>;
  if (pair.kind === 'image') return <div className="imgph" style={{ background: val }} />;
  return val === 'img-top' ? (
    <div className="tpl">
      <i style={{ height: 56 }} />
      <i style={{ height: 12, width: '70%' }} />
      <i style={{ height: 8, width: '90%' }} />
      <i style={{ height: 8, width: '60%' }} />
      <i style={{ height: 10, width: '34%', background: 'var(--acc-dim)' }} />
    </div>
  ) : (
    <div className="tpl" style={{ flexDirection: 'row', gap: 10 }}>
      <i style={{ width: '42%', height: '100%' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <i style={{ height: 12, width: '80%' }} />
        <i style={{ height: 8 }} />
        <i style={{ height: 8, width: '70%' }} />
        <i style={{ height: 10, width: '44%', background: 'var(--acc-dim)' }} />
      </span>
    </div>
  );
}

export function Compare() {
  const pairsDone = useStore((s) => s.pairsDone);
  const cmpIdx = useStore((s) => s.cmpIdx);
  const recordVerdict = useStore((s) => s.recordVerdict);
  const [blind, setBlind] = useState(true);
  const [lastVerdict, setLastVerdict] = useState<{ pair: ComparePair; verdict: Verdict } | null>(null);
  const qc = useQueryClient();
  const busyRef = useRef(false);

  useEffect(() => {
    setConfirmHandler(() => true);
    return () => setConfirmHandler(requestConfirm);
  }, []);

  const openModal = useStore((s) => s.openModal);
  const pair = QUEUE[cmpIdx % QUEUE.length];

  // U2 — "edit on top of the winner": opens the diff & merge studio on this
  // pair (mode: 'pair'), seeded from the champion. Only text candidates are
  // editable prose — a template/image pair has nothing for a prompt-style
  // word diff to work on.
  function editOnTopOfWinner() {
    if (pair.kind !== 'text') {
      toast('Not editable here', `This pair is a "${pair.kind}" candidate — edit-on-top only works for text.`);
      return;
    }
    openModal('diff', { mode: 'pair', node: pair.node, pairIndex: String(cmpIdx % QUEUE.length) });
  }

  function submit(v: Verdict) {
    if (busyRef.current) return; // guard a double keydown firing in the same frame
    busyRef.current = true;
    const current = pair;
    recordVerdict(); // instant advance — pairsDone/cmpIdx bump synchronously, no network wait
    setLastVerdict({ pair: current, verdict: v });
    verbs
      .feedbackRecord({
        nodeId: current.node,
        verdict: v,
        note: `Compare pair · ${current.kind} · ${verdictLabel(v)}`,
      })
      .then(() => qc.invalidateQueries({ queryKey: ['readiness'] }))
      .catch((err) => {
        toast('Verdict not recorded', err instanceof Error ? err.message : 'Something went wrong.');
      });
    toast(
      `Verdict: ${verdictLabel(v)}`,
      `feedback_record + preference pair · ${pairsDone + 1}/200${blind ? ` · champion was ${current.champ}` : ''}`,
    );
    busyRef.current = false;
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.key === '1') submit('A');
      else if (e.key === '2') submit('B');
      else if (e.key === '0') submit('tie');
      else if (e.key.toLowerCase() === 'x') submit('bad');
      else if (e.key === 'Backspace' && lastVerdict) undo();
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair, blind, pairsDone, lastVerdict]);

  function undo() {
    useStore.setState((s) => ({ pairsDone: Math.max(0, s.pairsDone - 1), cmpIdx: Math.max(0, s.cmpIdx - 1) }));
    setLastVerdict(null);
    toast(
      'Verdict undone',
      'The pair is back in the queue and no longer counts toward your tally. The feedback_record already sent stays in the log — no delete verb exists to remove it, so record the corrected verdict now.',
    );
  }

  const showBadge = (side: 'A' | 'B') =>
    !blind ? (
      <span className={`chip ${pair.champ === side ? 'completed' : ''}`}>
        {pair.champ === side ? 'champion' : 'challenger'}
      </span>
    ) : null;

  return (
    <>
      <div className="cmpbar">
        <span className="lbl">
          pair {(cmpIdx % QUEUE.length) + 1} of {QUEUE.length} · {pair.node} · {pair.kind}
        </span>
        <span className="spacer" />
        <label style={{ display: 'flex', gap: 7, alignItems: 'center', color: 'var(--muted)', fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> blind mode (hide
          champion)
        </label>
        <span className="chip num">{pairsDone} / 200 preference pairs</span>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <span className="lbl">brief</span>
        <span style={{ fontSize: 13 }}>{pair.brief}</span>
      </div>

      <div className="cmp">
        <div className="cand">
          <div className="who">
            <span className="lbl">candidate A · key 1</span>
            {showBadge('A')}
          </div>
          {candidateBody(pair, 'A')}
        </div>
        <div className="cand">
          <div className="who">
            <span className="lbl">candidate B · key 2</span>
            {showBadge('B')}
          </div>
          {candidateBody(pair, 'B')}
        </div>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        <Btn onClick={editOnTopOfWinner} title="Open the diff & merge studio on this pair, seeded from the champion.">
          ✎ edit on top of winner
        </Btn>
      </div>

      <div className="verdicts">
        <Btn variant="pri" onClick={() => submit('A')}>
          A is better (1)
        </Btn>
        <Btn variant="pri" onClick={() => submit('B')}>
          B is better (2)
        </Btn>
        <Btn onClick={() => submit('tie')}>Tie (0)</Btn>
        <Btn variant="danger" onClick={() => submit('bad')}>
          Both bad (x)
        </Btn>
      </div>

      {lastVerdict && (
        <p className="note" style={{ textAlign: 'center' }}>
          Last: <b>{verdictLabel(lastVerdict.verdict)}</b> · champion was{' '}
          <span className="mono">{lastVerdict.pair.champ}</span> ·{' '}
          <Btn style={{ padding: '1px 8px', fontSize: 11 }} onClick={undo}>
            undo (Backspace)
          </Btn>
        </p>
      )}

      <p className="note" style={{ textAlign: 'center' }}>
        every verdict → feedback_record + a preference pair toward dataset_export_preferences · queue: 3
        illustrative pairs (mockup data — no live compare-queue verb exists yet; real sources would be optimizer
        trials, learning-mode candidate sets, or any two run outputs picked from History)
      </p>
    </>
  );
}
