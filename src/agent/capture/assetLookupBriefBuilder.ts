// A5 (runner 3c) — the CONSTRUCTOR for asset_lookup_adopt, same shape as A7's and A8's: the
// operation's dispatched input is flat (tenantId, query, assetKind?, maxResults?, adoptInto? —
// descriptors/assetLookupAdopt.ts) while asset_lookup_studio's entry node reads ONE nested
// `initialInput.assetLookupBrief`. A rename table cannot nest, so the binding carries an empty
// inputMapping and this builder does the whole translation.
//
// `adoptInto` is OPTIONAL on the descriptor, and deliberately so: the operation's own completion
// criterion is about resolving and adopting exactly one asset, but a dispatch that names no target
// object is a legitimate SEARCH — it runs, resolves (or refuses to pick), and reports
// asset_adopt_target_unspecified without writing. A builder that invented a target would be the one
// place this operation could write somewhere nobody named.

export const ASSET_LOOKUP_BRIEF_BUILDER_ID = "asset_lookup_adopt_brief_builder.v1";
export const ASSET_LOOKUP_BRIEF_KEY = "assetLookupBrief";
export const ASSET_LOOKUP_BRIEF_REQUIRED_OPERATION_FIELDS = ["tenantId", "query"] as const;

export type AssetLookupDispatchBrief = {
  tenantId: string;
  query: string;
  assetKind?: string;
  maxResults?: number;
  adoptInto?: { objectType: string; objectId: string; tenantId: string; nodeId?: string };
};

export type AssetLookupBriefBuildResult =
  | { ok: true; tenantId: string; brief: AssetLookupDispatchBrief }
  | { ok: false; code: string; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Pure: no clock, no store, no network, no model. */
export function buildAssetLookupBrief(input: unknown): AssetLookupBriefBuildResult {
  const source = isRecord(input) ? input : {};
  const refuse = (code: string, reason: string): AssetLookupBriefBuildResult => ({ ok: false, code, reason });

  const tenantId = nonEmptyString(source.tenantId) ? source.tenantId.trim() : undefined;
  if (!tenantId) {
    return refuse("asset_lookup_brief_tenant_missing", "asset_lookup_adopt was dispatched with no tenantId; the artifact search and every write it can perform are tenant-scoped, so a brief cannot be built without one.");
  }
  const query = nonEmptyString(source.query) ? source.query.trim() : undefined;
  if (!query) {
    return refuse("asset_lookup_brief_query_missing", "asset_lookup_adopt was dispatched with no query; an empty search is never run, and it is certainly not a search for everything.");
  }
  if (source.assetKind !== undefined && !nonEmptyString(source.assetKind)) {
    return refuse("asset_lookup_brief_asset_kind_invalid", `assetKind, when supplied, must be a non-empty string; received ${JSON.stringify(source.assetKind)}.`);
  }
  if (source.maxResults !== undefined && (typeof source.maxResults !== "number" || !Number.isInteger(source.maxResults) || source.maxResults < 1)) {
    return refuse("asset_lookup_brief_max_results_invalid", `maxResults, when supplied, must be a positive integer; received ${JSON.stringify(source.maxResults)}.`);
  }

  const brief: AssetLookupDispatchBrief = { tenantId, query };
  if (nonEmptyString(source.assetKind)) brief.assetKind = source.assetKind.trim();
  if (typeof source.maxResults === "number") brief.maxResults = source.maxResults;

  if (source.adoptInto !== undefined) {
    const target = isRecord(source.adoptInto) ? source.adoptInto : undefined;
    if (!target) return refuse("asset_lookup_brief_adopt_target_invalid", `adoptInto, when supplied, must be an object naming the document to record the asset on; received ${JSON.stringify(source.adoptInto)}.`);
    const objectType = nonEmptyString(target.objectType) ? target.objectType.trim() : undefined;
    const objectId = nonEmptyString(target.objectId) ? target.objectId.trim() : undefined;
    const targetTenantId = nonEmptyString(target.tenantId) ? target.tenantId.trim() : undefined;
    if (!objectType || !objectId || !targetTenantId) {
      return refuse("asset_lookup_brief_adopt_target_incomplete", `adoptInto needs objectType, objectId and tenantId; received ${JSON.stringify(source.adoptInto)}. Never completed from the operation's own tenantId — an object this run cannot fully name is an object it does not write to.`);
    }
    if (targetTenantId !== tenantId) {
      return refuse("asset_lookup_brief_adopt_target_cross_tenant", `adoptInto names tenant "${targetTenantId}" but the operation is scoped to "${tenantId}". An asset is never adopted across tenant bounds.`);
    }
    brief.adoptInto = { objectType, objectId, tenantId: targetTenantId, ...(nonEmptyString(target.nodeId) ? { nodeId: target.nodeId.trim() } : {}) };
  }

  return { ok: true, tenantId, brief };
}
