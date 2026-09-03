import { describe, expect, it } from "vitest";
import { CAPTURE_ENGINE_FILES, CAPTURE_ENGINE_UPSTREAM, hashVendoredEngineFile } from "../../../src/agent/capture/provenance.js";

// T12.9 reuse-mechanism guard: the capture engine is VENDORED from the platform repo byte-faithfully
// (provenance.ts records the decision, the upstream commit, and per-file hashes). This test makes
// silent divergence impossible — editing a vendored file without updating the provenance record (a
// deliberate, reviewable act) fails the suite.
describe("vendored capture engine provenance", () => {
  it("records the upstream source", () => {
    expect(CAPTURE_ENGINE_UPSTREAM.repo).toBe("vreich-ui/platform");
    expect(CAPTURE_ENGINE_UPSTREAM.path).toBe("packages/core/cli/capture/");
    expect(CAPTURE_ENGINE_UPSTREAM.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("covers exactly the eight vendored engine modules", () => {
    // T12.16 added screenshot-normalize.mjs and side-by-side.mjs: score.mjs imports both since
    // T12.10, so vendoring score.mjs without them is what left the old pin stale.
    // T13.1 added clone.mjs — the clone_conductor pure engine (CLONE-ENGINE-API.md Side A), a NEW
    // file rather than a re-vendoring of one of the other seven.
    // T14.5 added publish.mjs — the publish tail, the ONE module where object_publish and
    // release_to_production were reachable. T15.7 DELETES it (and its entry): capture now reaches
    // both verbs through the shared publishing tail (workspace/objectPublishExecution.ts,
    // workspace/releaseExecution.ts) instead of a vendored capture-local module, so there is nothing
    // left here to vendor or hash for publishing.
    expect(CAPTURE_ENGINE_FILES.map((entry) => entry.file).sort()).toEqual([
      "clone.mjs",
      "emit.mjs",
      "map.mjs",
      "score.mjs",
      "screenshot-normalize.mjs",
      "side-by-side.mjs",
      "snapshot-v1.mjs",
      "theme.mjs"
    ]);
  });

  it.each(CAPTURE_ENGINE_FILES.map((entry) => [entry.file, entry] as const))("%s matches its recorded vendored hash", async (_file, entry) => {
    expect(await hashVendoredEngineFile(entry.file)).toBe(entry.vendoredSha256);
  });

  it("is byte-identical to upstream everywhere except the recorded deviations (screenshot-normalize.mjs lazy sharp import; clone.mjs's T15.30 demand-driven intake; theme.mjs's C3 imagery observations — the last two pending platform re-vendor)", () => {
    // Three files may deviate today: screenshot-normalize.mjs since T12.16 (the module that actually
    // needs sharp — score.mjs is byte-identical to upstream again), clone.mjs since T15.30/#206
    // (buildCloneIntake's demand-driven structureBrief branch), and theme.mjs since C3 (observeImagery
    // plus the report key that carries it, so a captured site's imagery becomes a DRAFT
    // visual_standard instead of a dropped line) — each added CMS-Agent-side ahead of a platform-side
    // companion vendoring this repo's worktree cannot perform, see provenance.ts's own comment on each
    // entry. Any OTHER file deviating is undocumented drift and must fail this test.
    expect(CAPTURE_ENGINE_FILES.filter((entry) => entry.deviation).map((entry) => entry.file).sort()).toEqual([
      "clone.mjs",
      "screenshot-normalize.mjs",
      "theme.mjs"
    ]);
    for (const entry of CAPTURE_ENGINE_FILES) {
      if (entry.file === "screenshot-normalize.mjs") {
        expect(entry.deviation).toMatch(/sharp/);
        expect(entry.vendoredSha256).not.toBe(entry.upstreamSha256);
      } else if (entry.file === "clone.mjs") {
        expect(entry.deviation).toMatch(/T15\.30/);
        expect(entry.vendoredSha256).not.toBe(entry.upstreamSha256);
      } else if (entry.file === "theme.mjs") {
        // The deviation must say WHAT it added and that the additions are structural only — the
        // property that keeps capture's rights discipline intact through this change.
        expect(entry.deviation).toMatch(/observeImagery/);
        expect(entry.deviation).toMatch(/STRUCTURAL/);
        expect(entry.vendoredSha256).not.toBe(entry.upstreamSha256);
      } else {
        expect(entry.deviation).toBeUndefined();
        expect(entry.vendoredSha256).toBe(entry.upstreamSha256);
      }
    }
  });
});
