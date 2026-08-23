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
// report) through block_classifier's seam with a FIXTURE classifier, proving the re-validation path.
//
// T12.14 UPDATE (2026-08-17): the deterministic mapper now BINDS media blocks instead of declining
// them, so most of the 14 recorded gaps never reach the classifier at all — which is the
// deterministic-first law working, not a regression. The population the model is asked to judge
// shrank to the blocks whose evidence is genuinely textual, and the harness now also asserts that no
// declined gap still asks for asset materialization. Proving:
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
    // T12.14: no gap the classifier is asked to judge still asks for asset materialization — the
    // mapper answers that deterministically now, before any model is consulted.
    for (const capability of [
      "first-party artifact materialization plus a schema-safe asset field; source URLs cannot be emitted as hotlinks",
      "materialized first-party asset references and item-level text association"
    ]) {
      expect(declined.some((gap) => gap.missingCapability === capability)).toBe(false);
    }
    // T12.29-T12.31 shrank the declined population to the blocks whose evidence is genuinely
    // insufficient — media now binds, mixed content becomes a `composition`, and no page type
    // discards a section any more. Two blocks remain declined, which is still enough to exercise
    // every branch of this seam: one carries the VALID suggestion, the other the poison. Picking
    // the poison target by page prefix (as this did) assumed several declined home blocks and now
    // finds none, so the roles are assigned by identity instead.
    const poisonTarget = homeDeclined;
    expect(poisonTarget.blockRef).not.toBe(anyDeclined.blockRef);
    const suggestions = [
      ...fixtureClassifier(gapReport.entries),
      // 0. A VALID suggestion for a still-declined block on a STANDARD page: the builder validates
      //    it, applies it, and the harness records the coverage delta it produced.
      { blockRef: anyDeclined.blockRef, sectionType: "prose", rationale: "fixture classifier: textual evidence" },
      // 1. An UNREGISTERED type: the builder's SUPPORTED_SECTION_TYPES check ignores it — the block
      //    must remain a gap, never be coerced into an invented type.
      { blockRef: poisonTarget.blockRef, sectionType: "mega_hero_3000", rationale: "poison: unregistered type" },
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
      .find((entry) => entry.blockRef === poisonTarget.blockRef);
    expect(poisonedAccounting?.status).toBe("gap");

    // THE PAGETYPE GATE IS NO LONGER REACHABLE FROM CAPTURE — recorded, not quietly dropped.
    //
    // This used to assert that a suggestion the home family forbids is refused as a gap rather than
    // coerced. Since T12.29 a captured page declares pageType 'clone', whose allowedSections is
    // 'any', so no suggestion can be refused on page-type grounds any more. The gate itself is
    // unchanged and still runs — it is simply never the thing that says no on a cloned page.
    //
    // That is the intended consequence: the gate existed to stop capture from coercing a section
    // onto a page family that forbids it, and the fix was to stop putting cloned pages into a
    // family that was never meant for them. The re-validation guarantees this test exists for —
    // unregistered types rejected, non-declined blocks filtered, garbage sanitized — are asserted
    // above and below, and none of them depend on the page type.
    expect(envelope.mapping.pages.every((page) => page.pageBody.pageType === "clone")).toBe(true);
    expect(assistance.rejected.some((entry) => entry.reason === "section_not_allowed_for_page_type")).toBe(false);

    // VALID suggestions RAISE fixture coverage, with the delta recorded by the harness envelope.
    expect(assistance.applied.length).toBeGreaterThan(0);
    expect(assistance.applied.some((entry) => entry.blockRef === anyDeclined.blockRef && entry.sectionType === "prose")).toBe(true);
    expect(delta.refined.mappedBlocks).toBe(delta.baseline.mappedBlocks + assistance.applied.length);
    expect(delta.baseline.mappedBlockCoverage).toBe(baselineCoverage.mappedBlockCoverage);
    expect(delta.delta).toBeGreaterThan(0);
    expect(delta.refined.mappedBlockCoverage).toBeCloseTo(delta.baseline.mappedBlockCoverage + delta.delta, 3);

    // Every considered suggestion is accounted for exactly once — applied or rejected, never lost.
    expect(assistance.applied.length + assistance.rejected.length).toBe(considered.length);
  });
});
