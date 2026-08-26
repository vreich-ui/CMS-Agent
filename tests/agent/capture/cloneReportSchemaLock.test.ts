import { describe, expect, it } from "vitest";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";

// WHY THIS EXISTS. cloneConductorNodes.ts declares each node's outputSchema; cloneEngine.ts builds
// the envelope that must satisfy it. Nothing connected the two, so they drifted: clone_report's
// schema said `capabilityBacklog: {type:"array"}` while the engine returns a MAP keyed by section
// type. The first run to reach the terminal node died output_schema_invalid — after eight stages of
// real work had completed and been persisted — and the artifact explaining that work was the one
// thing that could not be written.
//
// A schema is a contract with the code that fills it. This test is the only thing that makes it one.
//
// It validates through `validateOutput` — the executor's OWN validator, the same call that blocked
// the live run — rather than a parallel schema library. A test that agrees with a second validator
// while the real one refuses would have proved nothing.

/** The exact shape buildCloneReportStep returns — a map for capabilityBacklog, arrays for the rest. */
const reportEnvelopeFixture = () => ({
  artifact: "clone_run_report.v1",
  summary: "Clone run report for zilberman: 3 reviewable object(s), 1 capability gap group(s).",
  mint: { createdObjects: [{ objectType: "template", objectId: "tpl_clone_x" }], substitutions: [] },
  theme: { applied: { colors: { primary: "rgb(1 2 3)" }, fonts: {} }, dropped: [] },
  restamp: { restamp: [{ objectId: "page_home" }], appliedSubstitutions: [], substitutionRejections: [] },
  substitutions: [{ kind: "font", wanted: "'Playfair Display', serif", chosen: "Georgia, serif", fidelityCost: "minor" }],
  // THE REGRESSION: a keyed map, never a list.
  capabilityBacklog: { booking_widget: [{ sectionType: "booking_widget", why: "no registered type performs this" }] },
  reviewQueue: [{ objectType: "site", objectId: "site_zilberman" }],
  humanSummary: "Clone run for zilberman: 3 object(s) to review. Publication was not attempted on this run.",
  // T15.10 (#189): was `humanGate: { publishedByThisRun: false, note: "..." }` — renamed and
  // reframed as `publication`, mirroring capture_run_report.v1's own field.
  publication: { attempted: false, published: [], failed: [], withheld: [], release: null, note: "The tail's publish_executor did not run for this fixture." }
});

describe("clone_report outputSchema is a contract with the engine that fills it", () => {
  const node = listCloneConductorNodes().find((candidate) => candidate.id === "clone_report");

  it("accepts the envelope buildCloneReportStep actually returns", () => {
    expect(node).toBeDefined();
    const result = validateOutput(reportEnvelopeFixture(), node!.outputSchema);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("still REJECTS an envelope missing a required field — the schema must remain load-bearing", () => {
    const { humanSummary: _dropped, ...withoutHumanSummary } = reportEnvelopeFixture();
    expect(validateOutput(withoutHumanSummary, node!.outputSchema).ok).toBe(false);
  });

  it("pins capabilityBacklog as an OBJECT, the shape groupUnmetNeedsBySectionType produces", () => {
    const schema = node!.outputSchema as { properties: Record<string, { type?: string }> };
    expect(schema.properties.capabilityBacklog.type).toBe("object");
  });
});
