// Versioned site snapshot + read-only contract bundle (A4). THIS MODULE IS A CONTRACT AND A CACHE,
// NOT AN ADAPTER: it defines the shape of a point-in-time, immutable view of a tenant's object
// inventory and object contracts (SiteSnapshot), the narrow read-only port a later task binds to the
// real tenant APIs (SiteContextSource), and a bounded cache keyed on that view's identity. Nothing
// here calls a tenant, mutates the workspace, or grants authority — see operationTypes.ts's header
// for the same discipline this whole kernel shares.
//
// WHAT SiteContextSource IS EXPECTED TO BIND TO, LATER, AND BY WHOM: A6's executor
// (visualIdentityReviewChangeExecutor.ts) consumes this port entirely through dependency injection
// and still does not implement a live adapter — the real binding needs the SAME tenant read calls
// sitePrefetch.ts and contractPrefetch.ts already make deterministically (object_list,
// object_contract, and — for registry-shaped reference data that is not itself a typed content
// object, e.g. visual_standard listings, published PDF templates, image model policy contexts — the
// tenant's registry_get tool), which is Platform-side wiring out of this task's scope; see A6's
// report for the precise adapter shape a follow-up task should build.
// DECIDED (coordinator, A6): getRevisionId returns null, always. No tenant in this codebase exposes
// a single "site revision" stamp, and none is being added — the SNAPSHOT'S OWN CONTENT DIGEST is the
// authoritative staleness key, not a revision label. This is why every SiteContextObject below
// carries the tenant's own `version` / `content_revision` fields verbatim (object_list's own wire
// shape) rather than just `fields`: those two counters are part of the digest input precisely so an
// object bumped elsewhere — by another run, another operator, another operation — invalidates a
// change set (changeSet.ts's isChangeSetStale) even though nobody here ever reads a revision stamp.
// Every cache lookup already falls back to the content digest when the source reports no revision
// (see getSiteSnapshot below), so a real adapter that always returns null needs no special-casing
// anywhere in this module — it already IS the only path this module exercises.
import { contentDigest } from "./contentHash.js";

// One object's current, tenant-side state as this snapshot saw it. Field names mirror the tenant's
// own wire vocabulary (version / content_revision / published_time, e.g. a live house visual
// standard reads version: 4, content_revision: 2, published_time: null — saved, never applied) so a
// reader of this type recognizes the same object a support investigation would.
export type SiteContextObject = {
  objectId: string;
  objectType: string;
  status: string;
  version: number;
  contentRevision: number;
  publishedTime: string | null;
  updatedAt: string;
  // The object's current field values, keyed identically to a candidate's `fields` (candidates.ts)
  // and to this object type's own contract schema (below) — this is what changeSet.ts diffs a
  // candidate against.
  fields: Record<string, unknown>;
};

// The object contract for one object type, as the tenant's own object_contract enforces it — a
// JSON-schema-shaped description candidates.ts validates a caller's proposed fields against, never a
// hand-written shape maintained separately from what the tenant actually accepts.
export type SiteObjectFieldContract = {
  objectType: string;
  // A convenience mirror of `schema.required` (validateOutput/candidates.ts reads the required list
  // straight out of `schema` itself, the same way operationPreflight.ts already does for an
  // operation's inputSchema) — kept here so a caller that wants "what fields does this object type
  // require" does not have to parse it back out of a JSON schema. Whoever authors a contract (the
  // in-memory fixture today; a real reducer later) is responsible for keeping the two in sync.
  required: string[];
  schema: Record<string, unknown>;
  // The tenant's registered component-type vocabulary, when this contract carries one — object_contract's
  // own TOP-LEVEL `section_types` array (a sibling of `body_schema`, never a path inside it; verified
  // live on both `page` and `section`, 2026-09-18 — see siteContentObjectCompiler.ts's own header for
  // the full finding). Present on the real `page` AND `section` contracts alike (the same registry
  // backs both). undefined when a contract carries no such registry (e.g. a non-section-bearing object
  // type, or a synthetic contract a test built without one) — a caller that needs the component
  // registry treats undefined/empty exactly like "unavailable", never an empty allow-list.
  sectionTypes?: readonly string[];
  // THE REGISTRY GATE (C2). The same top-level `section_types` array, kept STRUCTURED rather than
  // flattened to names — `component_bound` and `footprint` are what decide whether a type may be
  // PLACED on a page at all, and a name list cannot express that. Read live from
  // `object_contract("page")` on 2026-09-18: 28 entries, of which exactly two (`card`, `shared_ref`)
  // carry `component_bound: false` / `footprint: null`. `before_after` is present and
  // `component_bound: true`, region `flow` — it needs no capability gate of its own, and gating it on
  // a tenant snapshot produces false `unsupported_section_type` refusals.
  //
  // The PAGE contract's copy is the authority for placement, because placement law (`page_types`,
  // below) lives on the page contract too. The `section` contract carries an identical registry, but
  // a standalone `section` body is `{section, tracking}` — NOT a `{sectionType, data}` record — so it
  // is not the contract a page's inline sections are validated against.
  sectionRegistry?: readonly SectionTypeRegistryEntry[];
  // `object_contract("page").page_types` — PageType law. Six entries live on 2026-09-18; four of them
  // restrict which section types may appear. undefined when a contract carries no page-type law (a
  // non-page object type, or a synthetic contract a test built without one).
  pageTypes?: readonly PageTypeRule[];
};

