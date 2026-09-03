// C1 (BRIEF §3.7): prefetches the site-level facts a run needs to write on-brand imagery and PDFs
// without a discovery call inside a node's own agent loop — mirroring voicePrefetch.ts's shape
// exactly (same RunScopedCache, same "never fail the caller, degrade with a NAMED warningCode"
// posture) so this optimization never repeats contract_intelligence's original mistake of paying for
// discovery on every turn of a model's own loop.
//
// FOUR independent reads, each policy-checked and each degrading on its own:
//   1. object_contract({object_type:'site'}) — the `brand_imagery_override_policy` constraint entry
//      P4 (platform) writes there. `contractPrefetch.ts` already calls object_contract for the
//      client's CONTENT object type; this is a second, separate call for the SITE object type — same
//      tool, no new one needed (BRIEF §3.7's explicit "no new tool" note).
//   2. object_get({object_type:'site', object_id: <dialect.siteObjectId>}) — the site's applied
//      brandImagery, its pdf block (defaultTemplateId/byKind, used only to compute pdfTemplates[].
//      isDefault below — the block itself is not part of ReducedContract's shape), tolerantly a
//      reference to its own house visual_standard id, and (FIX-D, BRIEF §3.5) the site's own
//      brandTokens and logo — carried as `brandPalette`/`logo`, off THIS SAME response, at no extra
//      call. See extractBrandPalette below for why the palette is not named `brandTokens` here.
//   3. object_list({object_type:'visual_standard'}) — the site's visual_standard objects; kind:'house'
//      names the singleton (a fallback source for houseId when the site object did not carry one, R2:
//      `vis_<site>` mirrors `voice_<site>`), kind:'template' entries become `templates`.
//   4. list_pdf_templates — the site's published PDF templates.
//   5. get_image_model_policy — `byUsageContext`'s keys become `imagePolicyContexts`.
//
// UNLIKE contractPrefetch's getReducedContract, this function has NO failure return at all: every one
// of the five reads above degrades independently (a named warningCode pushed onto `warnings`) rather
// than failing the whole prefetch, exactly the "never a hard failure" instruction in BRIEF §3.7's task
// scope. `overridePolicy` in particular always resolves to a value — 'allow' is the stated default
// when the constraint is absent, blocked, unreachable, or carries an unrecognized value — so a
// downstream node is never left to invent its own default.
//
// Two projects unresolvable at all (unknown projectId, or a project with no configured
// objectDialect.siteObjectId) return `{ warnings: [...] }` with every data field absent — the same
// "clean no-op, not a degradation of something that should exist" posture voicePrefetch.ts uses for a
// project with no voice concept wired at all.
import { ProjectMcpAdapter, type ReadToolCallResult } from "../projects/projectMcpAdapter.js";
import { getProjectHooks } from "../projects/projectHooks.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { conductorCache, type RunScopedCache } from "./conductor.js";
import { extractContractPayload } from "./contractPrefetch.js";
import type { ReducedContractBrandPalette, ReducedContractPdfTemplate, ReducedContractSiteLogo, ReducedContractVisualStandard } from "./contractReduction.js";

export type SitePrefetchWarningCode =
  | "site_project_unresolved"
  | "site_object_unconfigured"
  | "site_object_blocked"
  | "site_object_unreachable"
  | "site_object_not_found"
  | "site_brand_tokens_absent"
  | "site_logo_absent"
  | "visual_standard_list_blocked"
  | "visual_standard_list_unreachable"
  | "pdf_templates_blocked"
  | "pdf_templates_unreachable"
  | "image_policy_blocked"
  | "image_policy_unreachable"
  | "override_policy_blocked"
  | "override_policy_unreachable"
  | "override_policy_absent"
  | "override_policy_invalid"
  | "threw";

export type SitePrefetchWarning = { code: SitePrefetchWarningCode; message: string };

export type SitePrefetchResult = {
  visualStandard?: ReducedContractVisualStandard;
  pdfTemplates?: ReducedContractPdfTemplate[];
  imagePolicyContexts?: string[];
  // FIX-D (BRIEF §3.5): the site's OWN brand facts, read off the same object_get the houseId/pdf
  // block already came from — no extra call. See contractReduction.ts's ReducedContractBrandPalette
  // for why the palette does NOT travel under the name `brandTokens`.
  brandPalette?: ReducedContractBrandPalette;
  logo?: ReducedContractSiteLogo;
  warnings: SitePrefetchWarning[];
};

