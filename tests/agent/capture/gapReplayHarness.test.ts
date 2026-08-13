import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  aggregateMappedCoverage,
  captureMapStep,
  declinedBlockGaps,
  sanitizeSuggestions
} from "../../../src/agent/capture/captureEngine.js";
import { mapSnapshot } from "../../../src/agent/capture/engine/map.mjs";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// T12.9 ACCEPTANCE — replay of the 14 Zilberman gaps (the committed 2026-08-13 live-run palette-gap
// report) through block_classifier's seam with a FIXTURE classifier, proving the re-validation path:
//   * suggestions are advisory; the deterministic builder (mapSnapshot's assistance path) re-runs
//     for every one — an INVALID or UNREGISTERED type is rejected, never coerced (test-proven);
//   * a type the PageType registry disallows on that page is refused AS A GAP, never coerced;
//   * VALID suggestions raise fixture coverage, and the harness records the exact delta.
//
// Scope note, per the brief: the fixture classifier is deterministic (committed suggestion table),
// so the delta below is the FIXTURE-coverage delta. The corresponding delta from a REAL model
// classifier is part of the pending LIVE proof and is not claimed here.

const fixture = async (name: string) =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../../fixtures/capture/${name}`, import.meta.url)), "utf8"));

// The fixture classifier: for each live-run gap entry, suggest the gap's own nearestType when it is
// a registered governed type, else "prose" (the honest nearest governed type for text evidence).
const REGISTERED_TYPES = new Set(["hero", "lede", "prose", "bio", "contact_form", "cta_banner", "link_list"]);
const fixtureClassifier = (gapEntries: Array<{ blockRef: string; nearestType: string }>) =>
  gapEntries.map((entry) => ({
    blockRef: entry.blockRef,
    sectionType: REGISTERED_TYPES.has(entry.nearestType) ? entry.nearestType : "prose",
    rationale: "fixture classifier replaying the 2026-08-13 live gap report"
  }));

const policyProject = (): ProjectConnectionConfig => ({
  projectId: "zb-replay",
  name: "Zilberman gap replay",
  mcpEndpointEnvVar: "ZB_REPLAY_MCP_ENDPOINT",
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

const stubRepository = (config: ProjectConnectionConfig): ProjectRepository => ({
  list: async () => [config],
  get: async (projectId: string) => (config.projectId === projectId ? config : undefined),
  save: async (value) => value,
  delete: async () => false,
  health: async () => ({ backend: "memory", details: {} } as never)
});

describe("the 14 Zilberman gaps replayed through the block_classifier re-validation seam", () => {
  it("the committed live gap report carries exactly the 14 gaps the runbook records", async () => {
    const gapReport = await fixture("zilberman.2026-08-13.palette-gaps.v1.json");
    expect(gapReport.schemaVersion).toBe("capture-palette-gaps.v1");
    expect(gapReport.entries).toHaveLength(14);
  });

  it("rejects invalid suggestions and records the coverage delta of the validated ones", async () => {
    const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
    const gapReport = (await fixture("zilberman.2026-08-13.palette-gaps.v1.json")) as { entries: Array<{ blockRef: string; nearestType: string }> };
    const deps = { projectRepository: stubRepository(policyProject()) };

    // Baseline (unassisted) mapping of the committed redacted snapshot.
    const baseline = mapSnapshot(snapshot);
    const baselineCoverage = aggregateMappedCoverage(baseline);
    const declined = declinedBlockGaps(baseline);
    const declinedRefs = new Set(declined.map((gap) => gap.blockRef));
    expect(declined.length).toBeGreaterThan(0);

    // The fixture classifier's suggestions for the 14 live gaps, PLUS three poisoned entries the
    // re-validation path must reject or filter:
    const homeDeclined = declined.find((gap) => gap.blockRef.startsWith("page_9563b8e16278"))!;
    const anyDeclined = declined.find((gap) => !gap.blockRef.startsWith("page_9563b8e16278"))!;
    const suggestions = [
      ...fixtureClassifier(gapReport.entries),
      // 1. An UNREGISTERED type: the builder's SUPPORTED_SECTION_TYPES check ignores it — the block
      //    must remain a gap, never be coerced into an invented type.
      { blockRef: anyDeclined.blockRef, sectionType: "mega_hero_3000", rationale: "poison: unregistered type" },
      // 2. A suggestion for a block the mapper did NOT decline: filtered before the builder sees it.
      { blockRef: "page_9563b8e16278_block_000_not_declined", sectionType: "prose" },
      // 3. Not-a-suggestion garbage: dropped by sanitization.
      { blockRef: 42, sectionType: { nested: true } } as unknown as { blockRef: string; sectionType: string }
    ];

    // Duplicate blockRefs collapse (first wins) — entry 1's poison targets a block the fixture
    // classifier also suggested for, so sanitize on a copy that puts the poison FIRST for that ref.
    const poisonFirst = [suggestions[suggestions.length - 3], ...suggestions.filter((entry) => entry !== suggestions[suggestions.length - 3])];
    const considered = sanitizeSuggestions(poisonFirst, declinedRefs);
    expect(considered.some((entry) => entry.sectionType === "mega_hero_3000")).toBe(true);
    expect(considered.some((entry) => entry.blockRef === "page_9563b8e16278_block_000_not_declined")).toBe(false);
    expect(considered.every((entry) => declinedRefs.has(entry.blockRef))).toBe(true);

    // THE HARNESS: the same captureMapStep the capture.map tool and the capture_map_refine node run.
    const envelope = await captureMapStep({ targetProjectId: "zb-replay", snapshot, suggestions: poisonFirst }, deps);
    expect(envelope.artifact).toBe("capture_map_refined.v1");
    const assistance = envelope.assistance!;
    const delta = envelope.coverageDelta!;

    // Invalid suggestion REJECTED, test-proven: the poisoned block is still accounted as a gap.
    const poisoned = assistance.rejected.find((entry) => entry.sectionType === "mega_hero_3000");
    expect(poisoned).toBeDefined();
    const poisonedAccounting = envelope.mapping.pages
      .flatMap((page) => page.blockAccounting)
      .find((entry) => entry.blockRef === anyDeclined.blockRef);
    expect(poisonedAccounting?.status).toBe("gap");

    // A disallowed-for-PageType suggestion on the home page is refused AS A GAP, never coerced:
    // the builder validates the type, then the PageType gate still runs.
    const homeSuggestion = considered.find((entry) => entry.blockRef === homeDeclined.blockRef);
    if (homeSuggestion && !["hero", "checklist", "content_grid", "bio", "newsletter_signup", "shared_ref"].includes(homeSuggestion.sectionType)) {
      const homeRejected = assistance.rejected.find((entry) => entry.blockRef === homeDeclined.blockRef);
      expect(homeRejected).toBeDefined();
      expect(homeRejected!.reason).toBe("section_not_allowed_for_page_type");
    }

    // VALID suggestions RAISE fixture coverage, with the delta recorded by the harness envelope.
    expect(assistance.applied.length).toBeGreaterThan(0);
    expect(delta.refined.mappedBlocks).toBe(delta.baseline.mappedBlocks + assistance.applied.length);
    expect(delta.baseline.mappedBlockCoverage).toBe(baselineCoverage.mappedBlockCoverage);
    expect(delta.delta).toBeGreaterThan(0);
    expect(delta.refined.mappedBlockCoverage).toBeCloseTo(delta.baseline.mappedBlockCoverage + delta.delta, 3);

    // Every considered suggestion is accounted for exactly once — applied or rejected, never lost.
    expect(assistance.applied.length + assistance.rejected.length).toBe(considered.length);
  });
});
