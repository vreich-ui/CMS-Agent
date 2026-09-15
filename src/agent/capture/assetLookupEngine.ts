// A5 (Milestone A remainder, runner 3c) — asset_lookup_adopt: find ONE existing asset and adopt its
// reference into a content object. Two deterministic stages, zero model calls.
//
//   asset_lookup_search — read-only. Searches the tenant's artifact plane, confirms the single
//                         candidate through get_artifact_metadata, and RESOLVES nothing when the
//                         answer is not exactly one: the operation's own completion criterion
//                         ("exactly one asset reference was resolved") is not a preference, so a
//                         multi-match stops at a named `asset_ambiguous` outcome and never picks.
//   asset_lookup_adopt  — the governed write, riskLevel "write": object_checkout -> object_patch ->
//                         object_checkin, with the lease released in a `finally`, reusing
//                         callProjectTool exactly as cloneEngine.ts's own restamp loop does. No new
//                         write path is built here.
//
// WHAT THE PLATFORM CAN AND CANNOT ANSWER, named rather than papered over:
//   * `query` is matched as a TAG. Platform's search_artifacts is explicitly "prefix indexes, not
//     full text search" — its only content filter is `tag` — so a free-text query is used as the tag
//     it can actually be, and a miss reports platform's own `outcome`/`remedy` (unknown_tag vs
//     no_tags_recorded_for_tenant) verbatim rather than a generic "nothing found".
//   * `assetKind` — the descriptor's three kinds (capture_artifact / stored_media /
//     content_linked_asset) have no counterpart on the artifact plane, which classifies by
//     artifactKind (image/pdf/video/audio/document) and by tag. `stored_media` maps honestly onto
//     the media artifactKinds; the other two do not map onto anything a reference states (nothing in
//     an ArtifactReference says "this came from a capture run" or "this is linked from content"), so
//     they are refused BY NAME rather than silently ignored or approximated. A filter that cannot be
//     applied must never come back as an unfiltered search wearing the filter's name.
//   * Adoption targets an EXISTING node the caller names (`update_node`). This operation never
//     invents a node in someone's article: a body this run does not understand is not a body it
//     restructures. An adoptInto without a nodeId is refused by name.
import { callProjectTool, CloneRefusal, type CloneDeps } from "./cloneEngine.js";
import { imagePublicPath } from "./imageTemplateRevisionPlatformProviders.js";

export const ASSET_LOOKUP_ARTIFACTS = {
  search: "asset_lookup.search.v1",
  adopt: "asset_lookup.adopt.v1"
} as const;

// artifactKind values that ARE media, for the one descriptor assetKind that maps onto something a
// reference actually states.
const MEDIA_ARTIFACT_KINDS = new Set(["image", "video", "audio"]);

export type AssetLookupTarget = { objectType: string; objectId: string; tenantId: string; nodeId?: string };

export type AssetLookupBrief = {
  tenantId: string;
  query: string;
  assetKind?: string;
  maxResults?: number;
  adoptInto?: AssetLookupTarget;
};

export type ResolvedAssetView = {
  sha256: string;
  blobKey: string;
  publicPath: string | null;
  contentType: string | null;
  artifactKind: string | null;
  sizeBytes: number | null;
  tags: string[];
  createdAtISO: string | null;
};

