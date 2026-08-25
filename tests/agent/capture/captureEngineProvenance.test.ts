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

  it("covers exactly the nine vendored engine modules", () => {
    // T12.16 added screenshot-normalize.mjs and side-by-side.mjs: score.mjs imports both since
    // T12.10, so vendoring score.mjs without them is what left the old pin stale.
    // T13.1 added clone.mjs — the clone_conductor pure engine (CLONE-ENGINE-API.md Side A), a NEW
    // file rather than a re-vendoring of one of the other seven.
    // T14.5 added publish.mjs — the publish tail, the ONE module where object_publish and
    // release_to_production are reachable. Also a new file, not a re-vendoring.
    expect(CAPTURE_ENGINE_FILES.map((entry) => entry.file).sort()).toEqual([
      "clone.mjs",
      "emit.mjs",
      "map.mjs",
      "publish.mjs",
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

  it("is byte-identical to upstream everywhere except the one recorded deviation (screenshot-normalize.mjs lazy sharp import)", () => {
    // Exactly ONE file may deviate, and since T12.16 it is the module that actually needs sharp —
    // score.mjs is byte-identical to upstream again.
    expect(CAPTURE_ENGINE_FILES.filter((entry) => entry.deviation).map((entry) => entry.file)).toEqual([
      "screenshot-normalize.mjs"
    ]);
    for (const entry of CAPTURE_ENGINE_FILES) {
      if (entry.file === "screenshot-normalize.mjs") {
        expect(entry.deviation).toMatch(/sharp/);
        expect(entry.vendoredSha256).not.toBe(entry.upstreamSha256);
      } else {
        expect(entry.deviation).toBeUndefined();
        expect(entry.vendoredSha256).toBe(entry.upstreamSha256);
      }
    }
  });
});
