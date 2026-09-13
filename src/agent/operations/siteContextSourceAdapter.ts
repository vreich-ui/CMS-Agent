// Production SiteContextSource adapter (A4). Binds the read-only port siteContext.ts declares
// (`SiteContextSource`) to a REAL tenant, closing the gap that module's own header names: "the real
// binding needs the SAME tenant read calls sitePrefetch.ts and contractPrefetch.ts already make
// deterministically (object_list, object_contract, and — for registry-shaped reference data — the
// tenant's registry_get tool)". This module is that binding, and every one of its three read paths
// goes through the SAME audited "one door" those two files already use — `tenantAdapterFor` (engine
// caller) → `ProjectMcpAdapter.callReadTool` — never a second, hand-rolled transport.
//
// READS ONLY, BY CONSTRUCTION. This file imports exactly one thing capable of reaching a tenant at
// all: `tenantAdapterFor` from tools/tenantInvoke.ts, and calls only its `.callReadTool(...)` method
// — never `.callTool(...)`. `TenantAdapter.callReadTool` is itself backed by
// `ProjectMcpAdapter.callReadTool`, which refuses (`read_tool_operation_not_permitted`, BEFORE any
// transport) any tool name outside its own fixed, server-side `READ_TOOL_ALLOWLIST`
// (projectMcpAdapter.ts) — a list that contains no write or publish verb and cannot be widened by an
// argument this module passes. So even a caller who tampered with the tool-name string this module
// builds could not reach a write through it. siteContextSourceAdapter.test.ts proves this
// structurally, not just by inspection: a tenant double whose write-shaped methods throw records
// ZERO calls across a full snapshot capture (listObjects + getObjectContract + getRegistries +
// getRevisionId, exactly the four calls captureSiteSnapshot makes).
//
// WHICH TENANT VERB BACKS listObjects, AND WHY NOT THE GENERIC "object_list" THE HEADER NAMES.
// siteContext.ts's own header names `object_list` as the generic pattern sitePrefetch.ts already
// uses for ONE particular listing (visual_standard, for A6's narrower flow). This operation is
// `site_inventory`, and capabilityReadiness.ts's own REQUIREMENTS table — the ALREADY-SHIPPED,
// load-bearing evidence for this exact operation's `site_inventory_read` capability — ties that
// capability to a DIFFERENT, more specific tool: `object_inventory` ("it is the inventory read
// site_inventory's own descriptor (siteInventory.ts) describes" — capabilityReadiness.ts's own
// comment). Preflight's capability gate (operationPreflight.ts) checks whether a tenant's project
// record allows `object_inventory`; if this adapter called `object_list` instead, a tenant preflight
// reported as "ready" could still fail at execute time against a tenant that allows one verb but not
// the other — exactly the trusted-facts-vs-runtime-reality gap R1/this task's own instructions call
// out. So `listObjects` below calls `object_inventory`, matching the capability evidence this
// operation was ALREADY shipped against, not the header's more generic example. `object_inventory`
// is in `READ_TOOL_ALLOWLIST` (projectMcpAdapter.ts) exactly like `object_list` is.
//
// object_inventory IN LIST MODE (no `object_id`, per its own real schema —
// platformToolSchemas.ts — `object_id` present would switch it to a single-object DETAIL view) is
// documented (docs/projects/dr-lurie-agent-publishing-policy.md §10.1) to return SUMMARY rows:
// `object_id, version, content_revision, review_state, lock{...}, published_time,
// unpublished_changes` — never each object's full field body. `SiteContextObject.fields` is
// therefore always `{}` for a snapshot this adapter captures: an honest reflection of what a bulk
// inventory read actually returns, never a fabricated body. A caller that needs one object's real
// field values reads it directly (object_get), which is a different read this module does not
// perform — site_inventory's own descriptor scope is "what exists, its type and status", not field
// content.
//
// getRevisionId ALWAYS RETURNS null. siteContext.ts's own header records the coordinator's decision
// (A6, restated there for whoever built this adapter): no tenant in this codebase exposes a single
// "site revision" stamp, and none is added here — the snapshot's own content digest is the staleness
// key. This adapter does not probe for one, and does not invent one from object_inventory's own
// version/content_revision counters (those already travel on every SiteContextObject and feed the
// digest directly — a second "revision" derived from them here would just be a worse copy of the
// digest).
//
// REGISTRY-SHAPED REFERENCE DATA (getRegistries) — WHAT IS, AND IS NOT, CONFIRMED. The only
// `registry_get` registry names ANY captured live schema in this repository names are "component"
// and "page_type" (tests/agent/capture/fixtures/platformToolSchemas.ts, captured 2026-08-24 from a
// real connected tenant) — used by cloneEngine.ts for a wholly different purpose (component/page-type
// definitions during a clone). No captured schema anywhere in this repository confirms a registry
// name for visual-standard listings, published PDF templates, or image-model-policy contexts; the
// three names below (`visual_standard`, `pdf_template`, `image_policy_context`) are this adapter's
// best-effort request, following siteContext.ts's own header instruction to bind SiteRegistries to
// registry_get rather than a confirmed wire contract. Unlike listObjects/getObjectContract (which
// throw a structured error on a real read failure — see below), a registry_get call for one of these
// three names that fails, is blocked, or returns nothing recognizable degrades to an EMPTY list for
// THAT ONE registry rather than throwing: SiteRegistries carries no per-field warning channel a
// caller could read a distinction from, and treating an unrecognized/absent registry as "empty" for
// this reference data (never fatal) mirrors sitePrefetch.ts's own "never a hard failure" posture for
// this identical class of data. A future task with real evidence of the platform's registry_get
// vocabulary for these three should replace the NAMES below, not the shape of this function.
//
// A REAL TENANT READ FAILURE SURFACES STRUCTURALLY, NEVER AS A SILENT EMPTY SNAPSHOT. listObjects and
// getObjectContract are the two reads a caller actually depends on for correctness (an empty result
// from either looks EXACTLY like "this tenant genuinely has none" to every downstream consumer —
// candidates.ts, changeSet.ts, and this task's own site_inventory executor). So a call that comes
// back `ok:false` (blocked by policy, unreachable, timed out, denied) THROWS a typed
// `SiteContextSourceReadError` naming the tool, the tenant and the object type, rather than returning
// `[]`/`null` — captureSiteSnapshot (siteContext.ts) does not catch it, so the whole capture rejects
// and the caller (the site_inventory executor) sees a real failure, never a snapshot that quietly
// claims a tenant has nothing.
import { tenantAdapterFor, type TenantCallContext } from "../tools/tenantInvoke.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import type { SiteContextObject, SiteContextSource, SiteObjectFieldContract, SiteRegistries } from "./siteContext.js";

