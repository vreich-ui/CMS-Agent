// Pure, deterministic, model-free intent-to-operation resolution (A2). No clock, no randomness, no
// I/O: the exact same (intent, context) pair always returns the exact same result, and every
// returned list is sorted so two runs are byte-comparable. This module never calls a model to
// decide — "disambiguation" here means structural matching against the registered catalog only.
import { listOperations } from "./operationCatalog.js";
import type { OperationDescriptor } from "./operationTypes.js";
import type { AssetRef, OperationReference, TemplateRef } from "./operationReferences.js";

export type DisambiguationContext = {
  surface?: "web" | "pdf" | null;
  refs?: OperationReference[];
};

export type DisambiguationResult =
  | { resolved: OperationDescriptor }
  | { alternatives: OperationDescriptor[] };

const byOperationId = (left: OperationDescriptor, right: OperationDescriptor) => left.operationId.localeCompare(right.operationId);

const isTemplateRef = (ref: OperationReference): ref is TemplateRef => "templateId" in ref && "surface" in ref;

// AssetRef (operationReferences.ts) carries its own optional `surface` as a caller-declared hint —
// same field name, same closed "web" | "pdf" enum as TemplateRef's, added at the coordinator's
// direction so a PDF-bound (or web-bound) asset reference narrows disambiguation exactly like a
// TemplateRef already does. `"surface" in ref` alone is not enough to identify an AssetRef here (a
// TemplateRef also carries `surface`); `assetId` is the field only AssetRef has.
const isAssetRef = (ref: OperationReference): ref is AssetRef => "assetId" in ref;

// Every ref kind this catalog can read a surface signal from: a TemplateRef's `surface` is always
// present; an AssetRef's is optional, so only a ref that actually declared one contributes. First
// match in `refs` order wins — the same "first ref that carries a signal" rule for both kinds, so a
// caller mixing an unscoped AssetRef with a scoped TemplateRef sees a signal exactly when the
// scoped one appears, never a surprise ordering dependency between the two kinds.
const surfaceSignalFromRefs = (refs: OperationReference[] | undefined): "web" | "pdf" | null => {
  for (const ref of refs ?? []) {
    if (isTemplateRef(ref)) return ref.surface;
    if (isAssetRef(ref) && ref.surface) return ref.surface;
  }
  return null;
};

const resolveSurfaceSignal = (context: DisambiguationContext): "web" | "pdf" | null =>
  context.surface ?? surfaceSignalFromRefs(context.refs) ?? null;

// Descriptors whose intentKeywords hit the normalized intent, sorted for determinism. A keyword
// "hits" when it appears verbatim (case-insensitive) as a substring of the intent — the simplest
// rule that stays honest about what it is doing: no fuzzy scoring, no synonym table, nothing that
// would make two callers reading this function disagree about why a match happened.
const matchByKeyword = (normalizedIntent: string): OperationDescriptor[] =>
  listOperations()
    .filter((descriptor) => descriptor.intentKeywords.some((keyword) => normalizedIntent.includes(keyword.toLowerCase())))
    .sort(byOperationId);

export function disambiguateOperation(intent: string, context: DisambiguationContext = {}): DisambiguationResult {
  const normalizedIntent = intent.toLowerCase();
  const surfaceSignal = resolveSurfaceSignal(context);
  const matches = matchByKeyword(normalizedIntent);

  // A surface signal (explicit, or read off a PDF/web-bound TemplateRef) narrows keyword matches to
  // the operation(s) scoped to that surface FIRST — e.g. a bare "template" request that keyword-
  // matches both the web and PDF template operations resolves to exactly one once the caller's
  // context says which surface it means.
  if (surfaceSignal) {
    const scoped = matches.filter((descriptor) => descriptor.surface === surfaceSignal);
    if (scoped.length === 1) return { resolved: scoped[0] };
    if (scoped.length > 1) return { alternatives: scoped };
    // No keyword match is scoped to this surface — fall through to the unscoped matches below
    // rather than resolving nothing just because the surface signal didn't narrow anything.
  }

  if (matches.length === 1) return { resolved: matches[0] };
  return { alternatives: matches };
}