export type AssetLookupSearchEnvelope = {
  artifact: typeof ASSET_LOOKUP_ARTIFACTS.search;
  summary: string;
  query: string;
  assetKind: string | null;
  outcome: "resolved" | "none_found" | "ambiguous";
  resolved: ResolvedAssetView | null;
  candidates: ResolvedAssetView[];
  /** Platform's own outcome/remedy for a tag miss, verbatim — "this tag is a typo" and "this tenant
   *  has never tagged anything" are different answers and are reported as different answers. */
  searchPlaneOutcome: { outcome: string | null; remedy: string | null };
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const toAssetView = (reference: Record<string, unknown>): ResolvedAssetView => ({
  sha256: nonEmptyString(reference.sha256) ? reference.sha256.toLowerCase() : "",
  blobKey: nonEmptyString(reference.blobKey) ? reference.blobKey : "",
  publicPath: imagePublicPath(reference.blobKey) ?? null,
  contentType: nonEmptyString(reference.contentType) ? reference.contentType : null,
  artifactKind: nonEmptyString(reference.artifactKind) ? reference.artifactKind : null,
  sizeBytes: typeof reference.sizeBytes === "number" ? reference.sizeBytes : null,
  tags: Array.isArray(reference.tags) ? reference.tags.filter(nonEmptyString) : [],
  createdAtISO: nonEmptyString(reference.createdAtISO) ? reference.createdAtISO : null
});

/** Stage 1 — READ ONLY. Never writes, never picks between candidates. */
export async function assetLookupSearchStep(
  input: { targetProjectId: string; brief: AssetLookupBrief },
  deps: CloneDeps = {}
): Promise<AssetLookupSearchEnvelope> {
  const { brief } = input;
  const query = nonEmptyString(brief.query) ? brief.query.trim() : "";
  if (!query) {
    throw new CloneRefusal("asset_lookup_query_missing", "asset_lookup_adopt needs a query; a search with no query is never run, and an empty one is not 'everything'.");
  }
  const assetKind = nonEmptyString(brief.assetKind) ? brief.assetKind.trim() : null;
  if (assetKind && assetKind !== "stored_media") {
    throw new CloneRefusal(
      "asset_kind_filter_unsupported",
      `assetKind "${assetKind}" cannot be applied on this tenant's artifact plane: platform's artifact index classifies references by artifactKind (image, pdf, video, audio, document) and by tag, and nothing an ArtifactReference states says whether an artifact came from a capture run or is linked from content. The search was NOT run unfiltered in its place — an unapplied filter must never come back wearing the filter's name. Re-run with assetKind "stored_media", or with no assetKind at all.`
    );
  }

  const limit = typeof brief.maxResults === "number" && brief.maxResults > 0 ? Math.min(Math.floor(brief.maxResults), 100) : 20;
  const result = await callProjectTool(input.targetProjectId, "search_artifacts", { tag: query, limit }, deps);
  const rows = (Array.isArray(result.artifacts) ? result.artifacts : []).filter(isRecord);
  const searchPlaneOutcome = {
    outcome: nonEmptyString(result.outcome) ? result.outcome : null,
    remedy: nonEmptyString(result.remedy) ? result.remedy : null
  };

  const filtered = assetKind === "stored_media" ? rows.filter((row) => nonEmptyString(row.artifactKind) && MEDIA_ARTIFACT_KINDS.has(row.artifactKind)) : rows;
  const candidates = filtered.map(toAssetView);

  if (candidates.length === 0) {
    return {
      artifact: ASSET_LOOKUP_ARTIFACTS.search,
      summary: `No asset tagged "${query}" on "${brief.tenantId}"${assetKind ? ` with assetKind ${assetKind}` : ""}. ${searchPlaneOutcome.remedy ?? "Platform's artifact search matches tags, not free text."}`,
      query,
      assetKind,
      outcome: "none_found",
      resolved: null,
      candidates: [],
      searchPlaneOutcome
    };
  }

  if (candidates.length > 1) {
    return {
      artifact: ASSET_LOOKUP_ARTIFACTS.search,
      summary: `${candidates.length} assets are tagged "${query}" on "${brief.tenantId}"; this operation adopts exactly one and never picks. Narrow the tag, or name the asset by checksum.`,
      query,
      assetKind,
      outcome: "ambiguous",
      resolved: null,
      candidates,
      searchPlaneOutcome
    };
  }

  // Exactly one. Read the FULL reference before calling it resolved: the listing is a projection,
  // and get_artifact_metadata is the one call that also reveals a soft-deleted reference.
  const only = filtered[0];
  const requestId = nonEmptyString(only.blobKey) ? only.blobKey.split("/")[1] : undefined;
  const sha256 = nonEmptyString(only.sha256) ? only.sha256.toLowerCase() : undefined;
  let full: Record<string, unknown> = only;
  if (requestId && sha256) {
    const metadata = await callProjectTool(input.targetProjectId, "get_artifact_metadata", { requestId, sha256 }, deps);
    full = { ...only, ...(isRecord(metadata.artifact) ? (metadata.artifact as Record<string, unknown>) : metadata) };
  }
  if (nonEmptyString(full.deletedAtISO)) {
    throw new CloneRefusal(
      "asset_soft_deleted",
      `The one asset tagged "${query}" on "${brief.tenantId}" carries deletedAtISO ${String(full.deletedAtISO)}. A soft-deleted reference is excluded from listing, trust checks and publish, so it is never adopted into a live document. Restore it first, or tag another asset.`
    );
  }

  const resolved = toAssetView(full);
  return {
    artifact: ASSET_LOOKUP_ARTIFACTS.search,
    summary: `Resolved exactly one asset tagged "${query}" on "${brief.tenantId}": ${resolved.sha256.slice(0, 12)} (${resolved.contentType ?? "unknown type"}).`,
    query,
    assetKind,
    outcome: "resolved",
    resolved,
    candidates,
    searchPlaneOutcome
  };
}

export type AssetLookupAdoptEnvelope = {
  artifact: typeof ASSET_LOOKUP_ARTIFACTS.adopt;
  summary: string;
  outcome: "adopted" | "not_adopted";
  /** The operation's ONE completion criterion: exactly one asset resolved AND adopted. */
  assetResolved: boolean;
  adopted: { objectType: string; objectId: string; nodeId: string; src: string } | null;
  blocked: { code: string; reason: string } | null;
};

/**
 * Stage 2 — THE GOVERNED WRITE. checkout -> patch -> checkin, lease released in `finally`, exactly
 * as cloneEngine.ts's restamp loop does it; nothing new is built here.
 *
 * A search that did not resolve exactly one asset reaches this stage as a NAMED non-adoption, never
 * a write: this is the one place the "never pick" rule would be broken if it were going to be.
 */
export async function assetLookupAdoptStep(
  input: { targetProjectId: string; search: AssetLookupSearchEnvelope; brief: AssetLookupBrief },
  deps: CloneDeps = {}
): Promise<AssetLookupAdoptEnvelope> {
  const notAdopted = (code: string, reason: string): AssetLookupAdoptEnvelope => ({
    artifact: ASSET_LOOKUP_ARTIFACTS.adopt,
    summary: `${code}: ${reason}`,
    outcome: "not_adopted",
    assetResolved: false,
    adopted: null,
    blocked: { code, reason }
  });

  const { search, brief } = input;
  if (search.outcome !== "resolved" || !search.resolved) {
    return notAdopted(
      search.outcome === "ambiguous" ? "asset_ambiguous" : "asset_not_found",
      search.outcome === "ambiguous"
        ? `${search.candidates.length} assets match "${search.query}"; this operation's completion demands exactly one resolved asset, so nothing was adopted and nothing was chosen on your behalf.`
        : `No asset matched "${search.query}", so there was nothing to adopt. ${search.searchPlaneOutcome.remedy ?? ""}`.trim()
    );
  }

  const target = brief.adoptInto;
  if (!target) {
    return notAdopted(
      "asset_adopt_target_unspecified",
      `An asset was resolved (${search.resolved.sha256.slice(0, 12)}) but this run named no object to adopt it into, so nothing was written. Dispatch again with adoptInto {objectType, objectId, tenantId, nodeId} to record the association.`
    );
  }
  if (target.tenantId !== brief.tenantId) {
    return notAdopted(
      "asset_adopt_target_cross_tenant",
      `adoptInto names tenant "${target.tenantId}" but this run is scoped to "${brief.tenantId}". An asset is never adopted across tenant bounds.`
    );
  }
  if (!nonEmptyString(target.nodeId)) {
    return notAdopted(
      "asset_adopt_target_node_unspecified",
      `adoptInto names ${target.objectType} "${target.objectId}" but no nodeId. This operation records an asset on an EXISTING node (update_node); it never invents a node in someone's document. Name the node the asset belongs to.`
    );
  }
  const src = search.resolved.publicPath;
  if (!src) {
    return notAdopted(
      "asset_not_addressable",
      `Asset ${search.resolved.sha256.slice(0, 12)} has blobKey "${search.resolved.blobKey}", which is not addressable as the /img/<requestId>/<sha256>.<ext> public path a document's media src must take. Nothing was written.`
    );
  }

  let lockToken: string | undefined;
  try {
    const checkout = await callProjectTool(input.targetProjectId, "object_checkout", { objectType: target.objectType, objectId: target.objectId }, deps);
    // Assigned as the very next statement after the wire call returns, from the canonical field
    // fromWireResult guarantees — the T13.4 lock-leak discipline, unchanged.
    lockToken = checkout.lockToken as string;
    const recordVersion = checkout.recordVersion as string | number | undefined;
    await callProjectTool(
      input.targetProjectId,
      "object_patch",
      {
        objectType: target.objectType,
        objectId: target.objectId,
        lockToken,
        expectedRecordVersion: recordVersion,
        // `media.type` is deliberately NOT set: platform's own patch engine infers it from the src
        // and REFUSES a type that disagrees with it (normalizeArticleNodeMediaFields). Declaring it
        // here would be this module guessing at a fact platform derives correctly.
        ops: [{ op: "update_node", node_id: target.nodeId, fields: { public: { media: { src } } } }]
      },
      deps
    );
    return {
      artifact: ASSET_LOOKUP_ARTIFACTS.adopt,
      summary: `Adopted asset ${search.resolved.sha256.slice(0, 12)} onto ${target.objectType} "${target.objectId}" node "${target.nodeId}" (${src}).`,
      outcome: "adopted",
      assetResolved: true,
      adopted: { objectType: target.objectType, objectId: target.objectId, nodeId: target.nodeId, src },
      blocked: null
    };
  } finally {
    if (lockToken) {
      try {
        await callProjectTool(input.targetProjectId, "object_checkin", { objectType: target.objectType, objectId: target.objectId, lockToken }, deps);
      } catch { /* best-effort; the lease expires naturally */ }
    }
  }
}
