import { describe, expect, it } from "vitest";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { PUBLICATION_CONTROLLER_NODE_ID, readPublicationDecision } from "../../../src/agent/workspace/publishDecision.js";

// T9 (autonomous-publish) — PIN THE DECISION AT THE POINT OF PRODUCTION.
//
// publication_decision.v1's schema required only {artifact, summary}. So a record carrying nothing
// but prose — {"artifact":"publication_decision.v1","summary":"Looks fine."} — was a perfectly valid
// output of the node whose entire job is to decide, and the refusal had to happen downstream at read
// time, one layer away from where the shape is declared. readPublicationDecision has always
// authorized on an explicit "go" and nothing else; the schema now says the same thing where the
// record is produced, so a decision that never made one cannot be emitted at all.

const decisionSchema = () => getWorkspaceNode(PUBLICATION_CONTROLLER_NODE_ID)!.outputSchema;
const record = (overrides: Record<string, unknown>) => ({ artifact: "publication_decision.v1", summary: "A decision.", ...overrides });

describe("publication_decision.v1 output schema", () => {
  it("requires the decision field", () => {
    // The exact acceptance fixture the gate's own comment names as the thing prose approval looks like.
    const proseOnly = { artifact: "publication_decision.v1", summary: "Looks fine." };
    expect(validateOutput(proseOnly, decisionSchema()).ok).toBe(false);
    // ...and which the reader also refuses, from the other end.
    expect(readPublicationDecision(proseOnly).authorized).toBe(false);
  });

  it.each(["go", "no_go", "blocked"])("admits %s", (decision) => {
    expect(validateOutput(record({ decision, blockers: [] }), decisionSchema()).ok).toBe(true);
  });

  it.each(["maybe", "GO ", "yes", "approved", ""])("rejects %j as a decision", (decision) => {
    expect(validateOutput(record({ decision }), decisionSchema()).ok).toBe(false);
  });

  it("rejects a non-string decision", () => {
    expect(validateOutput(record({ decision: true }), decisionSchema()).ok).toBe(false);
  });

  it("rejects blockers that are not a list of strings", () => {
    // The gate refuses an ambiguous authorization for the same reason; saying it in the schema means
    // the malformed record never reaches the gate.
    expect(validateOutput(record({ decision: "no_go", blockers: "none" }), decisionSchema()).ok).toBe(false);
    expect(validateOutput(record({ decision: "no_go", blockers: [{ code: "x" }] }), decisionSchema()).ok).toBe(false);
  });

  it("refuses a \"go\" that still lists blockers, at the schema level", () => {
    // if/then: a go with open blockers is ambiguous. The gate refuses it too, but the schema means
    // such a record is never produced rather than merely never honoured.
    expect(validateOutput(record({ decision: "go", blockers: ["taxonomy unresolved"] }), decisionSchema()).ok).toBe(false);
    expect(validateOutput(record({ decision: "no_go", blockers: ["taxonomy unresolved"] }), decisionSchema()).ok).toBe(true);
  });

  // The schema and the reader are two statements of one rule, and drift between them would put the
  // engine back where it started. Every value the schema admits must land somewhere definite in the
  // reader, and only "go" may authorize.
  it("agrees with readPublicationDecision on every admitted value", () => {
    expect(readPublicationDecision(record({ decision: "go", blockers: [] })).authorized).toBe(true);
    expect(readPublicationDecision(record({ decision: "no_go", blockers: [] })).authorized).toBe(false);
    expect(readPublicationDecision(record({ decision: "blocked", blockers: [] })).authorized).toBe(false);
    // Belt and braces on the ambiguous case: refused by the schema above, and still refused by the
    // reader if one ever arrives from a path the schema did not police.
    expect(readPublicationDecision(record({ decision: "go", blockers: ["taxonomy unresolved"] })).authorized).toBe(false);
  });

  it("the node's `schema` and `outputSchema` state the same contract", () => {
    const node = getWorkspaceNode(PUBLICATION_CONTROLLER_NODE_ID)! as unknown as { schema?: unknown; outputSchema: unknown };
    expect(JSON.stringify(node.schema)).toBe(JSON.stringify(node.outputSchema));
  });
});
