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
// THE ONE DEVIATION: score.mjs's `import sharp from 'sharp'` became a lazy dynamic import inside
// normalizedScreenshotDiff (loadSharp). CMS-Agent does not carry the sharp native dependency and
// this runtime never holds screenshot binaries (the pdf-tool plane owns them), so every visual
// comparison resolves 'unavailable' before sharp is reached — the live T12.6 run's own shape
// (0 scored / 34 unavailable). Everything else in score.mjs, and every other vendored file, is
// byte-identical to upstream. If preview screenshots ever land in this plane, add sharp to
// package.json; no engine change is needed.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CAPTURE_ENGINE_UPSTREAM = {
  repo: "vreich-ui/platform",
  path: "packages/core/cli/capture/",
  commit: "2feb0001d283585f42be9ad65a891362fc581f69",
  vendoredAt: "2026-08-13"
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
    vendoredSha256: "7e80b65c42b50a1a026fe006afb425d3a290f20d98d8c01a4c6110506c90f656",
    upstreamSha256: "7e80b65c42b50a1a026fe006afb425d3a290f20d98d8c01a4c6110506c90f656"
  },
  {
    file: "theme.mjs",
    vendoredSha256: "c60632791f4399421772eeb16cb13e75482d944da2cd9226a759c2c8139a3a5d",
    upstreamSha256: "c60632791f4399421772eeb16cb13e75482d944da2cd9226a759c2c8139a3a5d"
  },
  {
    file: "emit.mjs",
    vendoredSha256: "b5c2995ed8b1ef406988913326474c990d1babf7d623f02241c580df5c21ae99",
    upstreamSha256: "b5c2995ed8b1ef406988913326474c990d1babf7d623f02241c580df5c21ae99"
  },
  {
    file: "score.mjs",
    vendoredSha256: "288115dd031c3017153bca0927cdf7b78f37f2f3b1dae11bdc7b8ae1bab3b453",
    upstreamSha256: "0c9dae9d6b5196d26911d769637b508fe1b611e9f18511019fd0fe582ab9b4fc",
    deviation: "sharp imported lazily inside normalizedScreenshotDiff (loadSharp) instead of at module top; function body otherwise byte-faithful. See header note."
  }
] as const;

export async function hashVendoredEngineFile(file: string): Promise<string> {
  const url = new URL(`./engine/${file}`, import.meta.url);
  const bytes = await readFile(fileURLToPath(url));
  return createHash("sha256").update(bytes).digest("hex");
}
