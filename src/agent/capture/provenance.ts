// T12.9 — REUSE-MECHANISM RECORD for the capture engine (the decision the brief requires recorded).
//
// DECISION: VENDOR the platform repo's pure capture-stage modules into CMS-Agent byte-faithfully,
// rather than porting/reimplementing their logic. Reasons, in order:
//   1. The engine is .mjs in another repo with no published package seam; a port would be a silent
//      fork by construction (two hand-maintained implementations of the same mapper/scorer), which
//      is exactly what the brief forbids.
//   2. Vendored bytes are verifiable: the table below records the upstream commit and per-file
//      sha256 of BOTH sides, and tests/agent/capture/captureEngineProvenance.test.ts fails the suite
//      if a vendored file drifts from its recorded hash — divergence has to be a deliberate,
//      reviewed edit to this record, never an accident.
//   3. The platform repo remains the authoring home. A capture-logic change lands there first, then
//      is re-vendored here (copy the file, update the hash, note the upstream commit) — the same
//      "one implementation, deliberate re-seed" discipline nodes.ts already lives by.
//
// WHAT IS VENDORED: the four orchestrated stages (map, theme, emit, score) plus their shared policy/
// snapshot helpers (snapshot-v1). capture.mjs (the Playwright crawl CLI) is deliberately NOT
// vendored: per R-C1 v2 the crawl runs in the pdf-tool capture job plane (T12.8) — CMS-Agent only
// creates and polls that job (capture.crawl), so importing a local browser crawl here would be a
// second crawl implementation with no policy home.
//
// THE DEVIATIONS (all in score.mjs; every other vendored file is byte-identical to upstream):
//   1. `import sharp from 'sharp'` became a lazy dynamic import inside normalizedScreenshotDiff
//      (loadSharp). CMS-Agent does not carry the sharp native dependency and this runtime never
//      holds screenshot binaries (the pdf-tool plane owns them), so every visual comparison
//      resolves 'unavailable' before sharp is reached — the live T12.6 run's own shape (0 scored /
//      34 unavailable). If preview screenshots ever land in this plane, add sharp to package.json;
//      no engine change is needed.
//   2. PRE-EXISTING VENDORING DEBT, recorded here rather than silently carried (T12.14, 2026-08-17):
//      the vendored score.mjs's VISUAL-evidence half is still at its pre-T12.10 upstream revision.
//      T12.10 moved the pixel comparison into `screenshot-normalize.mjs` and added
//      `side-by-side.mjs`, neither of which is vendored, and it landed upstream WITHOUT a
//      re-vendoring — so the recorded upstreamSha256 was already stale before this task. Bringing
//      T12.10's visual defect accounting into this plane is its own change (it needs two more
//      vendored modules and moves deviation 1 into screenshot-normalize.mjs); it is NOT folded into
//      T12.14. What T12.14 DID port across, so the capability exists in both planes, is the
//      asset-binding evidence channel (`assetBindingEvidence`, the `emissionReport` input, and the
//      optional `assets` block on the report) — lifted verbatim from upstream.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CAPTURE_ENGINE_UPSTREAM = {
  repo: "vreich-ui/platform",
  path: "packages/core/cli/capture/",
  commit: "16cc0dccc5fd8fe744710445a9ebdf0960f2f866",
  vendoredAt: "2026-08-17"
} as const;

export type VendoredEngineFile = {
  file: string;
  /** sha256 of the file as committed in THIS repo. The provenance test pins it. */
  vendoredSha256: string;
  /** sha256 of the same file at the upstream commit. Equal to vendoredSha256 unless deviated. */
  upstreamSha256: string;
  deviation?: string;
};

export const CAPTURE_ENGINE_FILES: readonly VendoredEngineFile[] = [
  {
    file: "snapshot-v1.mjs",
    vendoredSha256: "08e5dad76e44b634d50196ca7dbe980a323acde78d4e6b03b45000bfa470d95c",
    upstreamSha256: "08e5dad76e44b634d50196ca7dbe980a323acde78d4e6b03b45000bfa470d95c"
  },
  {
    file: "map.mjs",
    vendoredSha256: "0aa14363ccf55784d5a49d49a45ccce86d1923ca58b260e92c252aa016c1976c",
    upstreamSha256: "0aa14363ccf55784d5a49d49a45ccce86d1923ca58b260e92c252aa016c1976c"
  },
  {
    file: "theme.mjs",
    vendoredSha256: "c60632791f4399421772eeb16cb13e75482d944da2cd9226a759c2c8139a3a5d",
    upstreamSha256: "c60632791f4399421772eeb16cb13e75482d944da2cd9226a759c2c8139a3a5d"
  },
  {
    file: "emit.mjs",
    vendoredSha256: "bab035f60bb583a4a5affa6d6b3c28a7c3bd32ae296d8cc30fc8608392b65263",
    upstreamSha256: "bab035f60bb583a4a5affa6d6b3c28a7c3bd32ae296d8cc30fc8608392b65263"
  },
  {
    file: "score.mjs",
    vendoredSha256: "d8783d3d758566564406fa1bbffd867359eb0c72e385e8b6de75f78ecf404078",
    upstreamSha256: "f8fa88aeb57f5a07774bce19cde8f886e8cf20626d9513543c51f53d690eb54b",
    deviation:
      "(1) sharp imported lazily inside normalizedScreenshotDiff (loadSharp) instead of at module top. " +
      "(2) The visual-evidence half is still at its pre-T12.10 upstream revision: T12.10 moved the pixel " +
      "comparison into screenshot-normalize.mjs and added side-by-side.mjs, neither vendored, and landed " +
      "upstream without a re-vendoring. T12.14's asset-binding evidence channel IS ported across verbatim. " +
      "See header note."
  }
] as const;

export async function hashVendoredEngineFile(file: string): Promise<string> {
  const url = new URL(`./engine/${file}`, import.meta.url);
  const bytes = await readFile(fileURLToPath(url));
  return createHash("sha256").update(bytes).digest("hex");
}
