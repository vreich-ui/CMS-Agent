import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { captureMapStep, captureScoreStep, captureThemeStep, summarizeVisualEvidence } from "../../../src/agent/capture/captureEngine.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// W2.1/G6-T3 — THE SILENT ZERO.
//
// Every capture run to date has reported "visual 0 scored / N unavailable" and completed normally.
// The zero was real (no pipeline stage produces draft-preview screenshots yet) but the stage output
// said nothing an operator or a downstream node could act on, so gap_adjudicator — an AI node reading
// that envelope — paraphrased it into "the visual comparison could not be completed", which reads
// like a transient tooling failure rather than a hole in the run's evidence.
//
// What this file pins:
//   1. captureScoreStep's envelope ALWAYS carries `visualEvidence`, with the counts and the dominant
//      reason, whether the evidence is complete or not.
//   2. When it is incomplete the envelope carries a non-null `warning` and the summary string says so
//      — the run is legible from its own record.
//   3. The verdict is NOT changed by any of this. `rubric` over the same inputs is identical to what
//      the scorer produced before the field existed: visual evidence explains, never authorizes.
//   4. summarizeVisualEvidence's reason tally is deterministic and picks a genuine plurality winner.
//
// The fixture is the committed, redacted Zilberman snapshot — byte-free by design (no screenshot
// binaries are committed), which is exactly the state every live run is in today: 66 block
// screenshots declared `captured: true` in the snapshot, zero of them resolvable on disk.

