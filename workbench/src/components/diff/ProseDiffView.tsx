// U2 — renders textDiff.ts's line/word diff. Two layouts:
//   split  — two independently-scrollable, independently-labelled panes
//            (a11y: each is its own `role="region"` with its own label —
//            not a single two-column grid pretending to be two panes).
//   inline — one unified column, removed lines then added lines per hunk.
//
// Never relies on colour alone: every added/removed line carries a +/−
// marker; every added/removed WORD inside a changed line carries its own
// marker glyph too, not just a tint.

import type { DiffOp, ProseLine } from './textDiff';
import { proseDiffIsEmpty } from './textDiff';

export type DiffLayout = 'split' | 'inline';

interface ProseDiffViewProps {
  lines: ProseLine[];
  layout: DiffLayout;
  leftLabel: string;
  rightLabel: string;
  /** When true, lines that exist only on the right (added relative to
   * left) are presented as a distinct "playbook injection" band instead of
   * plain add styling — U2's "stored vs effective" comparison. */
  playbookLayer?: boolean;
  playbookBandLabel?: string;
}

function WordSpans({ words, side }: { words: DiffOp<string>[] | undefined; side: 'before' | 'after' }) {
  if (!words) return null;
  return (
    <>
      {words.map((w, i) => {
        if (w.type === 'equal') return <span key={i}>{w.value}</span>;
        if (side === 'before' && w.type === 'remove') {
          return (
            <span key={i} className="dsword rm">
              {w.value}
            </span>
          );
        }
        if (side === 'after' && w.type === 'add') {
          return (
            <span key={i} className="dsword add">
              {w.value}
            </span>
          );
        }
        return null;
      })}
    </>
  );
}

/** One side's flow for split layout — only the lines that exist on this
 * side, in order, each still carrying word-level highlighting for 'modify'
 * lines. */
function SideFlow({
  lines,
  side,
  playbookLayer,
  playbookBandLabel,
}: {
  lines: ProseLine[];
  side: 'before' | 'after';
  playbookLayer?: boolean;
  playbookBandLabel?: string;
}) {
  const relevant = lines.filter((l) => {
    if (l.type === 'equal' || l.type === 'modify') return true;
    if (side === 'before') return l.type === 'remove';
    return l.type === 'add';
  });
  return (
    <div className="dsprose mono">
      {relevant.map((l, i) => {
        if (l.type === 'equal') {
          return (
            <div className="dsline equal" key={i}>
              <span className="dsmk"> </span>
              <span>{l.before}</span>
            </div>
          );
        }
        if (l.type === 'modify') {
          const marker = side === 'before' ? '−' : '+';
          const text = side === 'before' ? l.before : l.after;
          return (
            <div className={`dsline modify ${side}`} key={i}>
              <span className="dsmk">{marker}</span>
              <span>
                <WordSpans words={l.words} side={side} />
                {(l.words === undefined || l.words.length === 0) && text}
              </span>
            </div>
          );
        }
        const isPlaybookAdd = side === 'after' && l.type === 'add' && playbookLayer;
        const marker = l.type === 'add' ? '+' : '−';
        const text = l.type === 'add' ? l.after : l.before;
        return (
          <div className={`dsline ${l.type}${isPlaybookAdd ? ' playbook' : ''}`} key={i}>
            <span className="dsmk">{marker}</span>
            <span>{text}</span>
            {isPlaybookAdd && <span className="dspbtag">{playbookBandLabel}</span>}
          </div>
        );
      })}
    </div>
  );
}

function UnifiedFlow({
  lines,
  playbookLayer,
  playbookBandLabel,
}: {
  lines: ProseLine[];
  playbookLayer?: boolean;
  playbookBandLabel?: string;
}) {
  return (
    <div className="dsprose mono">
      {lines.map((l, i) => {
        if (l.type === 'equal') {
          return (
            <div className="dsline equal" key={i}>
              <span className="dsmk"> </span>
              <span>{l.before}</span>
            </div>
          );
        }
        if (l.type === 'modify') {
          return (
            <div className="dsgroup" key={i}>
              <div className="dsline remove">
                <span className="dsmk">{'−'}</span>
                <span>
                  <WordSpans words={l.words} side="before" />
                </span>
              </div>
              <div className="dsline add">
                <span className="dsmk">+</span>
                <span>
                  <WordSpans words={l.words} side="after" />
                </span>
              </div>
            </div>
          );
        }
        const isPlaybookAdd = l.type === 'add' && playbookLayer;
        return (
          <div className={`dsline ${l.type}${isPlaybookAdd ? ' playbook' : ''}`} key={i}>
            <span className="dsmk">{l.type === 'add' ? '+' : '−'}</span>
            <span>{l.type === 'add' ? l.after : l.before}</span>
            {isPlaybookAdd && <span className="dspbtag">{playbookBandLabel}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function ProseDiffView({
  lines,
  layout,
  leftLabel,
  rightLabel,
  playbookLayer,
  playbookBandLabel = 'playbook injection — not authored by the node',
}: ProseDiffViewProps) {
  if (proseDiffIsEmpty(lines)) {
    return <p className="note" style={{ marginTop: 0 }}>No differences — the two texts are identical.</p>;
  }
  if (layout === 'inline') {
    return <UnifiedFlow lines={lines} playbookLayer={playbookLayer} playbookBandLabel={playbookBandLabel} />;
  }
  return (
    <div className="dssplit">
      <div className="dspane" role="region" aria-label={leftLabel}>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {leftLabel}
        </div>
        <SideFlow lines={lines} side="before" />
      </div>
      <div className="dspane" role="region" aria-label={rightLabel}>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {rightLabel}
        </div>
        <SideFlow lines={lines} side="after" playbookLayer={playbookLayer} playbookBandLabel={playbookBandLabel} />
      </div>
    </div>
  );
}
