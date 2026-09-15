// Milestone A remainder (runner 3a) — THE PRODUCTION WIRING for the three seams
// imageTemplateRevisionProviders.ts leaves `undefined` outside tests.
//
// Until this module existed, nothing but a test ever called setImageTemplateRevisionProviders, so a
// LIVE image_template_revision run always saw the defaults: NOT_CONFIGURED_ASSET_CATALOG plus two
// undefined functions, and every item came back source_resolve_failed / preview_failed /
// verify_failed by name. The seams are assembled PER RUN (the tenant, its site object id and the
// run's own tenantContext are all run-scoped), never registered as a global — the module-level
// singleton in imageTemplateRevisionProviders.ts stays exactly what it was: a TEST override.
//
// WHAT EACH SEAM IS BACKED BY, and the two places the platform cannot do what A9's seam signature
// assumed (both named here rather than papered over with a guess):
//
//   assetCatalog          search_artifacts (+ get_artifact_metadata for the chosen reference, which
//                         returns the FULL ArtifactReference rather than the listing projection).
//                         GAP: a live image ArtifactReference carries no pixel dimensions. Verified
//                         on dr-lurie 2026-09-15 — a real row is {blobKey, sizeBytes, sha256,
//                         contentType, createdAtISO, artifactKind, originalFilename, filename, tags,
//                         metadata:{imageRole, usageContext}} and nothing in platform's
//                         ArtifactReference type (packages/core/server/lib/artifacts.ts) declares
//                         widthPx/heightPx either; analyze_image_layout returns normalized grid
//                         hints, never pixel sizes. ResolvedSourceAsset.widthPx/heightPx feed
//                         compileRecurringHeaderImageEdit's placement arithmetic, so a guessed value
//                         is a silently wrong picture on every page of every template this run
//                         touches. This module therefore REFUSES BY NAME
//                         (image_revision_asset_dimensions_unavailable) when the resolved reference
//                         does not state them — distinct from "no asset matched", exactly as
//                         AssetCatalogSource.configured's own comment demands. Closing this needs
//                         platform to persist widthPx/heightPx on image references (pdf-tool already
//                         reports them on its own artifact blocks — annotate_image's `artifact`), and
//                         is the one thing standing between this seam and a green live run.
//
//   previewTemplateVariant preview_pdf_template_fixture, fixture "images", once for the BEFORE
//                         (stored) version. GAP: that verb renders the STORED template
//                         (template_id + version) and uses `template_json` only to derive the
//                         fixture's data (mcp-tool-handlers.ts callPreviewPdfTemplateFixture ->
//                         template-preview.ts createJob passes templateId/version, never a template
//                         body), so the AFTER variant — which does not exist in the store until
//                         apply mints it — cannot be rendered from this stage at all. Rendering it
//                         would mean minting a draft version from a READ stage. So the after render
//                         is reported as a named gap (image_revision_after_preview_unavailable) and
//                         the real after-evidence is produced at apply, below, against the version
//                         that actually went live. Never a second copy of the before render dressed
//                         up as an after.
//
//   verifyImagePresence   preview_pdf_template_fixture on the PUBLISHED version (the one apply just
//                         minted and published — a stored version, so this one IS renderable) then
//                         verify_pdf_content on that rendered artifact's public path. Per-page
//                         answers come from the verdict's own UNRESOLVED_IMAGE findings' `page`
//                         field (document-content-check.ts). A findings set that cannot say which
//                         page is reported as verify_page_granularity_unavailable — never an
//                         invented page list, and never a pass.
import { callProjectTool, CloneRefusal, type CloneDeps } from "./cloneEngine.js";
import type { ResolvedSourceAsset } from "./imageTemplateRevisionEngine.js";
import type { ImageTemplateRevisionProviders } from "../workspace/imageTemplateRevisionProviders.js";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// An image artifact's blobKey is `image/<requestId>/<sha256>.<ext>`; its renderable form — the ONLY
// form a template's `content` may take — is the public path `/img/<requestId>/<sha256>.<ext>`.
const IMAGE_BLOB_KEY = /^image\/([^/]+)\/([a-f0-9]{64})\.([a-z0-9]+)$/i;

