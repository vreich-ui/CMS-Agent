import { describe, expect, it } from "vitest";
import { parseValidateResult } from "../../../src/agent/projects/objectDialect.js";

// The two answer shapes the platform's object_validate actually speaks, verified live 2026-08-12
// (run_1786555553280_r7a4fd): the explicit {valid, issues} form, and the id-less dry-run CHECKLIST
// form whose verdict is summary.eligible and whose issues are summary.blockers.
describe("parseValidateResult — dry-run checklist shape (summary.eligible / summary.blockers)", () => {
  const checklist = (eligible: boolean, blockers: unknown[]) => ({
    structuredContent: {
      dry_run: true,
      object_type: "content_item",
      validation: [{ id: "schema", criteria: [{ id: "schema_zod", status: eligible ? "complete" : "missing" }] }],
      summary: { level: eligible ? "ready" : "missing", eligible, blockers, warnings: [] }
    }
  });

  it("reads eligible:true with no blockers as a pass", () => {
    const parsed = parseValidateResult(checklist(true, []), "s");
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toEqual([]);
  });

  it("reads eligible:false with blockers as invalid, carrying the client's own blockers as issues", () => {
    const blocker = { id: "schema_zod", status: "missing", message: '(root): Unrecognized key: "object_type"' };
    const parsed = parseValidateResult(checklist(false, [blocker]), "s");
    expect(parsed.valid).toBe(false);
    expect(parsed.issues).toEqual([blocker]);
  });

  it("still prefers an explicit {valid, issues} answer over a checklist in the same envelope", () => {
    const parsed = parseValidateResult({ valid: false, issues: ["x"], summary: { eligible: true, blockers: [] } }, "s");
    expect(parsed.valid).toBe(false);
    expect(parsed.issues).toEqual(["x"]);
  });

  it("keeps treating a result with neither verdict as unparseable-as-invalid", () => {
    const parsed = parseValidateResult({ anything: "else" }, "s");
    expect(parsed.valid).toBe(false);
    expect(parsed.issues).toEqual(["unparseable_validate_result"]);
  });
});
