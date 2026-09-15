// A9 — injectable, test-overridable providers for the two pieces image_template_revision does not
// itself implement:
//   - assetCatalog: resolving a tagged/checksummed/capture-request-provenanced source image. A5
//     (asset_lookup_adopt) has no registered executor yet (operationWorkflowBindings.ts's own
//     UNBOUND_OPERATION_IMPLEMENTING_TASK still names it) — this module does not invent one.
//   - previewTemplateVariant / verifyImagePresence: NOT WIRED IN PRODUCTION TODAY. Nothing outside
//     tests calls setImageTemplateRevisionProviders (grep it), so a live run always sees the
//     defaults below. The Platform verbs they should map to DO exist on every tenant server
//     (packages/core/server/lib/mcp-tool-definitions.ts, PR #752): `preview_pdf_template_fixture`
//     (render a fixture against a template_json — called once per before/after templateJson) for
//     previewTemplateVariant, and `verify_pdf_content` (inspect a rendered artifact for unresolved
//     images) for verifyImagePresence; both are "allowed" in GENESIS_TENANT_TOOL_POLICIES since v3.
//     The wiring is its own task: it assembles per-run providers from callProjectTool
//     (cloneEngine.ts) for the run's targetProjectId in cloneConductorRoutes.ts's image_revision_*
//     cases, and verifyImagePresence needs a rendered preview artifact to inspect, so it composes
//     with the preview seam rather than standing alone. Until then a live run reports
//     preview_failed / verify_failed per item, by name — never a fabricated result.
//
// A LIVE run with no override gets NOT_CONFIGURED_ASSET_CATALOG and undefined preview/verify
// functions below — imageTemplateRevisionEngine.ts's own steps read that absence as a NAMED,
// per-item capability gap (source_resolve_failed / preview_failed / verify_failed), never a silent
// skip and never a fabricated result. Tests call setImageTemplateRevisionProviders(...) with fixture
// doubles and MUST call resetImageTemplateRevisionProviders() afterwards — the same
// set/reset-around-a-module-level-singleton pattern templateLibraryBackend.ts's
// resetTemplateLibraryMemoryStore already holds itself to, so no one test's fixture can leak into
// another.
import type { AssetCatalogSource, PreviewTemplateVariantFn, VerifyImagePresenceFn } from "../capture/imageTemplateRevisionEngine.js";

export type ImageTemplateRevisionProviders = {
  assetCatalog: AssetCatalogSource;
  previewTemplateVariant?: PreviewTemplateVariantFn;
  verifyImagePresence?: VerifyImagePresenceFn;
};

// A10-D2 — `configured: false` is the load-bearing field here: resolveSourceImageStep
// (imageTemplateRevisionEngine.ts) checks it BEFORE calling any resolve* method below, so a run with
// no asset catalogue wired is told "no asset catalogue is configured" (a capability gap), never "no
// asset tagged X found" (a search that came back empty, identical prose to a genuine miss). The
// resolve* methods below still return their old, empty answers as a defensive fallback in case some
// future caller reads them without checking `configured` first — but they are never the FIRST thing
// consulted in production's default (unconfigured) state.
const NOT_CONFIGURED_ASSET_CATALOG: AssetCatalogSource = {
  configured: false,
  resolveByTag: async () => [],
  resolveByChecksum: async () => undefined,
  resolveByCaptureRequestId: async () => undefined
};

const DEFAULT_PROVIDERS: ImageTemplateRevisionProviders = {
  assetCatalog: NOT_CONFIGURED_ASSET_CATALOG,
  previewTemplateVariant: undefined,
  verifyImagePresence: undefined
};

let current: ImageTemplateRevisionProviders = DEFAULT_PROVIDERS;

export function resolveImageTemplateRevisionProviders(): ImageTemplateRevisionProviders {
  return current;
}

// Milestone A remainder (3a) — production no longer reads the DEFAULT_PROVIDERS above: every live
// stage assembles its OWN per-run providers from the tenant's MCP surface
// (imageTemplateRevisionPlatformProviders.ts's buildImageTemplateRevisionProviders), because the
// tenant, its site object id and the run's tenantContext are all run-scoped and a module-level
// singleton cannot hold them. This predicate is how a caller tells the two apart: TRUE means a test
// has installed doubles through setImageTemplateRevisionProviders and they must win (that is the
// whole point of the seam); FALSE means nobody has, so the caller assembles the real thing. The
// defaults stay exactly as they were — the honest, named "nothing is wired" answer for any caller
// that reads them without assembling.
export function hasImageTemplateRevisionProviderOverride(): boolean {
  return current !== DEFAULT_PROVIDERS;
}

export function setImageTemplateRevisionProviders(providers: ImageTemplateRevisionProviders): void {
  current = providers;
}

export function resetImageTemplateRevisionProviders(): void {
  current = DEFAULT_PROVIDERS;
}