// One entry of the live top-level `section_types` registry, normalized to this repo's camelCase.
// `dataSchema` is that type's own `data_schema` — the JSON schema a page's inline section `data` must
// satisfy (the live `schema_zod` constraint is strict: unknown keys are rejected).
export type SectionTypeRegistryEntry = {
  type: string;
  componentBound: boolean;
  footprint: Record<string, unknown> | null;
  dataSchema?: Record<string, unknown>;
};

// One entry of the live top-level `page_types` law. `allowedSections` is the literal string "any"
// when that page type places no restriction (the live `clone` and `standard` types), never an empty
// array — an empty array would mean "nothing may be placed", the opposite of "any".
export type PageTypeRule = {
  id: string;
  routePattern: string;
  allowedSections: readonly string[] | "any";
  requiredSections: readonly string[];
};

// Registry-shaped reference data that is not itself a typed content object — see the module header
// for which tenant read(s) this is expected to bind to.
export type SiteRegistries = {
  visualStandards: ReadonlyArray<{ id: string; kind: string; label?: string }>;
  pdfTemplates: ReadonlyArray<{ templateId: string; kind?: string; label?: string; isDefault?: boolean }>;
  imagePolicyContexts: ReadonlyArray<string>;
};

// The narrow read-only port a snapshot needs. Every method is a pure read: no method here writes,
// and no method takes a mutation payload. A later task supplies the real implementation; this task
// supplies only the interface and an in-memory fixture (tests/agent/operations/fixtures) for tests.
export type SiteContextSource = {
  listObjects(params: { tenantId: string; objectType: string }): Promise<readonly SiteContextObject[]>;
  getObjectContract(params: { tenantId: string; objectType: string }): Promise<SiteObjectFieldContract | null>;
  getRegistries(params: { tenantId: string }): Promise<SiteRegistries>;
  // null when the source has no revision concept for this tenant (see module header) — the snapshot
  // still gets a stable identity via its content digest.
  getRevisionId(params: { tenantId: string }): Promise<string | null>;
};

export type SiteSnapshot = {
  tenantId: string;
  // null exactly when the source's getRevisionId returned null for this capture.
  revisionId: string | null;
  digest: string;
  capturedAtISO: string;
  objects: { byType: Record<string, readonly SiteContextObject[]> };
  contracts: { byType: Record<string, SiteObjectFieldContract> };
  registries: SiteRegistries;
};

// The content this snapshot's digest is computed over — deliberately EXCLUDES capturedAtISO (a
// clock read) and revisionId (a label the source attaches, not content) so two captures of
// identical tenant content hash identically regardless of when they ran or what the source called
// that moment.
type SiteSnapshotDigestInput = {
  tenantId: string;
  objects: Record<string, readonly SiteContextObject[]>;
  contracts: Record<string, SiteObjectFieldContract>;
  registries: SiteRegistries;
};

const computeSiteSnapshotDigest = (input: SiteSnapshotDigestInput): string => contentDigest(input);

export type CaptureSiteSnapshotParams = { tenantId: string; objectTypes: string[] };
export type CaptureSiteSnapshotDeps = { now?: () => string };