const fixture = async (name: string) =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../../fixtures/capture/${name}`, import.meta.url)), "utf8"));

const CAPTURE_TARGET = "zb-visual-evidence";

const captureStubProject = (): ProjectConnectionConfig => ({
  projectId: CAPTURE_TARGET,
  name: "Zilberman visual evidence",
  mcpEndpointEnvVar: "ZB_VISUAL_EVIDENCE_MCP_ENDPOINT",
  authMode: "none",
  allowedTools: [],
  contentContract: { contentContract: "content_source.v1" },
  capturePolicy: {
    maxPages: 20,
    allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
    allowedPathPrefixes: ["/"],
    sameOriginOnly: true,
    respectRobots: true,
    concurrency: 1,
    delayMs: 0,
    authenticatedAccess: "prohibited",
    rights: { content: "retain_allowed_origin_content", media: "prohibited" },
    designReferences: [],
    fidelity: { mode: "design_inspired", sourceDesignTreatment: "source_content_with_design_inspiration_only" }
  },
  publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test" },
  status: "active"
});

const captureStubRepository = (config: ProjectConnectionConfig): ProjectRepository => ({
  list: async () => [config],
  get: async (projectId: string) => (config.projectId === projectId ? config : undefined),
  save: async (value) => value,
  delete: async () => false,
  health: async () => ({ backend: "memory", details: {} } as never)
});

async function scoreOnce() {
  const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
  const deps = { projectRepository: captureStubRepository(captureStubProject()) };
  const mapEnvelope = await captureMapStep({ targetProjectId: CAPTURE_TARGET, snapshot, suggestions: [] }, deps);
  const themeEnvelope = await captureThemeStep({ targetProjectId: CAPTURE_TARGET, snapshot }, deps);
  return await captureScoreStep(
    { targetProjectId: CAPTURE_TARGET, snapshot, mapping: mapEnvelope.mapping, theme: themeEnvelope.theme },
    deps
  );
}

describe("W2.1/G6-T3: a run with no preview evidence says so on its own stage output", () => {
  it("carries visualEvidence with the counts, the dominant reason, and a non-null warning", async () => {
    const envelope = await scoreOnce();

    expect(envelope.report.visual.evidenceComplete).toBe(false);
    expect(envelope.visualEvidence.evidenceComplete).toBe(false);
    expect(envelope.visualEvidence.scoredCount).toBe(0);
    expect(envelope.visualEvidence.unavailableCount).toBeGreaterThan(0);
    expect(envelope.visualEvidence.unavailableCount).toBe(envelope.report.visual.unavailableCount);
    expect(envelope.visualEvidence.pagesWithoutScoredComparison).toBe(envelope.report.visual.pagesWithoutScoredComparison.length);

    // The dominant reason is the scorer's OWN vocabulary, not a paraphrase invented here.
    expect(envelope.visualEvidence.dominantReason).toBe("source_screenshot_binary_not_available");
    expect(envelope.visualEvidence.reasons[0]).toEqual({
      reason: "source_screenshot_binary_not_available",
      count: envelope.report.visual.comparisons.length
    });

    expect(envelope.visualEvidence.warning).toContain("capture_visual_evidence_incomplete");
    expect(envelope.visualEvidence.warning).toContain("source_screenshot_binary_not_available");
    // The summary is what a human and gap_adjudicator both read first.
    expect(envelope.summary).toContain("WARNING");
    expect(envelope.summary).toContain("capture_visual_evidence_incomplete");
  });

  it("changes no verdict: the rubric is identical to what the same inputs scored before", async () => {
    const envelope = await scoreOnce();
    // Evidence accounting only — the rubric's three gates are structural/theme/gap, and a missing
    // screenshot is not an input to any of them.
    expect(envelope.rubric.coverage.score).toBe(envelope.report.rubric.coverage.score);
    expect(envelope.rubric.verdict).toBe(envelope.report.rubric.verdict);
    expect(Object.keys(envelope.rubric).sort()).toEqual(["coverage", "gapsEnumerated", "tokensComplete", "verdict"]);
  });
});

describe("W2.1/G6-T3: summarizeVisualEvidence", () => {
  const visual = (over: Record<string, unknown>) =>
    ({
      comparisons: [],
      aggregateScore: null,
      scoredCount: 0,
      unavailableCount: 0,
      pagesWithoutScoredComparison: [],
      defects: [],
      defectCount: 0,
      evidenceComplete: true,
      ...over
    }) as never;

  it("states completeness positively and emits no warning when the evidence is whole", () => {
    const summary = summarizeVisualEvidence(visual({ scoredCount: 12, aggregateScore: 0.91 }));
    expect(summary).toEqual({
      evidenceComplete: true,
      scoredCount: 12,
      unavailableCount: 0,
      pagesWithoutScoredComparison: 0,
      dominantReason: null,
      reasons: [],
      warning: null
    });
  });

  it("picks the plurality reason and breaks ties deterministically on the reason string", () => {
    const defects = [
      { code: "draft_preview_evidence_missing", severity: "defect", pageRef: "p1", detail: "draft_preview_screenshot_not_available" },
      { code: "draft_preview_evidence_missing", severity: "defect", pageRef: "p1", detail: "draft_preview_screenshot_not_available" },
      { code: "capture_source_evidence_missing", severity: "defect", pageRef: "p2", detail: "source_screenshot_binary_not_available" },
      { code: "page_has_no_scored_visual_comparison", severity: "defect", pageRef: "p2", detail: "no_scored_visual_comparison_for_emitted_page" }
    ];
    const summary = summarizeVisualEvidence(
      visual({ defects, defectCount: 4, evidenceComplete: false, unavailableCount: 3, pagesWithoutScoredComparison: ["p2"] })
    );
    expect(summary.dominantReason).toBe("draft_preview_screenshot_not_available");
    expect(summary.reasons).toEqual([
      { reason: "draft_preview_screenshot_not_available", count: 2 },
      { reason: "no_scored_visual_comparison_for_emitted_page", count: 1 },
      { reason: "source_screenshot_binary_not_available", count: 1 }
    ]);
    expect(summary.pagesWithoutScoredComparison).toBe(1);
    expect(summary.warning).toContain("Dominant reason: draft_preview_screenshot_not_available");
  });
});