export type SitePrefetchParams = { runId: string; projectId: string };
export type SitePrefetchDeps = { projectRepository: ProjectRepository; cache?: RunScopedCache };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// Same fix as contractPrefetch.ts's / voicePrefetch.ts's own timeout constants, for the identical
// reason: these calls bypass executeTool entirely (deterministic conductor code, not a model-invoked
// tool) and so inherit no timeout of their own. Every failure mode here already degrades gracefully
// (a warning, never a thrown node) but only if it degrades AT ALL rather than hanging forever on a
// dead connection.
const SITE_PREFETCH_TIMEOUT_MS = 15_000;

const pick = (source: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
};

// Findings from the project's executable policy hook, filtered to blocking severity — the identical
// ordering contractPrefetch.ts and voicePrefetch.ts both use: this runs before any transport, even
// though none of these calls go through the controlled-tool/model-facing gate.
const blockingPolicyFindings = (projectId: string, tool: string, arguments_: Record<string, unknown>): string[] =>
  (getProjectHooks(projectId)?.enforceCallToolPolicy?.({ tool, arguments: arguments_ }) ?? [])
    .filter((finding) => finding.severity === "error")
    .map((finding) => finding.code);

async function callRead(adapter: ProjectMcpAdapter, tool: string, arguments_: Record<string, unknown>): Promise<ReadToolCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_PREFETCH_TIMEOUT_MS);
  try {
    return await adapter.callReadTool(tool, arguments_, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// object_get's envelope mirrors object_contract's / editorial voice's (see contractPrefetch.ts's
// extractContractPayload and voicePrefetch.ts's T10 comment): prefer structuredContent, descending
// through a plausible container key (object/record) to its `body` when the container itself is not
// already the body; fall back to the content[] text block only when structuredContent is absent.
// Never assumed beyond what THIS call actually returned.
function extractRecordBody(result: unknown): unknown {
  const descend = (candidate: unknown): unknown => (isObject(candidate) && isObject(candidate.body) ? candidate.body : candidate);
  if (!isObject(result)) return result;
  const structured = result.structuredContent;
  if (isObject(structured)) {
    if (isObject(structured.object)) return descend(structured.object);
    if (isObject(structured.record)) return descend(structured.record);
    return descend(structured);
  }
  const content = result.content;
  if (isArray(content)) {
    const text = content.find((block): block is { text: string } => isObject(block) && typeof block.text === "string")?.text;
    if (typeof text === "string") {
      try { return descend(JSON.parse(text)); } catch { return text; }
    }
  }
  return descend(result);
}

// object_list's envelope: an items array under one of a few plausible keys, or (rarely) the content[]
// text block carrying the same shape serialized. Each element may itself be a full object RECORD
// (object_id/id + body) or already-flattened data — normalizeListItem below handles both.
function extractListItems(result: unknown): unknown[] {
  if (!isObject(result)) return [];
  const structured = result.structuredContent;
  // "templates" covers list_pdf_templates's own natural response shape ({templates:[...]}); the rest
  // are the generic object-list envelope shapes contractPrefetch.ts/voicePrefetch.ts already assume
  // elsewhere in this codebase.
  const LIST_KEYS = ["items", "objects", "records", "results", "templates"];
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

// A visual_standard list entry, tolerant of a full record ({object_id, body:{kind,label,whenToUse}})
// or an already-flattened item ({id, kind, label, whenToUse}) — descend to `body` for the field read
// ONLY, never for the id (a record's id is object_id/id at its own top level, per every other object
// read in this codebase; a flattened item's id is just `id`).
const normalizeVisualStandardItem = (item: unknown): { id: string; kind?: string; label?: string; whenToUse?: string } | undefined => {
  if (!isObject(item)) return undefined;
  const id = pick(item, ["object_id", "id"]);
  if (!isNonEmptyString(id)) return undefined;
  const fields = isObject(item.body) ? item.body : item;
  const kind = pick(fields, ["kind"]);
  const label = pick(fields, ["label"]);
  const whenToUse = pick(fields, ["whenToUse", "when_to_use"]);
  return { id, ...(typeof kind === "string" ? { kind } : {}), ...(typeof label === "string" ? { label } : {}), ...(typeof whenToUse === "string" ? { whenToUse } : {}) };
};

const extractHouseIdFromSiteBody = (body: Record<string, unknown>): string | undefined => {
  const direct = pick(body, ["visualStandardId", "visual_standard_id", "houseVisualStandardId", "house_visual_standard_id"]);
  if (isNonEmptyString(direct)) return direct;
  const brandImagery = body.brandImagery;
  if (isObject(brandImagery)) {
    const nested = pick(brandImagery, ["visualStandardId", "visual_standard_id"]);
    if (isNonEmptyString(nested)) return nested;
  }
  return undefined;
};

// FIX-D (BRIEF §3.5) — the site's brandTokens and logo, off the SAME object_get read 2 already made.
//
// WHY THE CARRIED KEY IS `brandPalette` AND NOT `brandTokens`. The node runners' per-node prompt
// redactor (AnthropicNodeRunner.ts / OpenAINodeRunner.ts, `/api[_-]?key|authorization|bearer|jwt|
// cookie|token|secret|.../i`) replaces the VALUE of any input key matching it with "[REDACTED]"
// before a model ever sees it. `brandTokens` matches on `token`. This is not hypothetical: T13.3
// (provenance.ts) records the identical defect on the clone briefing — `site.brandTokens` arrived at
// theme_reconciler as the literal string "[REDACTED]" and the node correctly, uselessly, refused —
// and the fix taken there is the one taken here: THE REDACTOR IS A GLOBAL SECURITY CONTROL AND IS NOT
// TOUCHED; the carrier's own field name is chosen not to collide. Same shape ({colors, fonts}), same
// values, same platform field underneath (`site.brandTokens`, whose only sanctioned writer is still
// site_apply_theme). A `brandTokens`-named field here would have satisfied the letter of §3.5 and
// delivered the writer nothing but a redaction marker.
const stringMap = (value: unknown): Record<string, string> | undefined => {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
};

const extractBrandPalette = (body: Record<string, unknown>): ReducedContractBrandPalette | undefined => {
  const tokens = pick(body, ["brandTokens", "brand_tokens"]);
  if (!isObject(tokens)) return undefined;
  const colors = stringMap(tokens.colors);
  const fonts = stringMap(tokens.fonts);
  if (!colors && !fonts) return undefined;
  return { ...(colors ? { colors } : {}), ...(fonts ? { fonts } : {}) };
};

// The logo, bounded to what a look-writer needs: where the mark is, and what it is called.
//
// REVIEW: `imageAssetRef` and `text` are the keys that actually matter, and neither was read.
// Platform's site body declares `logo` as a STRICT `{ text: string; imageAssetRef?: string }`
// (packages/core/schema/bodies/site-v1.ts) — no `url`, no `src`, no `href`, no `blobKey`. Reading
// only those four meant this returned undefined for every real site object, so FIX-D's logo half was
// dead on arrival: a site that HAS a logo still reported `site_logo_absent` on every run. The other
// spellings stay as tolerated aliases — a differently-shaped substrate is why every reader in this
// module is tolerant — with platform's own names read FIRST.
const extractSiteLogo = (body: Record<string, unknown>): ReducedContractSiteLogo | undefined => {
  const raw = pick(body, ["logo", "logoUrl", "logo_url"]);
  if (isNonEmptyString(raw)) return { url: raw };
  if (!isObject(raw)) return undefined;
  const url = pick(raw, ["imageAssetRef", "image_asset_ref", "url", "src", "href", "blobKey", "blob_key"]);
  // `text` is platform's own wordmark string — exactly the "what is the mark called" half.
  const alt = pick(raw, ["alt", "altText", "alt_text", "label", "text"]);
  if (!isNonEmptyString(url)) return undefined;
  return { url, ...(isNonEmptyString(alt) ? { alt } : {}) };
};

type SitePdfBlock = { defaultTemplateId?: string; byKind?: Record<string, string> };

const extractSitePdfBlock = (body: Record<string, unknown>): SitePdfBlock | undefined => {
  const pdf = body.pdf;
  if (!isObject(pdf)) return undefined;
  const defaultTemplateId = pdf.defaultTemplateId;
  const byKind = pdf.byKind;
  return {
    ...(isNonEmptyString(defaultTemplateId) ? { defaultTemplateId } : {}),
    ...(isObject(byKind) ? { byKind: Object.fromEntries(Object.entries(byKind).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {})
  };
};

const isDefaultPdfTemplate = (templateId: string, kind: string | undefined, sitePdf: SitePdfBlock | undefined): boolean => {
  if (!sitePdf) return false;
  if (sitePdf.defaultTemplateId === templateId) return true;
  return !!kind && sitePdf.byKind?.[kind] === templateId;
};

const normalizePdfTemplateItem = (item: unknown, sitePdf: SitePdfBlock | undefined): ReducedContractPdfTemplate | undefined => {
  if (!isObject(item)) return undefined;
  const templateId = pick(item, ["templateId", "template_id", "id"]);
  if (!isNonEmptyString(templateId)) return undefined;
  const kind = pick(item, ["kind"]);
  const label = pick(item, ["label"]);
  const renderDataSchema = pick(item, ["renderDataSchema", "render_data_schema"]);
  const declaredDefault = pick(item, ["isDefault", "is_default"]);
  return {
    templateId,
    ...(typeof kind === "string" ? { kind } : {}),
    ...(typeof label === "string" ? { label } : {}),
    ...(renderDataSchema !== undefined ? { renderDataSchema } : {}),
    isDefault: typeof declaredDefault === "boolean" ? declaredDefault : isDefaultPdfTemplate(templateId, typeof kind === "string" ? kind : undefined, sitePdf)
  };
};

// The `brand_imagery_override_policy` constraint entry (BRIEF §3.7's read path): a constraint on the
// SITE object's own object_contract, the same array shape contractReduction.ts's extractConstraints
// reads for the content object type, but with a `value` this reduction never needed — it identifies
// an id/severity/description, never a policy value.
const extractOverridePolicyValue = (raw: unknown): unknown => {
  if (!isObject(raw)) return undefined;
  const list = pick(raw, ["constraints", "structural_constraints", "structuralConstraints"]);
  if (!isArray(list)) return undefined;
  const entry = list.find((candidate): candidate is Record<string, unknown> => isObject(candidate) && candidate.id === "brand_imagery_override_policy");
  return entry ? pick(entry, ["value"]) : undefined;
};

const extractImagePolicyContexts = (raw: unknown): string[] | undefined => {
  const payload = extractRecordBody(raw);
  if (!isObject(payload)) return undefined;
  const byUsageContext = pick(payload, ["byUsageContext", "by_usage_context"]);
  return isObject(byUsageContext) ? Object.keys(byUsageContext) : undefined;
};

export async function getSitePrefetch(params: SitePrefetchParams, deps: SitePrefetchDeps): Promise<SitePrefetchResult> {
  const cache = deps.cache ?? conductorCache;
  const cacheKey = `sitePrefetch:${params.projectId}`;
  return cache.getOrLoad(params.runId, cacheKey, async (): Promise<SitePrefetchResult> => {
    const warnings: SitePrefetchWarning[] = [];

    const config = await deps.projectRepository.get(params.projectId);
    if (!config) {
      warnings.push({ code: "site_project_unresolved", message: `Unknown projectId: ${params.projectId}; visual standard/PDF template/image policy prefetch skipped.` });
      return { warnings };
    }
    const siteObjectId = config.objectDialect?.siteObjectId;
    if (!siteObjectId) {
      warnings.push({ code: "site_object_unconfigured", message: `Project "${params.projectId}" declares no objectDialect.siteObjectId; cannot resolve its site object for visual standard/PDF template prefetch.` });
      return { warnings };
    }

    const adapter = new ProjectMcpAdapter(config);

    // 1. overridePolicy — object_contract({object_type:'site'}). Always resolves; 'allow' is the
    // stated default for every degradation (blocked, unreachable, absent, or an unrecognized value).
    let overridePolicy: "allow" | "lock" = "allow";
    try {
      const arguments_ = { object_type: "site" };
      const blocking = blockingPolicyFindings(params.projectId, "object_contract", arguments_);
      if (blocking.length) {
        warnings.push({ code: "override_policy_blocked", message: `object_contract(site) for the brand-imagery override policy is blocked by executable project policy: ${blocking.join(", ")}; defaulting overridePolicy to 'allow'.` });
      } else {
        const call = await callRead(adapter, "object_contract", arguments_);
        if (!call.ok) {
          warnings.push({ code: "override_policy_unreachable", message: `object_contract(site) failed for project ${params.projectId}: ${call.error ?? "unknown error"}; defaulting overridePolicy to 'allow'.` });
        } else {
          const value = extractOverridePolicyValue(extractContractPayload(call.result));
          if (value === undefined) {
            warnings.push({ code: "override_policy_absent", message: `No brand_imagery_override_policy constraint was found on project ${params.projectId}'s site object contract; defaulting overridePolicy to 'allow'.` });
          } else if (value === "allow" || value === "lock") {
            overridePolicy = value;
          } else {
            warnings.push({ code: "override_policy_invalid", message: `brand_imagery_override_policy constraint value ${JSON.stringify(value)} is neither 'allow' nor 'lock'; defaulting overridePolicy to 'allow'.` });
          }
        }
      }
    } catch (error) {
      warnings.push({ code: "threw", message: `Unexpected error resolving the brand-imagery override policy for project ${params.projectId}: ${error instanceof Error ? error.message : String(error)}.` });
    }

    // 2. the site object — houseId (tolerant) and the pdf block (used only to compute pdfTemplates[].
    // isDefault below).
    let houseId: string | undefined;
    let sitePdf: SitePdfBlock | undefined;
    let brandPalette: ReducedContractBrandPalette | undefined;
    let logo: ReducedContractSiteLogo | undefined;
    // Only the site object read can answer "absent" — a read that never happened (blocked,
    // unreachable, not found) already warned under its own code, and warning a SECOND time there
    // would say "the site has no brandTokens" about a site nobody looked at.
    let siteBodyRead = false;
    try {
      const arguments_ = { object_type: "site", object_id: siteObjectId };
      const blocking = blockingPolicyFindings(params.projectId, "object_get", arguments_);
      if (blocking.length) {
        warnings.push({ code: "site_object_blocked", message: `object_get(site) is blocked by executable project policy: ${blocking.join(", ")}.` });
      } else {
        const call = await callRead(adapter, "object_get", arguments_);
        if (!call.ok) {
          warnings.push({ code: "site_object_unreachable", message: `object_get(${siteObjectId}) failed for project ${params.projectId}: ${call.error ?? "unknown error"}.` });
        } else {
          const body = extractRecordBody(call.result);
          if (isObject(body) && body.not_found === true) {
            warnings.push({ code: "site_object_not_found", message: `No live site object "${siteObjectId}" was found for project ${params.projectId}.` });
          } else if (isObject(body)) {
            siteBodyRead = true;
            houseId = extractHouseIdFromSiteBody(body);
            sitePdf = extractSitePdfBlock(body);
            brandPalette = extractBrandPalette(body);
            logo = extractSiteLogo(body);
          }
        }
      }
    } catch (error) {
      warnings.push({ code: "threw", message: `Unexpected error fetching the site object for project ${params.projectId}: ${error instanceof Error ? error.message : String(error)}.` });
    }

    // FIX-D: absence is a NAMED degradation, never a failure and never a fabricated palette. The
    // writer's hardest rule ("never invent a hex that is near neither a reference nor a brand token")
    // is only enforceable against the half of the evidence it actually has, so a run that has only
    // the references must SAY so rather than look identical to a run that had both.
    if (siteBodyRead && !brandPalette) {
      warnings.push({ code: "site_brand_tokens_absent", message: `Site object "${siteObjectId}" for project ${params.projectId} declares no brandTokens colors/fonts; a writer on this run reconciles its palette from the references alone.` });
    }
    if (siteBodyRead && !logo) {
      warnings.push({ code: "site_logo_absent", message: `Site object "${siteObjectId}" for project ${params.projectId} declares no logo; nothing on this run can check a proposed look against the mark.` });
    }

    // 3. object_list({object_type:'visual_standard'}) — templates, and a fallback houseId when the
    // site object above did not carry one.
    let templates: Array<{ id: string; label: string; whenToUse?: string }> = [];
    try {
      const arguments_ = { object_type: "visual_standard" };
      const blocking = blockingPolicyFindings(params.projectId, "object_list", arguments_);
      if (blocking.length) {
        warnings.push({ code: "visual_standard_list_blocked", message: `object_list(visual_standard) is blocked by executable project policy: ${blocking.join(", ")}.` });
      } else {
        const call = await callRead(adapter, "object_list", arguments_);
        if (!call.ok) {
          warnings.push({ code: "visual_standard_list_unreachable", message: `object_list(visual_standard) failed for project ${params.projectId}: ${call.error ?? "unknown error"}.` });
        } else {
          const normalized = extractListItems(call.result).map(normalizeVisualStandardItem).filter((entry): entry is NonNullable<typeof entry> => !!entry);
          if (!houseId) houseId = normalized.find((entry) => entry.kind === "house")?.id;
          templates = normalized.filter((entry) => entry.kind !== "house").map(({ id, label, whenToUse }) => ({ id, label: label ?? "", ...(whenToUse ? { whenToUse } : {}) }));
        }
      }
    } catch (error) {
      warnings.push({ code: "threw", message: `Unexpected error listing visual_standard objects for project ${params.projectId}: ${error instanceof Error ? error.message : String(error)}.` });
    }

    const visualStandard: ReducedContractVisualStandard = { ...(houseId ? { houseId } : {}), templates, overridePolicy };

    // 4. list_pdf_templates.
    let pdfTemplates: ReducedContractPdfTemplate[] | undefined;
    try {
      const blocking = blockingPolicyFindings(params.projectId, "list_pdf_templates", {});
      if (blocking.length) {
        warnings.push({ code: "pdf_templates_blocked", message: `list_pdf_templates is blocked by executable project policy: ${blocking.join(", ")}.` });
      } else {
        const call = await callRead(adapter, "list_pdf_templates", {});
        if (!call.ok) {
          warnings.push({ code: "pdf_templates_unreachable", message: `list_pdf_templates failed for project ${params.projectId}: ${call.error ?? "unknown error"}.` });
        } else {
          const normalized = extractListItems(call.result).map((item) => normalizePdfTemplateItem(item, sitePdf)).filter((entry): entry is ReducedContractPdfTemplate => !!entry);
          pdfTemplates = normalized;
        }
      }
    } catch (error) {
      warnings.push({ code: "threw", message: `Unexpected error listing PDF templates for project ${params.projectId}: ${error instanceof Error ? error.message : String(error)}.` });
    }

    // 5. get_image_model_policy.
    let imagePolicyContexts: string[] | undefined;
    try {
      const blocking = blockingPolicyFindings(params.projectId, "get_image_model_policy", {});
      if (blocking.length) {
        warnings.push({ code: "image_policy_blocked", message: `get_image_model_policy is blocked by executable project policy: ${blocking.join(", ")}.` });
      } else {
        const call = await callRead(adapter, "get_image_model_policy", {});
        if (!call.ok) {
          warnings.push({ code: "image_policy_unreachable", message: `get_image_model_policy failed for project ${params.projectId}: ${call.error ?? "unknown error"}.` });
        } else {
          imagePolicyContexts = extractImagePolicyContexts(call.result);
        }
      }
    } catch (error) {
      warnings.push({ code: "threw", message: `Unexpected error fetching the image model policy for project ${params.projectId}: ${error instanceof Error ? error.message : String(error)}.` });
    }

    return { visualStandard, ...(pdfTemplates ? { pdfTemplates } : {}), ...(imagePolicyContexts ? { imagePolicyContexts } : {}), ...(brandPalette ? { brandPalette } : {}), ...(logo ? { logo } : {}), warnings };
  });
}
