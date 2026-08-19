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
// WHAT IS VENDORED: the four orchestrated stages (map, theme, emit, score), their shared policy/
// snapshot helpers (snapshot-v1), and — since T12.16 — the two modules score.mjs imports for its
// visual half (screenshot-normalize, side-by-side). capture.mjs (the Playwright crawl CLI) is NOT
// vendored: per R-C1 v2 the crawl runs in the pdf-tool capture job plane (T12.8) — CMS-Agent only
// creates and polls that job (capture.crawl), so importing a local browser crawl here would be a
// second crawl implementation with no policy home.
//
// THE DEVIATION (exactly one, and since T12.16 it lives in screenshot-normalize.mjs):
//   `import sharp from 'sharp'` became a lazy dynamic import inside normalizeScreenshotPair
//   (loadSharp), and the pinned COMPARISON_RASTER_KERNEL is stated as the literal 'lanczos3' — the
//   value of sharp.kernel.lanczos3 — so the pin itself needs no module-top sharp. CMS-Agent does
//   not carry the sharp native dependency and this runtime never holds screenshot binaries (the
//   pdf-tool plane owns them), so every visual comparison resolves 'unavailable' before sharp is
//   reached — the live T12.6 run's own shape (0 scored / 34 unavailable). If preview screenshots
//   ever land in this plane, add sharp to package.json; no engine change is needed. Every other
//   vendored file, score.mjs now included, is byte-identical to upstream.
//
// T12.16 (2026-08-18) CLEARED THE T12.10 VENDORING DEBT that T12.14 recorded here: the vendored
// score.mjs had been left at its pre-T12.10 revision because T12.10 moved the pixel comparison into
// `screenshot-normalize.mjs` and added `side-by-side.mjs`, neither of which was vendored. Both are
// vendored now, score.mjs is byte-identical to upstream again (so it carries NO deviation of its
// own), and the sharp deviation moved to the module that actually needs sharp. T12.10's
// visual-evidence accounting came across with it: every unavailable comparison is an enumerated
// defect and a page with no scored comparison is a defect in its own right (`visual.defects`,
// `visual.evidenceComplete`). That is evidence accounting only — `rubric` is untouched, so visual
// evidence still explains and never authorizes.
// T12.17 (2026-08-19) RE-VENDORED emit.mjs ALONE, from platform f2a1324. Upstream taught the
// bounded asset probe to quarantine an asset it cannot fetch (`reason: 'asset_probe_failed'`)
// instead of throwing past the materialization loop and refusing the whole emission — one 403 on
// one srcset variant had been costing 11 creates and 130 media bindings. Every other vendored file
// is unchanged at the new upstream commit, and emit.mjs stays byte-identical to upstream (no
// deviation of its own). The srcset half of T12.17 lives in browser.mjs and pdf-tool's
// render-service, neither of which is vendored here: the crawl runs in the pdf-tool plane.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CAPTURE_ENGINE_UPSTREAM = {
  repo: "vreich-ui/platform",
  path: "packages/core/cli/capture/",
  commit: "f2a132472aee2f9b67abb25bd0ba877893706bd2",
  vendoredAt: "2026-08-19"
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
    vendoredSha256: "f6378e7992cf7053697dbd25761566320544ea1476c0e28cb3e9b979c3c9496b",
    upstreamSha256: "f6378e7992cf7053697dbd25761566320544ea1476c0e28cb3e9b979c3c9496b"
  },
  {
    file: "score.mjs",
    vendoredSha256: "f8fa88aeb57f5a07774bce19cde8f886e8cf20626d9513543c51f53d690eb54b",
    upstreamSha256: "f8fa88aeb57f5a07774bce19cde8f886e8cf20626d9513543c51f53d690eb54b"
  },
  {
    file: "screenshot-normalize.mjs",
    vendoredSha256: "470fb8d4a5e4ab3ccf28460d0c0998b1cc42c754919ac95a3452b523cfed482c",
    upstreamSha256: "383b5eb74094853179e31a99b4d16d59f6017915eb5959a3840dd8332163ad3b",
    deviation:
      "sharp is imported lazily inside normalizeScreenshotPair (loadSharp) instead of at module top, " +
      "and COMPARISON_RASTER_KERNEL is the literal 'lanczos3' (the value of sharp.kernel.lanczos3) so " +
      "the pin needs no module-top sharp. Behaviour is otherwise byte-faithful. See header note."
  },
  {
    file: "side-by-side.mjs",
    vendoredSha256: "73fdcbccdb330e0b5a0ca19cc5f369712dda7ab3f2cab36d199d3326e3994e74",
    upstreamSha256: "73fdcbccdb330e0b5a0ca19cc5f369712dda7ab3f2cab36d199d3326e3994e74"
  }
] as const;

export async function hashVendoredEngineFile(file: string): Promise<string> {
  const url = new URL(`./engine/${file}`, import.meta.url);
  const bytes = await readFile(fileURLToPath(url));
  return createHash("sha256").update(bytes).digest("hex");
}
