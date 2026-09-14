/**
 * Track C — the stale-image refusal, as logic.
 *
 * Pinned here rather than proven by deploying an old tag, because the case that matters (a repin
 * somebody forgot) is by definition the case nobody sets up on purpose.
 */
import { describe, expect, it } from "vitest";

import { plannerImageGuard } from "../../../src/agent/planner/imageGuard.js";

describe("plannerImageGuard", () => {
  it("passes when the two planes are on the same build", () => {
    const verdict = plannerImageGuard({ jobSha: "3ec3395", serviceSha: "3ec3395" });
    expect(verdict.ok).toBe(true);
    expect(verdict.state).toBe("matched");
  });

  it("REFUSES when the job is running a different build from the service", () => {
    const verdict = plannerImageGuard({ jobSha: "d478216", serviceSha: "3ec3395" });
    expect(verdict.ok).toBe(false);
    expect(verdict.state).toBe("stale");
    expect(verdict.ok === false && verdict.message).toContain("d478216");
    expect(verdict.ok === false && verdict.message).toContain("3ec3395");
    expect(verdict.ok === false && verdict.message).toContain("jobs-repin.sh");
  });

  it("proves the refusal by pointing the job at an OLD tag", () => {
    // The acceptance case: repin the service, leave the job behind, and the next fire commissions
    // nothing rather than commissioning on the older policy.
    const serviceSha = "3ec3395";
    for (const oldTag of ["d478216", "e6f497f", "72af4ba"]) {
      expect(plannerImageGuard({ jobSha: oldTag, serviceSha }).ok).toBe(false);
    }
  });

  it("does not refuse when either side reports no sha — unknown is not mismatched", () => {
    expect(plannerImageGuard({ jobSha: undefined, serviceSha: "3ec3395" }).state).toBe("unverified");
    expect(plannerImageGuard({ jobSha: "3ec3395", serviceSha: null }).state).toBe("unverified");
    expect(plannerImageGuard({ jobSha: "  ", serviceSha: "  " }).ok).toBe(true);
  });
});
