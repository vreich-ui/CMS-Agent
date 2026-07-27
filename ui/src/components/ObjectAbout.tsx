import { engineObject } from "../objectModel";

// "What is this thing?" for the object a surface is showing.
//
// Same disclosure mechanics as Glossary — native <details>, collapsed, keyboard-operable with no ARIA
// of our own, no z-index, no absolute positioning — for the same reason: an operator who knows what a
// node is should not pay screen space for the definition, and one who does not should not have to
// leave the product to find out.
//
// It sits at the TOP of its surface rather than the bottom, because "what am I looking at" precedes
// "what do these badges mean". The vocabulary glossaries stay next to the badges they explain.
export function ObjectAbout({ id, className }: { id: string; className?: string }) {
  const object = engineObject(id);
  if (!object) return null;

  return <details className={className ? `object-about ${className}` : "object-about"}>
    <summary>What is a {object.name.toLowerCase()}?</summary>
    <p className="object-about-summary">{object.summary}</p>
    <dl className="object-about-facts">
      <dt>Why it exists</dt><dd>{object.purpose}</dd>
      <dt>Identified by</dt><dd>{object.identity}</dd>
      <dt>Lifecycle</dt><dd>{object.lifecycle}</dd>
      <dt>Relates to</dt><dd>{object.relations}</dd>
    </dl>
    {/* The caution is the part that saves someone an afternoon, so it is styled as a note rather than
        buried as another muted definition. */}
    {object.caution ? <p className="object-about-caution"><strong>Worth knowing:</strong> {object.caution}</p> : null}
    <p className="muted object-about-type">Engine type <code>{object.typeName}</code>.</p>
  </details>;
}
