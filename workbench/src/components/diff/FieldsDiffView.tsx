// U2 — presentational side of structuredDiff.ts: one row per changed
// field, arrays as added/removed chips (never re-printed whole), a deep
// object as a pretty-printed + line/word-diffed fallback (never a raw
// JSON.stringify dump), and a collapsed "N unchanged fields" disclosure.

import { useState } from 'react';
import { diffFields, type FieldDiffRow } from './structuredDiff';
import { ProseDiffView } from './ProseDiffView';

export function FieldRow({ row }: { row: FieldDiffRow }) {
  return (
    <div className="dsfieldrow">
      <div className="dsfieldkey mono">{row.key}</div>
      <div className="dsfieldval">
        {row.kind === 'scalar' && (
          <span>
            <span className="dsword rm">{row.before === undefined || row.before === null ? '(unset)' : String(row.before)}</span>
            <span className="dsarrow"> {'→'} </span>
            <span className="dsword add">{row.after === undefined || row.after === null ? '(unset)' : String(row.after)}</span>
          </span>
        )}
        {row.kind === 'array' && (
          <span className="dsarr">
            {(row.arrayRemoved?.length ?? 0) === 0 && (row.arrayAdded?.length ?? 0) === 0 ? (
              <span className="note" style={{ margin: 0 }}>
                reordered — same members, different order
              </span>
            ) : (
              <>
                {row.arrayRemoved?.map((v, i) => (
                  <span className="chip dsarrchip rm" key={`r${i}`}>
                    − {String(v)}
                  </span>
                ))}
                {row.arrayAdded?.map((v, i) => (
                  <span className="chip dsarrchip add" key={`a${i}`}>
                    + {String(v)}
                  </span>
                ))}
              </>
            )}
          </span>
        )}
        {row.kind === 'json' && (
          <div className="dsfieldjson">
            <ProseDiffView
              lines={row.jsonLines ?? []}
              layout="inline"
              leftLabel={`${row.key} · before`}
              rightLabel={`${row.key} · after`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function FieldsDiffView({
  before,
  after,
  exclude = ['prompt'],
}: {
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
  exclude?: string[];
}) {
  const { changed, unchanged } = diffFields(before, after, { exclude });
  const [showUnchanged, setShowUnchanged] = useState(false);

  return (
    <div className="dsfields">
      {changed.length === 0 ? (
        <p className="note" style={{ marginTop: 0 }}>No other fields changed.</p>
      ) : (
        changed.map((row) => <FieldRow key={row.key} row={row} />)
      )}
      {unchanged.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn" style={{ padding: '2px 9px', fontSize: 11.5 }} onClick={() => setShowUnchanged((v) => !v)}>
            {showUnchanged ? 'hide' : 'show'} {unchanged.length} unchanged field{unchanged.length === 1 ? '' : 's'}
          </button>
          {showUnchanged && (
            <div className="note mono" style={{ marginTop: 6 }}>
              {unchanged.join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
