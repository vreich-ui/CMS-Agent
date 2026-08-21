// T12.22 — the bound that stopped `gap_adjudicator` from reclaiming its own dispatch forever.
//
// These assert the property that matters and the property that is easy to lose: the payload gets
// SMALL, and it stays a VALID, SHAPE-FAITHFUL object while doing so. A blind slice would satisfy
// the first and silently fail the second, converting a hang into an output_validation_failed.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEPENDENCY_OUTPUT_MAX_CHARS,
  boundDependencyOutput
} from "../../../src/agent/execution/runners/OpenAINodeRunner.js";

/** The shape that actually hung: a site-wide confluence envelope, bulk in the evidence arrays. */
const captureScoreEnvelope = (comparisons: number, pages: number, gaps: number) => ({
  artifact: "capture-fidelity-report.v1",
  summary: { pagesScored: pages, coverage: 0.81 },
  rubric: { threshold: 0.72, passed: true },
  visual: {
    evidenceComplete: false,
    comparisons: Array.from({ length: comparisons }, (_, i) => ({
      pageRef: `p${i}`,
      status: "scored",
      score: 0.9,
      detail: "x".repeat(200)
    }))
  },
  pages: Array.from({ length: pages }, (_, i) => ({
    pageRef: `p${i}`,
    route: `/page-${i}`,
    blocks: Array.from({ length: 20 }, (_, b) => ({ blockRef: `b${b}`, note: "y".repeat(100) }))
  })),
  gapReport: {
    entries: Array.from({ length: gaps }, (_, i) => ({ gapId: `g${i}`, why: "unmapped_block" }))
  }
});

describe("boundDependencyOutput", () => {
  it("returns a payload that already fits completely untouched", () => {
    const value = { artifact: "capture-map.v1", pages: [{ pageRef: "p0" }] };
    expect(boundDependencyOutput(value, DEFAULT_DEPENDENCY_OUTPUT_MAX_CHARS)).toBe(value);
  });

  it("brings an oversized confluence envelope under the bound", () => {
    const value = captureScoreEnvelope(400, 60, 30);
    const raw = JSON.stringify(value).length;
    expect(raw).toBeGreaterThan(DEFAULT_DEPENDENCY_OUTPUT_MAX_CHARS);

    const bounded = boundDependencyOutput(value, DEFAULT_DEPENDENCY_OUTPUT_MAX_CHARS);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(DEFAULT_DEPENDENCY_OUTPUT_MAX_CHARS);
  });

  it("keeps every object key, scalar and array TYPE — the model must still get parseable, same-shaped JSON", () => {
    const bounded = boundDependencyOutput(captureScoreEnvelope(400, 60, 30), 8000) as Record<string, any>;

    // Re-parsing is the real assertion: a mid-token cut would throw here.
    const reparsed = JSON.parse(JSON.stringify(bounded));
    expect(reparsed.artifact).toBe("capture-fidelity-report.v1");
    expect(reparsed.rubric).toEqual({ threshold: 0.72, passed: true });
    expect(reparsed.summary.coverage).toBe(0.81);
    expect(Array.isArray(reparsed.visual.comparisons)).toBe(true);
    expect(Array.isArray(reparsed.pages)).toBe(true);
    expect(Array.isArray(reparsed.gapReport.entries)).toBe(true);
    // Nothing is emptied out of existence: a shortened array still shows what its entries look like.
    expect(reparsed.gapReport.entries.length).toBeGreaterThan(0);
    expect(reparsed.visual.comparisons[0]).toHaveProperty("pageRef");
  });

  it("declares what it dropped, per path, so the judgment node can say its view was partial", () => {
    const bounded = boundDependencyOutput(captureScoreEnvelope(400, 60, 30), 8000) as Record<string, any>;
    const truncation = bounded.__truncation;

    expect(truncation.reason).toBe("dependency_output_exceeded_prompt_bound");
    expect(truncation.originalChars).toBeGreaterThan(truncation.maxChars);
    expect(truncation.shortenedArrays.length).toBeGreaterThan(0);
    for (const entry of truncation.shortenedArrays) {
      expect(typeof entry.path).toBe("string");
      expect(entry.kept).toBeLessThan(entry.total);
      expect(entry.kept).toBeGreaterThanOrEqual(1);
    }
    // The bulk is what gets cut — the evidence arrays, not the small ones.
    expect(truncation.shortenedArrays.some((e: any) => e.path.startsWith("visual.comparisons") || e.path.startsWith("pages"))).toBe(true);
  });

  it("shortens the LARGEST array first rather than trimming everything evenly", () => {
    const value = {
      tiny: [1, 2, 3, 4],
      huge: Array.from({ length: 500 }, (_, i) => ({ i, pad: "z".repeat(100) }))
    };
    const bounded = boundDependencyOutput(value, 4000) as Record<string, any>;
    expect(bounded.tiny).toEqual([1, 2, 3, 4]);
    expect(bounded.huge.length).toBeLessThan(500);
  });

  it("reaches nested arrays, not just top-level ones", () => {
    const value = {
      pages: [{ pageRef: "p0", blocks: Array.from({ length: 800 }, (_, i) => ({ i, pad: "q".repeat(60) })) }]
    };
    const bounded = boundDependencyOutput(value, 4000) as Record<string, any>;
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(4000);
    expect(bounded.pages[0].pageRef).toBe("p0");
    expect(bounded.pages[0].blocks.length).toBeLessThan(800);
  });

  it("falls back to the tool-result bound for an oversized NON-object payload, which has no shape to keep", () => {
    const bounded = boundDependencyOutput("s".repeat(9000), 4000) as Record<string, any>;
    expect(bounded.truncated).toBe(true);
    expect(typeof bounded.preview).toBe("string");
  });

  it("passes undefined and null through — an unresolved dependency must stay distinguishable", () => {
    expect(boundDependencyOutput(undefined, 4000)).toBeUndefined();
    expect(boundDependencyOutput(null, 4000)).toBeNull();
  });
});