export class SiteContextSourceReadError extends Error {
  constructor(readonly tool: string, readonly tenantId: string, readonly detail: string, readonly objectType?: string) {
    super(`SiteContextSourceReadError: ${tool}(${objectType ? `object_type=${objectType}, ` : ""}tenantId=${tenantId}) failed: ${detail}`);
    this.name = "SiteContextSourceReadError";
  }
}

// Thrown when the tenantId this adapter is asked to read names no registered project. Distinct from
// SiteContextSourceReadError (that class is a TENANT'S OWN read failing; this is "there is no tenant
// to read at all") so a caller can tell "misconfigured/unknown tenant" apart from "the tenant's
// server refused/errored" without string-matching a message.
export class SiteContextSourceUnknownTenantError extends Error {
  constructor(readonly tenantId: string) {
    super(`SiteContextSourceUnknownTenantError: no registered project for tenantId "${tenantId}".`);
    this.name = "SiteContextSourceUnknownTenantError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const pick = (source: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
};

// Same envelope-descent discipline as sitePrefetch.ts's extractListItems / extractRecordBody (each
// file in this codebase keeps its own tiny copy rather than sharing across modules — see
// sitePrefetch.ts's own header for why: it stays independently testable without importing another
// prefetch module's internals). Prefers structuredContent; parses the content[] text block only when
// structuredContent is absent.
const LIST_KEYS = ["items", "objects", "records", "results", "rows"];
function extractListItems(result: unknown): unknown[] {
  if (!isObject(result)) return [];
  const structured = result.structuredContent;
  if (isObject(structured)) {
    const list = pick(structured, LIST_KEYS);
    if (isArray(list)) return list;
  }
  const content = result.content;
  if (isArray(content)) {
    const text = content.find((block): block is { text: string } => isObject(block) && typeof block.text === "string")?.text;
    if (typeof text === "string") {
      try {
        const parsed: unknown = JSON.parse(text);
        if (isArray(parsed)) return parsed;
        if (isObject(parsed)) {
          const list = pick(parsed, LIST_KEYS);
          if (isArray(list)) return list;
        }
      } catch { /* not JSON — no items to extract */ }
    }
  }
  return [];
}

function extractRecordBody(result: unknown): unknown {
  if (!isObject(result)) return result;
  const structured = result.structuredContent;
  if (isObject(structured)) return isObject(structured.contract) ? structured.contract : structured;
  const content = result.content;
  if (isArray(content)) {
    const text = content.find((block): block is { text: string } => isObject(block) && typeof block.text === "string")?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  return result;
}

// One object_inventory summary row -> SiteContextObject. `fields` is always `{}` — see this module's
// header for why a LIST-mode inventory read never carries full body content. Numeric counters that a
// row does not report default to 0 (the same "absent counter means 0" idiom DATA_ARCHITECTURE.md §5
// already documents for `rev`), `publishedTime` absent means null (its own domain is nullable), and
// `updatedAt`/`status` absent are reported as the empty string / "unknown" respectively — NEVER a
// fabricated non-empty value — because neither field name is confirmed anywhere in this codebase's
// captured platform evidence (docs/projects/dr-lurie-agent-publishing-policy.md §10.1 lists
// object_id/version/content_revision/review_state/lock/published_time/unpublished_changes; it names
// neither `updated_at` nor `status` on an inventory row).
function normalizeInventoryRow(item: unknown, requestedObjectType: string): SiteContextObject | undefined {
  if (!isObject(item)) return undefined;
  const objectId = pick(item, ["object_id", "objectId", "id"]);
  if (!isNonEmptyString(objectId)) return undefined;
  const objectType = pick(item, ["object_type", "objectType"]);
  const version = pick(item, ["version"]);
  const contentRevision = pick(item, ["content_revision", "contentRevision"]);
  const publishedTime = pick(item, ["published_time", "publishedTime"]);
  const updatedAt = pick(item, ["updated_at", "updatedAt"]);
  // `status` first (the real filterable field name, per object_inventory's own query schema); a
  // review_state value is a documented, real field on the same row and is used as a fallback rather
  // than reporting "unknown" for a row that plainly does carry SOME lifecycle signal.
  const status = pick(item, ["status", "review_state", "reviewState"]);
  return {
    objectId,
    objectType: typeof objectType === "string" && objectType.length ? objectType : requestedObjectType,
    status: typeof status === "string" && status.length ? status : "unknown",
    version: typeof version === "number" ? version : 0,
    contentRevision: typeof contentRevision === "number" ? contentRevision : 0,
    publishedTime: typeof publishedTime === "string" ? publishedTime : null,
    updatedAt: typeof updatedAt === "string" ? updatedAt : "",
    fields: {}
  };
}

const extractBodySchema = (raw: Record<string, unknown>): unknown => pick(raw, ["body_schema", "bodySchema", "schema"]);

function normalizeObjectContract(raw: unknown, objectType: string): SiteObjectFieldContract | null {
  if (!isObject(raw)) return null;
  // A `not_found`/absent-contract signal some tenants return for an object type they do not govern —
  // a legitimate "no contract", not a failure (the call itself already succeeded, or this function
  // would not have been reached — see getObjectContract below).
  if (raw.not_found === true) return null;
  const bodySchema = extractBodySchema(raw);
  if (!isObject(bodySchema)) return null;
  const requiredRaw = bodySchema.required;
  const required = isArray(requiredRaw) ? requiredRaw.filter((entry): entry is string => typeof entry === "string") : [];
  return { objectType, required, schema: bodySchema as Record<string, unknown> };
}

const normalizeRegistryEntry = (item: unknown): { id: string; kind: string; label?: string } | undefined => {
  if (!isObject(item)) return undefined;
  const id = pick(item, ["id", "object_id", "objectId"]);
  if (!isNonEmptyString(id)) return undefined;
  const kind = pick(item, ["kind"]);
  const label = pick(item, ["label"]);
  return { id, kind: typeof kind === "string" ? kind : "", ...(typeof label === "string" ? { label } : {}) };
};

const normalizePdfTemplateEntry = (item: unknown): { templateId: string; kind?: string; label?: string; isDefault?: boolean } | undefined => {
  if (!isObject(item)) return undefined;
  const templateId = pick(item, ["templateId", "template_id", "id"]);
  if (!isNonEmptyString(templateId)) return undefined;
  const kind = pick(item, ["kind"]);
  const label = pick(item, ["label"]);
  const isDefault = pick(item, ["isDefault", "is_default"]);
  return {
    templateId,
    ...(typeof kind === "string" ? { kind } : {}),
    ...(typeof label === "string" ? { label } : {}),
    ...(typeof isDefault === "boolean" ? { isDefault } : {})
  };
};

export type SiteContextSourceAdapterDeps = {
  projectRepository: ProjectRepository;
  // Forwarded verbatim into tenantAdapterFor's TenantCallContext on every call — carries runId/nodeId
  // attribution into the audited tool-execution ledger when the caller has one (e.g. a future run
  // that wires this adapter). `caller` is always "engine": this module is deterministic code, never a
  // model's own tool-selection loop — see tools/tenantInvoke.ts's own header for the distinction.
  tenantContext?: Omit<TenantCallContext, "caller">;
};

// The production SiteContextSource. `tenantId` is resolved to a real ProjectConnectionConfig on
// every call (never cached here — the project repository has its own caching/CAS discipline; this
// class holds no state of its own beyond its constructor deps).
export class ProjectSiteContextSourceAdapter implements SiteContextSource {
  constructor(private readonly deps: SiteContextSourceAdapterDeps) {}

  private async requireProject(tenantId: string) {
    const config = await this.deps.projectRepository.get(tenantId);
    if (!config) throw new SiteContextSourceUnknownTenantError(tenantId);
    return config;
  }

  async listObjects({ tenantId, objectType }: { tenantId: string; objectType: string }): Promise<readonly SiteContextObject[]> {
    const config = await this.requireProject(tenantId);
    const adapter = tenantAdapterFor(config, { caller: "engine", ...this.deps.tenantContext });
    // LIST mode: no object_id, per object_inventory's own real schema (platformToolSchemas.ts) —
    // supplying one switches the same tool to a single-object DETAIL view, which this method never
    // wants.
    const call = await adapter.callReadTool("object_inventory", { object_type: objectType });
    if (!call.ok) throw new SiteContextSourceReadError("object_inventory", tenantId, call.error ?? "unknown error", objectType);
    return extractListItems(call.result)
      .map((item) => normalizeInventoryRow(item, objectType))
      .filter((entry): entry is SiteContextObject => !!entry);
  }

  async getObjectContract({ tenantId, objectType }: { tenantId: string; objectType: string }): Promise<SiteObjectFieldContract | null> {
    const config = await this.requireProject(tenantId);
    const adapter = tenantAdapterFor(config, { caller: "engine", ...this.deps.tenantContext });
    const call = await adapter.callReadTool("object_contract", { object_type: objectType });
    if (!call.ok) throw new SiteContextSourceReadError("object_contract", tenantId, call.error ?? "unknown error", objectType);
    return normalizeObjectContract(extractRecordBody(call.result), objectType);
  }

  async getRegistries({ tenantId }: { tenantId: string }): Promise<SiteRegistries> {
    const config = await this.requireProject(tenantId);
    const adapter = tenantAdapterFor(config, { caller: "engine", ...this.deps.tenantContext });

    // Each of the three registry_get reads degrades independently to an empty list — see this
    // module's header ("REGISTRY-SHAPED REFERENCE DATA") for why this is the one path in this
    // adapter that never throws on a failed/unsupported read.
    const readRegistry = async (registry: string): Promise<unknown[]> => {
      try {
        const call = await adapter.callReadTool("registry_get", { registry });
        return call.ok ? extractListItems(call.result) : [];
      } catch {
        return [];
      }
    };

    const [visualStandardItems, pdfTemplateItems, imagePolicyItems] = await Promise.all([
      readRegistry("visual_standard"),
      readRegistry("pdf_template"),
      readRegistry("image_policy_context")
    ]);

    return {
      visualStandards: visualStandardItems.map(normalizeRegistryEntry).filter((entry): entry is { id: string; kind: string; label?: string } => !!entry),
      pdfTemplates: pdfTemplateItems.map(normalizePdfTemplateEntry).filter((entry): entry is { templateId: string; kind?: string; label?: string; isDefault?: boolean } => !!entry),
      imagePolicyContexts: imagePolicyItems.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    };
  }

  // DECIDED (coordinator, A6; restated in siteContext.ts's own header): always null. See this
  // module's header for why — the snapshot's own content digest is the staleness key, and no tenant
  // in this codebase exposes a single "site revision" stamp.
  async getRevisionId(_params: { tenantId: string }): Promise<string | null> {
    return null;
  }
}

export const createSiteContextSourceAdapter = (deps: SiteContextSourceAdapterDeps): SiteContextSource => new ProjectSiteContextSourceAdapter(deps);
