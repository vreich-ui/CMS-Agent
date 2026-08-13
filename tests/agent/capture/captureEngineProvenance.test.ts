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

  it("covers exactly the five vendored stage modules", () => {
    expect(CAPTURE_ENGINE_FILES.map((entry) => entry.file).sort()).toEqual(["emit.mjs", "map.mjs", "score.mjs", "snapshot-v1.mjs", "theme.mjs"]);
  });

  it.each(CAPTURE_ENGINE_FILES.map((entry) => [entry.file, entry] as const))("%s matches its recorded vendored hash", async (_file, entry) => {
    expect(await hashVendoredEngineFile(entry.file)).toBe(entry.vendoredSha256);
  });

  it("is byte-identical to upstream everywhere except the one recorded deviation (score.mjs lazy sharp import)", () => {
    for (const entry of CAPTURE_ENGINE_FILES) {
      if (entry.file === "score.mjs") {
        expect(entry.deviation).toMatch(/sharp/);
        expect(entry.vendoredSha256).not.toBe(entry.upstreamSha256);
      } else {
        expect(entry.deviation).toBeUndefined();
        expect(entry.vendoredSha256).toBe(entry.upstreamSha256);
      }
    }
  });
});
