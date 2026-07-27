// Glossary generator — the UI's vocabulary registry, rendered as a human-readable document.
//
// WHY THIS EXISTS
//
// `ui/src/explain.ts` is the single definition of every coded value the product shows a human: risk
// rungs, run states, actor kinds, tool denial reasons, permission states, resolution layers, conflict
// severities. Those definitions are needed in two places at once:
//
//   1. In the interface, next to the badge or the table cell (components/Glossary.tsx).
//   2. As prose the engine can PUBLISH about itself. `platform` is client 0 and its site is the
//      engine's self-README (CHANGE-PLAN P-1, and R-12's docs generator + Tier D staleness check).
//
// Maintaining those separately guarantees drift, and glossary drift is the invisible kind: nobody
// re-reads a definitions page, so a stale one is trusted for years. So the document is generated, and
// `npm run test:glossary` fails when the checked-in copy no longer matches the registry — the same
// lock the tool manifest uses, for the same reason.
//
// This is deliberately the SHAPE R-12 needs, not R-12 itself: a stamped, generated artifact derived
// from introspection rather than hand-authored prose. When R-12 wraps engine docs in
// `content_source.v1` envelopes and publishes them to client 0, this generator is one of its inputs
// and nothing here has to be rewritten.
//
// Usage:
//   npm run test:glossary        check the checked-in doc matches the registry (exit 1 on drift)  <- CI
//   npm run glossary:update      regenerate docs/ui-glossary.md                                   <- intentional copy change

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vocabularyList, UNKNOWN_TOOL_REASON, type Term, type Vocabulary } from "../ui/src/explain.js";

const OUTPUT = join(process.cwd(), "docs/ui-glossary.md");

const HEADER = `# Engine vocabulary

Every coded value the CMS-Agent interface puts in front of a human, with what it means and — where
there is one — what to do about it.

**This file is generated.** It is rendered from \`ui/src/explain.ts\`, which is the same registry the
interface reads when it renders a definition beside a badge or a table cell. Editing this file by hand
will be overwritten; edit the registry and run \`npm run glossary:update\`. CI fails if the two
disagree, because a stale glossary is the kind of wrong that goes unnoticed — nobody re-reads a
definitions page, so an out-of-date one gets trusted indefinitely.

Codes are shown exactly as they appear on the wire, in logs, and in the runbooks, so this document can
be searched with the string you actually have in front of you.
`;

const renderTerm = (term: Term): string => {
  const remedy = term.remedy ? `<br>**What to do:** ${term.remedy}` : "";
  return `| \`${term.term}\` | ${term.label} | ${term.summary}${remedy} |`;
};

const renderVocabulary = (vocab: Vocabulary): string => [
  `## ${vocab.title}`,
  "",
  vocab.blurb,
  "",
  "| Code | Name | Meaning |",
  "|---|---|---|",
  ...vocab.terms.map(renderTerm),
  ""
].join("\n");

export function renderGlossary(): string {
  const sections = vocabularyList().map(renderVocabulary);

  // The one term the resolver never emits: synthesized by the UI when a node lists a tool the registry
  // has never heard of. Documented here so the code is searchable, and kept out of the denial
  // vocabulary so the registry's correspondence test against the backend stays exact.
  const synthesized = [
    "## Reported by the interface rather than the resolver",
    "",
    "One code is produced by the interface itself, so it will not appear in the engine's policy code:",
    "",
    "| Code | Name | Meaning |",
    "|---|---|---|",
    renderTerm(UNKNOWN_TOOL_REASON),
    ""
  ].join("\n");

  return [HEADER, ...sections, synthesized].join("\n");
}

const main = () => {
  const rendered = renderGlossary();
  const write = process.argv.includes("--write");

  if (write) {
    writeFileSync(OUTPUT, rendered, "utf8");
    const termCount = vocabularyList().reduce((total, vocab) => total + vocab.terms.length, 0);
    console.log(`glossary          written  ${vocabularyList().length} vocabularies, ${termCount + 1} terms -> docs/ui-glossary.md`);
    return;
  }

  let current: string;
  try {
    current = readFileSync(OUTPUT, "utf8");
  } catch {
    console.error("glossary          MISSING  docs/ui-glossary.md does not exist. Run `npm run glossary:update`.");
    process.exit(1);
    return;
  }

  if (current === rendered) {
    console.log(`glossary          ok       docs/ui-glossary.md matches ui/src/explain.ts`);
    return;
  }

  console.error("glossary          DRIFT    docs/ui-glossary.md no longer matches ui/src/explain.ts.");
  console.error("                           The registry is the source of truth; the document is generated from it.");
  console.error("                           If the registry change is intentional, run `npm run glossary:update` and commit the doc.");
  process.exit(1);
};

main();
