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
// T12.23 (2026-08-21) RE-VENDORED map.mjs AND emit.mjs, from platform ae4b922. Upstream taught the
// mapper to read a block's RECOVERED DOM SHAPE (`block.structure`, new in the same commit's
// browser.mjs) instead of only its flattened text, which is what capped every clone at 10 of the
// platform's 24 section types: faq, stats, timeline, steps, testimonial, checklist and
// comparison_table are shapes, and the shape was being discarded at crawl time. SUPPORTED_SECTION_TYPES
// — the vocabulary block_classifier may choose from — went from 7 to 14 with it. emit.mjs came
// across for the recipe change in the same commit: section_template plans group by shape
// fingerprint rather than by type name, so two different shapes of one type stop colliding on a
// single requestedId. Both files stay byte-identical to upstream (no deviation of either own).
//
// The crawl half is NOT here and must not be: browser.mjs runs in the pdf-tool capture job plane
// (pdf-tool af0a4af), the same split T12.17's srcset fix lives under. Until that plane redeploys,
// snapshots carry no `structure` key and this mapper behaves exactly as it did before — the change
// is additive by construction, which is why it is safe to vendor ahead of that deploy.
// T12.28 (2026-08-21) RE-VENDORED emit.mjs ALONE, from platform 04c1e383. Upstream taught the
// emitter to REUSE: a route (or a navigation role) that already exists is patched in place through
// checkout -> typed ops -> checkin instead of being quarantined. Before this, a live run against a
// tenant that already had its routes produced createdObjects: 0, five route_collisions, and bound 0
// of 132 planned media -- media binds into a page section, so a page that is never written renders
// nothing. Publishing stays unreachable and every op still passes object_patch's own validation;
// the lease is released in a finally so a failed patch cannot strand a lock on a live page. An
// empty capture refuses rather than blanking the page it would otherwise clear.
// T12.29-T12.31 (2026-08-22) RE-VENDORED map.mjs AND emit.mjs, from platform f85fc142. Three
// upstream changes, all aimed at the same thing — a clone that renders what the source actually had:
//   T12.29 captured pages declare pageType 'clone' (allowedSections 'any') instead of 'home', whose
//     six-type DTC family (C§1.1) was discarding media/content_split/brand_row from every cloned
//     homepage. `home` itself is untouched; the emitter now sends pageType with the reuse patch, or
//     a reused '/' keeps its old type and rejects the very imagery the patch just bound.
//   T12.30 a gallery beyond a section's capacity is DIVIDED into consecutive sections instead of
//     truncated with the remainder logged as a gap. Divided evenly — 9 at a cap of 8 gives 5+4, not
//     8+1, which for a logo strip would be invalid outright.
//   T12.31 one composable section type, `composition`, for the residue no named type can hold: a
//     block with copy AND images, or images AND links. Closed three-kind block union, flat images
//     array bound by the existing first-party path, image blocks addressed by index and repaired if
//     a planned image fails to materialize. Chosen only after every named type is refused.
// On the reference fixture: mapped coverage 52.63% -> 89.47%, gaps 14 -> 4, asset sections 7 -> 14.
// Both files stay byte-identical to upstream.
// T13.1 (2026-08-23) VENDORED clone.mjs — a NEW file, not a re-vendoring of one already listed above.
// It is Side A of CLONE-ENGINE-API.md: the clone_conductor pure engine (intake / recipe validation /
// mint plan / theme apply plan / restamp ops / run report), authored in platform alongside this task
// rather than pulled from the CAPTURE_ENGINE_UPSTREAM.commit pin above — that pin still names the
// commit the OTHER SEVEN files were last re-vendored at and is deliberately left untouched here,
// because none of them were touched for this task. clone.mjs is recorded with its own hash below,
// byte-identical to platform's packages/core/cli/capture/clone.mjs, no deviation of its own.
// T13.2 (2026-08-23) RE-VENDORED clone.mjs ALONE (CLONE-INTAKE-FIX.md). The live run
// run_1787508397978_8fyyst emitted a `clone_intake.v1` of 637,769 chars against the executor's
// 48,000-char dependency bound; both AI nodes reported the starvation honestly rather than inventing,
// so the prompts and refusals held and the DATA was the whole defect. Upstream turned the envelope
// into a BOUNDED BRIEFING DOCUMENT — shapes, slots and vocabulary only, measured against its own
// serialization, degraded in a fixed documented order with every drop recorded in `budget.truncated`,
// and refusing outright (`intake_cannot_be_bounded`) rather than shipping a silent truncation. With
// it, three signatures changed and this repo's consumers changed with them:
//   buildCloneIntake({...,siteBody,theme,...}) — `snapshot` and `policy` are GONE; `siteBody` is the
//     object_get BODY of the site (an object_inventory ROW carries no brandTokens, which is why the
//     live theme_reconciler had no slots to enumerate and correctly refused);
//   buildRestampOps({intake, mintReport, pageBodies}) — page bodies arrive explicitly, because the
//     briefing carries page SHAPES only and the restamp stage has transport of its own;
//   validateThemeProposal({proposal, intake}) — reads intake.site.brandTokens, so there is exactly
//     one place a site palette can enter a clone run.
// The envelope now carries `artifact:'clone_intake.v1'` and NO `schemaVersion` key. clone.mjs stays
// byte-identical to platform's packages/core/cli/capture/clone.mjs (no deviation of its own); the
// upstream change is not yet committed there, so CAPTURE_ENGINE_UPSTREAM.commit below still names the
// commit the OTHER SEVEN files were last re-vendored at and is deliberately left untouched — the
// per-file hash pair is what pins clone.mjs, and the provenance test proves the two copies match.
// T14.3 (2026-08-24) RE-VENDORED map.mjs AND emit.mjs (platform f2eeebe, T14.2 "capture the
// picture, not the thumbnail of it"). Wolf, on the cloned filmography page: "the images were
// thumbnails yet the process made them stretch." Every asset URL there carried the display size in
// its path (fill/w_146,h_194 on 108 of them); the engine downloaded exactly that and the section
// rendered it 980-1440px wide. map.mjs gains canonicalizeAssetUrl (proposes the untransformed
// original across the Wix/Cloudinary/imgix/Shopify/Squarespace family, matched on HOST so a
// look-alike path on a stranger's host is returned untouched) and assetFidelity (the no-upscale
// rule); emit.mjs gains imageDimensions and makes createAssetProbe the VERIFYING caller — it takes
// an upgrade only when the bytes decode strictly larger, and falls back to the captured URL on a
// 404, an off-host redirect, HTML behind a 200, an unreadable format or a throw. Not-verifiable is
// a fallback, never a pass.
//
// browser.mjs and the new gallery-items.mjs are NOT vendored here and must not be: the DOM walk
// belongs to the pdf-tool crawl plane, and gallery-items.mjs exists precisely so the grouping
// JUDGMENT is reachable without playwright. This runtime consumes their OUTPUT (snapshot
// structure.gallery), never their code.
//
// screenshot-normalize.mjs reads as changed against upstream and is NOT drift — it is the one
// recorded deviation (T12.16, the lazy sharp import), unchanged by this re-vendor.
//
// T13.3 (2026-08-24) RE-VENDORED clone.mjs ALONE — two seam fixes:
//   (1) appliesTo/applies_to mismatch. run_1787567551705_e1qp0l's recipe_designer emitted
//     `applies_to` (per its own outputSchema at the time) into `validateTemplateDesign`, which only
//     ever read `appliesTo`; a good template design was rejected `malformed_design` for a spelling
//     mismatch unrelated to its content. `validateTemplateDesign` is now a TOLERANT READER: it
//     accepts either `appliesTo` or `applies_to` on input (preferring `appliesTo` when both are
//     present and non-empty), and normalizes to `appliesTo` alone — the one canonical name that was
//     always written to the platform (`row?.body?.appliesTo`). Nothing about what gets WRITTEN
//     changed. cloneConductorNodes.ts's recipe_designer node was corrected to emit `appliesTo`.
//   (2) the credential redactor ate the palette. OpenAINodeRunner.ts/AnthropicNodeRunner.ts's
//     per-node prompt redactor (`/token/i`, among other patterns) silently replaces any input key
//     matching it with "[REDACTED]" before a model sees it — `site.brandTokens` and `theme.tokens`
//     both matched, so theme_reconciler's whole palette arrived as the literal string "[REDACTED]"
//     and it correctly, uselessly, refused. THE REDACTOR ITSELF IS UNTOUCHED (it is a global
//     security control, not a bug). Instead the briefing's own field names were changed to not
//     collide: `site.brandTokens` -> `site.palette`, `theme.tokens` -> `theme.palette` (same
//     {colors, fonts} shape). Every downstream reader inside clone.mjs (`validateThemeProposal`)
//     follows. The value actually WRITTEN to the platform is unchanged: `set_theme_fields` still
//     writes `tokens`, `site_apply_theme` still drives the real `brandTokens` field — only the
//     briefing's own vocabulary changed. A guard test in clone.test.mjs now walks every key at every
//     depth of a realistic buildCloneIntake() result and asserts none collides with the redactor's
//     pattern, so this class of defect cannot silently ship again.
// clone.mjs stays byte-identical to platform's packages/core/cli/capture/clone.mjs (no deviation of
// its own); CAPTURE_ENGINE_UPSTREAM.commit below is still deliberately left untouched, for the same
// reason T13.2 left it untouched — the per-file hash pair is what pins clone.mjs.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// T14.5 (2026-08-25) VENDORED publish.mjs, a NEW file authored in platform (78e67f0) — the ONE module
// in this engine where `object_publish` and `release_to_production` were reachable, calling
// release_to_production directly and tagged riskLevel:"write" to dodge the publish-risk machinery
// (ADR-2026-08-25-publish-autonomy §1). T15.7 (2026-08-25, this task) DELETES it, on both sides, per
// the ADR's §9 ordering: T15.6 first carried its object-scoped self-check — per-object
// postcreate/postpatch validation required, quarantine exclusion, named withholding, the non-throwing
// per-object loop, finally-released leases — into the canonical workspace/objectPublishExecution.ts,
// so this deletion removes a SECOND path, not the only one. Its entry below is REMOVED, not merely
// unlisted: an entry left behind would assert an upstream file this repo no longer vendors.
//
// PLATFORM-SIDE COMPANION DELETION REQUIRED, NOT PERFORMED BY THIS COMMIT (T15.8, platform#615, a
// DIFFERENT agent's task per the vendored-engine rule — this repo's worktree does not touch platform):
// delete platform/packages/core/cli/capture/publish.mjs (and its .d.mts sibling, if platform generates
// one, matching this repo's publish.d.mts). Until that lands, the platform repo still carries the file
// this repo no longer vendors or verifies — a stale, orphaned copy, not a divergent one, because
// nothing in THIS repo reads or hashes it any more once the entry below is gone.

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
    vendoredSha256: "c233bb27f931657f08f6b51c3e73dfdaf863f95c0ae4c22fb5dec1e27501166d",
    upstreamSha256: "c233bb27f931657f08f6b51c3e73dfdaf863f95c0ae4c22fb5dec1e27501166d"
  },
  {
    file: "theme.mjs",
    vendoredSha256: "c60632791f4399421772eeb16cb13e75482d944da2cd9226a759c2c8139a3a5d",
    upstreamSha256: "c60632791f4399421772eeb16cb13e75482d944da2cd9226a759c2c8139a3a5d"
  },
  {
    file: "emit.mjs",
    vendoredSha256: "275c701794ca98f3e294b8eff8dbce6860741fe806538796928bd744628f8089",
    upstreamSha256: "275c701794ca98f3e294b8eff8dbce6860741fe806538796928bd744628f8089"
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
  },
  {
    file: "clone.mjs",
    vendoredSha256: "460963ec628454e161afcc0863c3277a6db82405ba1c5c66ab6329c6e03f9257",
    upstreamSha256: "54f8f1d08bdb66027fc063e6519777117cf94173ae8035eb98a309986767fdcf",
    deviation:
      "T15.30 (#206; ADR-2026-08-25-structure-studio §3) adds buildCloneIntake's demand-driven " +
      "branch (structureBrief as the alternative to captureRunId, normalized into the identical " +
      "clone_intake.v1 shape — entryMode/sourceUrl/mismatches, plus the optional structureBrief.pages " +
      "passthrough) ahead of a platform-side companion vendoring this repo's worktree cannot perform " +
      "(the vendored-engine rule: platform changes are a different agent's task, same posture as the " +
      "T14.5/T15.7 publish.mjs deletion note above). upstreamSha256 stays pinned to the pre-T15.30 " +
      "platform commit until that companion change lands and this file is re-vendored byte-identical " +
      "again. T2 (2026-08-26) adds a SECOND CMS-Agent-side deviation to the same entry, under the " +
      "same rule and the same pin: applyCloneDelta, which compares a built briefing against the " +
      "target's LIVE page bodies and the site's live palette and attaches a `delta` ledger — the " +
      "theme half is a verdict theme_bind acts on (two live runs, run_1787748666186_ammpuv and " +
      "run_1787748899372_lbvqdz, re-applied a byte-identical palette with matching before/after " +
      "blocks), the page half is drift evidence only, for the reason applyCloneDelta's own header " +
      "gives at length. Additive: it is a new exported function plus a `delta` key on the envelope " +
      "and a `delta` block on the run report; every OTHER behavior in this file (clone-driven " +
      "intake, recipe validation, mint, theme apply, restamp, the rest of the run report) is " +
      "untouched, and no existing field changed shape."
  }
  // T15.7 — publish.mjs's entry is DELETED here, along with the file (src/agent/capture/engine/
  // publish.mjs) and the (still-pending, platform-side) upstream file it pinned. See the T14.5/T15.7
  // header note above.
] as const;

export async function hashVendoredEngineFile(file: string): Promise<string> {
  const url = new URL(`./engine/${file}`, import.meta.url);
  const bytes = await readFile(fileURLToPath(url));
  return createHash("sha256").update(bytes).digest("hex");
}