export function imagePublicPath(blobKey: unknown): string | undefined {
  if (!nonEmptyString(blobKey)) return undefined;
  const match = IMAGE_BLOB_KEY.exec(blobKey.trim());
  if (!match) return undefined;
  return `/img/${match[1]}/${match[2].toLowerCase()}.${match[3].toLowerCase()}`;
}

const requestIdOfBlobKey = (blobKey: unknown): string | undefined => {
  if (!nonEmptyString(blobKey)) return undefined;
  const match = IMAGE_BLOB_KEY.exec(blobKey.trim());
  return match ? match[1] : undefined;
};

/** Dimensions, read only from fields that actually STATE them. Never inferred from sizeBytes, never
 *  defaulted: see this module's header for why a wrong number here is a wrong picture. */
export function readAssetDimensions(reference: Record<string, unknown>): { widthPx: number; heightPx: number } | undefined {
  const metadata = isRecord(reference.metadata) ? reference.metadata : {};
  const pairs: Array<[unknown, unknown]> = [
    [reference.widthPx, reference.heightPx],
    [metadata.widthPx, metadata.heightPx],
    [metadata.width, metadata.height]
  ];
  for (const [width, height] of pairs) {
    if (typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { widthPx: width, heightPx: height };
    }
  }
  return undefined;
}

const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 5;

export type PlatformImageProviderScope = {
  /** The tenant project whose own MCP surface serves every verb below. */
  targetProjectId: string;
  /** objectDialect.siteObjectId, resolved by the caller through pdfToolSiteScope.ts. Absent only on
   *  a stage that could not resolve one — every pdf-tool-scoped seam then refuses by name rather
   *  than sending a call platform would reject with artifact_site_mismatch. */
  siteId?: string;
  deps?: CloneDeps;
};

