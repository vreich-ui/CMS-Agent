import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import { summarizeTick } from "../../src/agent/entrypoints/runContinuationTickJob.js";

// This file replaces the Netlify scheduled-function schedule test. That test guarded a real hazard
// (an unresolvable `schedule` literal deployed the function unscheduled) but on the WRONG PLANE:
// Phase 1 moved execution to Cloud Run + GCS, and the Netlify Blobs store has held no conductor run
// since mid-July 2026. The Netlify tick ran perfectly and drove nothing for hours. What is worth
// guarding now is that the tick cannot come back on Netlify by accident, and that its Cloud Run
// entrypoint keeps the structured line that made that incident legible at all.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

describe("continuation tick deployment plane", () => {
  it("has no Netlify scheduled function — the execution plane is Cloud Run", () => {
    expect(existsSync(repoFile("netlify/functions/run-continuation.mts"))).toBe(false);
  });

  it("has no netlify.toml schedule entry for it either", () => {
    expect(readFileSync(repoFile("netlify.toml"), "utf8")).not.toMatch(/\[functions\."run-continuation"\]/);
  });

  it("ships the Cloud Run job entrypoint the image is built against", () => {
    expect(existsSync(repoFile("src/agent/entrypoints/runContinuationTickMain.ts"))).toBe(true);
  });
});

describe("summarizeTick", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names every refusal, so a tick that drove nothing still says why", () => {
    const line = JSON.parse(summarizeTick({
      enabled: true,
      scanned: 2,
      timedOut: false,
      driven: [],
      verdicts: [
        { runId: "run_a", status: "completed", reenter: false, code: "skip_not_active", reason: "terminal" },
        { runId: "run_b", status: "running", reenter: true, code: "reenter_idle_driver", reason: "parked" }
      ]
    } as never));
    expect(line.event).toBe("workflow.continuation_tick");
    expect(line.scanned).toBe(2);
    expect(line.refusals).toEqual([{ runId: "run_a", code: "skip_not_active" }]);
  });

  it("reports what it drove, with before/after status", () => {
    const line = JSON.parse(summarizeTick({
      enabled: true,
      scanned: 1,
      timedOut: false,
      driven: [{ runId: "run_b", code: "reenter_idle_driver", statusBefore: "running", statusAfter: "completed", steps: 3 }],
      verdicts: []
    } as never));
    expect(line.driven).toEqual([{ runId: "run_b", code: "reenter_idle_driver", statusBefore: "running", statusAfter: "completed", steps: 3 }]);
    expect(line.refusals).toEqual([]);
  });
});