// Reads every object type requested (sorted, so two calls with the same set in different order
// still capture identically) plus the tenant's registries, then assembles the immutable snapshot.
// Never cached itself — see getSiteSnapshot below for the cached entry point a caller should
// normally use instead of calling this directly.
export async function captureSiteSnapshot(
  source: SiteContextSource,
  params: CaptureSiteSnapshotParams,
  deps: CaptureSiteSnapshotDeps = {}
): Promise<SiteSnapshot> {
  const now = deps.now ?? (() => new Date().toISOString());
  const objectTypes = [...new Set(params.objectTypes)].sort();

  const objects: Record<string, readonly SiteContextObject[]> = {};
  const contracts: Record<string, SiteObjectFieldContract> = {};
  for (const objectType of objectTypes) {
    objects[objectType] = await source.listObjects({ tenantId: params.tenantId, objectType });
    const contract = await source.getObjectContract({ tenantId: params.tenantId, objectType });
    if (contract) contracts[objectType] = contract;
  }
  const registries = await source.getRegistries({ tenantId: params.tenantId });
  const revisionId = await source.getRevisionId({ tenantId: params.tenantId });

  const digest = computeSiteSnapshotDigest({ tenantId: params.tenantId, objects, contracts, registries });
  return {
    tenantId: params.tenantId,
    revisionId,
    digest,
    capturedAtISO: now(),
    objects: { byType: objects },
    contracts: { byType: contracts },
    registries
  };
}

// A small bounded cache keyed on a snapshot's identity: `${tenantId}:${revisionId}` when the source
// reports one, else `${tenantId}:${digest}` (assigned once the content is known). Bounded so a
// long-lived process (Cloud Run) cannot grow this without limit — eviction is plain LRU (oldest
// unused entry dropped first), enough for "don't refetch the last handful of tenants/revisions this
// process touched", not a durable store.
export class SiteSnapshotCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, SiteSnapshot>();

  constructor(maxEntries = DEFAULT_SITE_SNAPSHOT_CACHE_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error(`SiteSnapshotCache maxEntries must be a positive integer; got ${maxEntries}`);
    this.maxEntries = maxEntries;
  }

  get(key: string): SiteSnapshot | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      // Refresh recency: delete + re-set moves this key to the end of Map's iteration order, which
      // is what makes "oldest" (the first key) mean "least recently used" rather than merely
      // "least recently inserted".
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: SiteSnapshot): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const DEFAULT_SITE_SNAPSHOT_CACHE_MAX_ENTRIES = 50;

// A process-wide default, mirroring conductor.ts's conductorCache convention (a shared instance for
// production callers that don't need their own). Tests construct their own SiteSnapshotCache so a
// small maxEntries can be asserted against without disturbing this one.
export const defaultSiteSnapshotCache = new SiteSnapshotCache();

const revisionCacheKey = (tenantId: string, revisionId: string): string => `${tenantId}:rev:${revisionId}`;
const digestCacheKey = (tenantId: string, digest: string): string => `${tenantId}:digest:${digest}`;

export type GetSiteSnapshotDeps = CaptureSiteSnapshotDeps & { cache?: SiteSnapshotCache };

// The cached entry point. When the source reports a revisionId for this tenant, a cache hit on
// `tenantId:rev:<revisionId>` skips EVERY read below it (listObjects/getObjectContract/getRegistries
// never run) — this is the real savings case, and what "cache by tenantId + revisionId" buys. When
// the source reports no revision, there is no way to know before reading whether the content has
// changed, so the read always runs; the result is still stored under its own digest afterward, so a
// caller that already holds a SiteSnapshot and wants to confirm "is this the one this process has
// cached" can look it up by digest without recapturing.
export async function getSiteSnapshot(
  source: SiteContextSource,
  params: CaptureSiteSnapshotParams,
  deps: GetSiteSnapshotDeps = {}
): Promise<SiteSnapshot> {
  const cache = deps.cache ?? defaultSiteSnapshotCache;

  const revisionId = await source.getRevisionId({ tenantId: params.tenantId });
  if (revisionId !== null) {
    const cached = cache.get(revisionCacheKey(params.tenantId, revisionId));
    if (cached) return cached;
  }

  const snapshot = await captureSiteSnapshot(source, params, deps);
  if (snapshot.revisionId !== null) cache.set(revisionCacheKey(params.tenantId, snapshot.revisionId), snapshot);
  cache.set(digestCacheKey(params.tenantId, snapshot.digest), snapshot);
  return snapshot;
}

// True when `snapshot` still matches its own claimed digest — i.e. it was not hand-assembled or
// mutated after capture. Exported for tests and for a later executor to sanity-check a snapshot it
// did not itself capture; captureSiteSnapshot/getSiteSnapshot always return a snapshot that passes
// this by construction.
export function isSnapshotDigestValid(snapshot: SiteSnapshot): boolean {
  const expected = computeSiteSnapshotDigest({
    tenantId: snapshot.tenantId,
    objects: snapshot.objects.byType,
    contracts: snapshot.contracts.byType,
    registries: snapshot.registries
  });
  return expected === snapshot.digest;
}
