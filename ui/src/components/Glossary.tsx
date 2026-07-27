import { Fragment } from "react";
import { vocabulary, type VocabularyId } from "../explain";

// Level-2 progressive disclosure for a coded vocabulary (risk levels, run states, actor kinds, tool
// denial reasons, permission states, resolution layers, conflict severities).
//
// A native <details> rather than a tooltip or popover, deliberately:
//   - it is keyboard-operable and screen-reader-navigable with no JS and no ARIA of our own;
//   - it needs no z-index and no absolute positioning, both of which this project's IA spec forbids;
//   - it collapses by default, so a surface stays calm for the operator who already knows the terms.
//
// The summary line is phrased as the question the reader would actually ask, because GOV.UK's research
// found users skip disclosures whose link text does not tell them what is inside — and some avoid them
// entirely, believing they navigate away. Definitions are legitimate Details content: needed once, then
// learned. Anything a reader needs EVERY time stays outside a disclosure.
export function Glossary({ id, className }: { id: VocabularyId; className?: string }) {
  const vocab = vocabulary(id);
  return <details className={className ? `glossary ${className}` : "glossary"}>
    <summary>{vocab.title}</summary>
    <p className="muted glossary-blurb">{vocab.blurb}</p>
    <dl className="glossary-terms">
      {vocab.terms.map((term) => <Fragment key={term.term}>
        {/* The raw code stays next to the plain name: operators grep for it, agents emit it, and the
            runbooks quote it, so translating it away would cut the UI off from the docs. */}
        <dt><code>{term.term}</code> <span className="glossary-label">{term.label}</span></dt>
        <dd>
          {term.summary}
          {term.remedy ? <> <span className="glossary-remedy">{term.remedy}</span></> : null}
        </dd>
      </Fragment>)}
    </dl>
  </details>;
}
