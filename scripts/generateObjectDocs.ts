// Engine object-model docs generator.
//
// `ui/src/objectModel.ts` describes the engine's own objects for humans. That description has two
// consumers, and this script produces both from it:
//
//   1. docs/engine-objects.md
//      A readable document, for anyone in the repo.
//
//   2. docs/generated/engine-objects.content_source.json
//      One `content_source.v1` envelope per object, ready to feed the normal publishing pipeline so
//      client 0 (`platform`) can publish the engine's self-README (CHANGE-PLAN P-1 / R-12).
//
// WHY content_source.v1 AND NOT A PUBLISHED OBJECT
//
// `content_source.v1` is the envelope the pipeline CONSUMES — it is what `input_triage` takes in and
// what `project.validate_handoff` checks. Emitting that shape means these descriptions enter client 0
// the same way any other content does: through the nodes, the reviews, and the publish gate. Emitting
// finished page objects instead would bypass the pipeline the engine is supposed to be demonstrating
// on itself, which is the whole point of client 0 being a conformance target.
//
// The shape is exactly `{ artifact: "content_source.v1", summary: string, notes?: string[] }` with
// passthrough for everything else (projectRegistry.ts). Note there is a LOOK-ALIKE that must not be
// confused with it: the Dr. Lurie publish payload also carries the string "content_source.v1" but has
// a completely different `record_type` / `schema_version` / `content` shape. This emits the envelope
// form, not that one.
//
// Usage:
//   npm run test:objects        check the checked-in artifacts match the registry (exit 1 on drift)  <- CI
//   npm run objects:update      regenerate both artifacts                                           <- intentional change

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreObjects, engineObjects, type EngineObject } from "../ui/src/objectModel.js";

const DOC = join(process.cwd(), "docs/engine-objects.md");
const ENVELOPES = join(process.cwd(), "docs/generated/engine-objects.content_source.json");

const HEADER = `# The engine's objects

What each thing in CMS-Agent actually is: why it exists, how it is identified, what happens to it over
its life, and what it connects to.

**This file is generated** from \`ui/src/objectModel.ts\` — the same descriptions the interface renders
beside each object. Edit the registry and run \`npm run objects:update\`; CI fails if the two disagree.

The mental model these sit inside, from \`PRODUCT_VISION.md\`: *Projects → Missions → Workflows → Agent
Teams → Agents → Runs → Knowledge → History.* The workflow graph is one view into that, not the thing
itself.
`;

const section = (object: EngineObject): string => {
  const lines = [
    `## ${object.name}`,
    "",
    object.summary,
    "",
    `**Why it exists.** ${object.purpose}`,
    "",
    `**Identified by.** ${object.identity}`,
    "",
    `**Lifecycle.** ${object.lifecycle}`,
    "",
    `**Relates to.** ${object.relations}`,
    "",
    `**Where you see it.** ${object.whereSeen}`,
    ""
  ];
  if (object.caution) lines.push(`**Worth knowing.** ${object.caution}`, "");
  lines.push(`<sub>Engine type \`${object.typeName}\` · tools: ${object.tools.map((tool) => `\`${tool}\``).join(", ")}</sub>`, "");
  return lines.join("\n");
};

export function renderDoc(): string {
  const core = coreObjects().map(section);
  const improvement = engineObjects.filter((object) => object.tier === "improvement").map(section);
  return [
    HEADER,
    "---",
    "",
    ...core,
    "---",
    "",
    "# Beyond the pipeline",
    "",
    "These are not yet surfaced in the interface. They are named here so the object model does not appear to stop at publishing.",
    "",
    ...improvement
  ].join("\n");
}

/**
 * One content_source.v1 envelope per object. `summary` carries the one-liner (the field the contract
 * requires and the pipeline reads first); `notes` carries the rest as discrete statements; the
 * structured description rides along in passthrough keys so a downstream node can build a page from
 * fields rather than by re-parsing prose.
 */
export function renderEnvelopes(): string {
  const envelopes = engineObjects.map((object) => ({
    artifact: "content_source.v1" as const,
    summary: `${object.name} — ${object.summary}`,
    notes: [
      `Why it exists: ${object.purpose}`,
      `Identified by: ${object.identity}`,
      `Lifecycle: ${object.lifecycle}`,
      `Relates to: ${object.relations}`,
      `Where you see it: ${object.whereSeen}`,
      ...(object.caution ? [`Worth knowing: ${object.caution}`] : [])
    ],
    // Passthrough. Deliberately NOT named `body`: the client's contract decides the published object's
    // shape at run time, and pre-shaping it here would re-introduce the baked content schema that the
    // contract-as-truth alignment removed.
    engineObject: {
      id: object.id,
      name: object.name,
      typeName: object.typeName,
      tier: object.tier,
      purpose: object.purpose,
      identity: object.identity,
      lifecycle: object.lifecycle,
      relations: object.relations,
      whereSeen: object.whereSeen,
      ...(object.caution ? { caution: object.caution } : {}),
      tools: object.tools
    }
  }));
  return `${JSON.stringify({ generatedFrom: "ui/src/objectModel.ts", contract: "content_source.v1", count: envelopes.length, envelopes }, null, 2)}\n`;
}

const artifacts: Array<{ path: string; render: () => string; label: string }> = [
  { path: DOC, render: renderDoc, label: "docs/engine-objects.md" },
  { path: ENVELOPES, render: renderEnvelopes, label: "docs/generated/engine-objects.content_source.json" }
];

const main = () => {
  const write = process.argv.includes("--write");

  if (write) {
    for (const artifact of artifacts) {
      mkdirSync(dirname(artifact.path), { recursive: true });
      writeFileSync(artifact.path, artifact.render(), "utf8");
    }
    console.log(`objects           written  ${engineObjects.length} objects -> ${artifacts.map((artifact) => artifact.label).join(", ")}`);
    return;
  }

  const drifted: string[] = [];
  for (const artifact of artifacts) {
    let current: string;
    try {
      current = readFileSync(artifact.path, "utf8");
    } catch {
      drifted.push(`${artifact.label} (missing)`);
      continue;
    }
    if (current !== artifact.render()) drifted.push(artifact.label);
  }

  if (drifted.length === 0) {
    console.log(`objects           ok       ${artifacts.length} artifacts match ui/src/objectModel.ts`);
    return;
  }

  console.error(`objects           DRIFT    no longer matches ui/src/objectModel.ts: ${drifted.join(", ")}`);
  console.error("                           The registry is the source of truth; these are generated from it.");
  console.error("                           If the registry change is intentional, run `npm run objects:update` and commit.");
  process.exit(1);
};

main();
