// A9 — injectable, test-overridable providers for the two pieces image_template_revision does not
// itself implement:
//   - assetCatalog: resolving a tagged/checksummed/capture-request-provenanced source image. A5
//     (asset_lookup_adopt) has no registered executor yet (operationWorkflowBindings.ts's own
//     UNBOUND_OPERATION_IMPLEMENTING_TASK still names it) — this module does not invent one.
//   - previewTemplateVariant / verifyImagePresence: production wires these to Platform's A8
//     template-preview / document-content-check path over the trusted bridge
//     (packages/core/lib/pdf/template-preview.ts, document-render.ts — PR #752). Neither is
//     implemented here.
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

export function setImageTemplateRevisionProviders(providers: ImageTemplateRevisionProviders): void {
  current = providers;
}

export function resetImageTemplateRevisionProviders(): void {
  current = DEFAULT_PROVIDERS;
}
