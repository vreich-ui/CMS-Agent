// W2 — the counterpart every loading skeleton in this app owes the operator.
//
// A skeleton says "this is coming". When the query behind it fails — or, before W0's
// per-call timeout, simply never settled — nothing ever said otherwise, so the panel
// shimmered for the life of the page. That is what "Attention / Recent runs / Learning
// activity skeletons forever" and "checking divergence…" that never resolves actually
// were: not slow queries, but a UI with no rendering for failure at all.
//
// Two rules this encodes:
//   - say what the BACKEND said. A verb that failed knows why (a 403's refusal text, a
//     502's body, "timed out after 25s"); paraphrasing it into "Something went wrong"
//     throws away the only fact worth having.
//   - always offer the retry. A failure the operator cannot act on is indistinguishable
//     from a dead app.

import type { CSSProperties } from 'react';

export function QueryError({
  message,
  onRetry,
  label,
  inline = false,
  style,
}: {
  /** The backend's own message. Falls back only when the error carried none. */
  message?: string;
  onRetry: () => void;
  /** Optional section label, rendered in the same `.lbl` vocabulary as the cards. */
  label?: string;
  /** Inline variant: one line + retry, no card chrome — for a rail or a tab strip. */
  inline?: boolean;
  style?: CSSProperties;
}) {
  const body = (
    <>
      <p className="qerr-msg">{message ?? 'This did not load.'}</p>
      <button type="button" className="btn qerr-retry" onClick={onRetry}>
        Retry
      </button>
    </>
  );

  if (inline) {
    return (
      <div className="qerr qerr--inline" role="alert" style={style}>
        {body}
      </div>
    );
  }

  return (
    <div className="card qerr" role="alert" style={style}>
      {label ? <span className="lbl">{label}</span> : null}
      {body}
    </div>
  );
}