export function buildImageTemplateRevisionProviders(scope: PlatformImageProviderScope): ImageTemplateRevisionProviders {
  const { targetProjectId, siteId, deps = {} } = scope;

  const call = (tool: string, args: Record<string, unknown>) => callProjectTool(targetProjectId, tool, args, deps);

  const requireSiteId = (verb: string): string => {
    if (nonEmptyString(siteId)) return siteId;
    throw new CloneRefusal(
      "pdf_tool_site_id_unresolved",
      `${verb} is site-scoped and this run resolved no site object id for project "${targetProjectId}" (objectDialect.siteObjectId); no call was attempted. See pdfToolSiteScope.ts — the tenantId is never a stand-in.`
    );
  };

  /** One search_artifacts page walk, bounded. An exhausted budget is NAMED, never reported as "not
   *  found": the two call for different next steps (narrow the query vs. the asset does not exist). */
  const scan = async (match: (reference: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown> | undefined> => {
    let cursor: string | undefined;
    for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
      const result = await call("search_artifacts", { limit: SCAN_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      const rows = Array.isArray(result.artifacts) ? result.artifacts : [];
      for (const row of rows) {
        if (isRecord(row) && match(row)) return row;
      }
      const next = result.nextCursor;
      if (!nonEmptyString(next)) return undefined;
      cursor = next;
    }
    throw new CloneRefusal(
      "image_revision_asset_scan_exhausted",
      `Searched ${SCAN_MAX_PAGES * SCAN_PAGE_SIZE} artifact references on "${targetProjectId}" without reaching the end of the index and did not find ${what}. This is an exhausted search budget, NOT "no such asset" — name the asset by tag (search_artifacts' own by-tag index answers in one page) instead of by ${what.split(" ")[0]}.`
    );
  };

  /** The FULL reference for a row the listing projection may have trimmed, plus the soft-delete
   *  check the listing already applies but get_artifact_metadata deliberately does not. */
  const fullReference = async (row: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requestId = requestIdOfBlobKey(row.blobKey);
    const sha256 = nonEmptyString(row.sha256) ? row.sha256.toLowerCase() : undefined;
    if (!requestId || !sha256) return row;
    const result = await call("get_artifact_metadata", { requestId, sha256 });
    const reference = isRecord(result.artifact) ? (result.artifact as Record<string, unknown>) : result;
    return { ...row, ...reference };
  };

  const toResolvedAsset = (reference: Record<string, unknown>, tenantId: string): ResolvedSourceAsset => {
    const blobKey = reference.blobKey;
    const publicPath = imagePublicPath(blobKey);
    const sha256 = nonEmptyString(reference.sha256) ? reference.sha256.toLowerCase() : "";
    if (!publicPath || !sha256) {
      throw new CloneRefusal(
        "image_revision_asset_not_an_image",
        `Artifact "${String(blobKey)}" on tenant "${tenantId}" is not an image artifact addressable as /img/<requestId>/<sha256>.<ext>; a template's image content field may only be that public path, so nothing was placed.`
      );
    }
    if (nonEmptyString(reference.deletedAtISO)) {
      throw new CloneRefusal(
        "image_revision_asset_soft_deleted",
        `Artifact ${sha256} on tenant "${tenantId}" carries deletedAtISO ${String(reference.deletedAtISO)} — a soft-deleted reference is excluded from trust checks and publish, so it is never placed on a template. Restore it first, or name another asset.`
      );
    }
    const dimensions = readAssetDimensions(reference);
    if (!dimensions) {
      throw new CloneRefusal(
        "image_revision_asset_dimensions_unavailable",
        `Artifact ${sha256} on tenant "${tenantId}" was FOUND, but neither its reference nor its metadata states pixel dimensions, and platform's artifact surface (search_artifacts / get_artifact_metadata / analyze_image_layout) exposes none. image_template_revision scales the source into a reserved header band from widthPx/heightPx, so placing it would mean guessing the aspect ratio on every page of every target template. This is a MISSING CAPABILITY on the artifact plane, not a lookup miss: platform must persist widthPx/heightPx on image ArtifactReferences (pdf-tool already reports them on its own artifact blocks) before this asset can be placed.`
      );
    }
    const captureRequestId = requestIdOfBlobKey(blobKey) ?? null;
    return {
      assetId: sha256,
      checksum: sha256,
      tags: Array.isArray(reference.tags) ? reference.tags.filter(nonEmptyString) : [],
      widthPx: dimensions.widthPx,
      heightPx: dimensions.heightPx,
      reference: publicPath,
      provenance: { captureRequestId }
    };
  };

  return {
    assetCatalog: {
      configured: true,
      resolveByTag: async (tenantId, tag) => {
        const result = await call("search_artifacts", { tag, limit: SCAN_PAGE_SIZE });
        const rows = (Array.isArray(result.artifacts) ? result.artifacts : []).filter(isRecord).filter((row) => imagePublicPath(row.blobKey) !== undefined);
        if (rows.length === 0) return [];
        if (rows.length > 1) {
          // Named HERE rather than resolved into N assets for resolveSourceImageStep to count,
          // because mapping every candidate would raise a dimensions refusal for assets this run was
          // never going to use. Same code the engine's own ambiguity branch reports.
          throw new CloneRefusal(
            "image_revision_source_tag_ambiguous",
            `${rows.length} artifacts are tagged "${tag}" on tenant "${tenantId}" (${rows.map((row) => String(row.sha256).slice(0, 12)).join(", ")}); supply a checksum (or a capture request id) to disambiguate rather than guessing.`
          );
        }
        return [toResolvedAsset(await fullReference(rows[0]), tenantId)];
      },
      resolveByChecksum: async (tenantId, checksum) => {
        const wanted = checksum.trim().toLowerCase();
        const row = await scan((reference) => nonEmptyString(reference.sha256) && reference.sha256.toLowerCase() === wanted, `checksum ${wanted}`);
        if (!row) return undefined;
        return toResolvedAsset(await fullReference(row), tenantId);
      },
      resolveByCaptureRequestId: async (tenantId, captureRequestId) => {
        const wanted = captureRequestId.trim();
        const row = await scan((reference) => requestIdOfBlobKey(reference.blobKey) === wanted, `capture request ${wanted}`);
        if (!row) return undefined;
        return toResolvedAsset(await fullReference(row), tenantId);
      }
    },

    previewTemplateVariant: async ({ templateId, beforeVersion, beforeTemplateJson }) => {
      const site = requireSiteId("preview_pdf_template_fixture");
      const receipt = await call("preview_pdf_template_fixture", {
        siteId: site,
        templateId,
        templateJson: beforeTemplateJson,
        fixture: "images",
        version: beforeVersion
      });
      const beforeRef = nonEmptyString(receipt.public_path) ? receipt.public_path : undefined;
      if (!beforeRef) {
        throw new Error(
          `image_revision_preview_before_unavailable: preview_pdf_template_fixture rendered no artifact for "${templateId}" v${beforeVersion} (status ${String(receipt.status)}). ${nonEmptyString(receipt.summary) ? receipt.summary : ""}`.trim()
        );
      }
      return {
        beforeRef,
        afterUnavailable: {
          code: "image_revision_after_preview_unavailable",
          reason: `The AFTER variant of "${templateId}" is not in the template store yet — preview_pdf_template_fixture renders a STORED version (template_id + version) and uses template_json only to derive the fixture, so an unminted edit cannot be rendered from this read-only stage. The before render is real (${beforeRef}); the after evidence is produced at apply, against the version that actually goes live, and reported as pagesWithImage / pagesMissingImage.`
        }
      };
    },

    verifyImagePresence: async ({ templateId, version, pageCount, imageFieldNamePrefix, templateJson }) => {
      const site = requireSiteId("verify_pdf_content");
      const receipt = await call("preview_pdf_template_fixture", {
        siteId: site,
        templateId,
        templateJson,
        fixture: "images",
        version
      });
      const url = nonEmptyString(receipt.public_path) ? receipt.public_path : undefined;
      if (!url) {
        throw new Error(
          `image_revision_verify_render_unavailable: the published "${templateId}" v${version} could not be rendered for inspection (status ${String(receipt.status)}), so its ${imageFieldNamePrefix}* image slots were never checked — nothing is claimed about them. ${nonEmptyString(receipt.summary) ? receipt.summary : ""}`.trim()
        );
      }

      const verdict = await call("verify_pdf_content", { siteId: site, url });
      const status = nonEmptyString(verdict.status) ? verdict.status : "unverified";
      const reportedPageCount = typeof verdict.pageCount === "number" && verdict.pageCount > 0 ? verdict.pageCount : pageCount;
      const allPages = Array.from({ length: Math.max(reportedPageCount, 0) }, (_unused, index) => index + 1);

      if (status === "ok") return { pagesWithImage: allPages, pagesMissingImage: [] };

      if (status !== "failed") {
        // "unverified" NEVER becomes a pass — verify_pdf_content's own contract, and A9's.
        throw new Error(
          `image_revision_verify_unverified: "${templateId}" v${version} rendered to ${url}, but its content could not be inspected (${String(verdict.reason ?? "no reason reported")}), so nothing is known about its ${imageFieldNamePrefix}* slots.`
        );
      }

      const findings = (Array.isArray(verdict.findings) ? verdict.findings : []).filter(isRecord);
      const unresolved = findings.filter((finding) => finding.code === "UNRESOLVED_IMAGE");
      if (unresolved.length === 0) {
        // Failed, but on something other than a missing image (a blank page, a leaked token). Not
        // this seam's question, and certainly not a pass.
        throw new Error(
          `image_revision_verify_content_failed: "${templateId}" v${version} failed content inspection for a reason other than a missing image: ${String(verdict.reason ?? "no reason reported")}`
        );
      }
      const pagesMissingImage = unresolved.map((finding) => finding.page).filter((page): page is number => typeof page === "number" && Number.isInteger(page) && page > 0);
      if (pagesMissingImage.length !== unresolved.length) {
        throw new Error(
          `verify_page_granularity_unavailable: "${templateId}" v${version} reported ${unresolved.length} unresolved image finding(s) and only ${pagesMissingImage.length} of them named a page, so this run cannot say WHICH pages are missing the ${imageFieldNamePrefix}* image. Reported as a gap rather than a guessed page list. Verdict: ${String(verdict.reason ?? "")}`.trim()
        );
      }
      const missing = new Set(pagesMissingImage);
      return { pagesWithImage: allPages.filter((page) => !missing.has(page)), pagesMissingImage: [...missing].sort((a, b) => a - b) };
    }
  };
}
