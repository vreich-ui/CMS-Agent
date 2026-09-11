// Pure, deterministic, model-free intent-to-operation resolution (A2). No clock, no randomness, no
// I/O: the exact same (intent, context) pair always returns the exact same result, and every
// returned list is sorted so two runs are byte-comparable. This module never calls a model to
// decide — "disambiguation" here means structural matching against the registered catalog only.
import { listOperations } from "./operationCatalog.js";
import type { OperationDescriptor } from "./operationTypes.js";
import type { OperationReference, TemplateRef } from "./operationReferences.js";

export type DisambiguationContext = {
  surface?: "web" | "pdf" | null;
  refs?: OperationReference[];
};

export type DisambiguationResult =
  | { resolved: OperationDescriptor }
  | { alternatives: OperationDescriptor[] };

const byOperationId = (left: OperationDescriptor, right: OperationDescriptor) => left.operationId.localeCompare(right.operationId);

const isTemplateRef = (ref: OperationReference): ref is TemplateRef => "templateId" in ref && "surface" in ref;

// The only ref kind this catalog can read a surface signal from today: TemplateRef carries its own
// `surface` field explicitly. ObjectRef and AssetRef (operationReferences.ts) carry no surface at
// all under the current contract, so an AssetRef contributes no signal here. (Flagged for the
// coordinator: if an AssetRef is meant to be "PDF-bound" on its own, its type needs a field that
// says so; nothing here invents one past the fixed reference shapes.)
const surfaceSignalFromRefs = (refs: OperationReference[] | undefined): "web" | "pdf" | null => {
  for (const ref of refs ?? []) if (isTemplateRef(ref)) return ref.surface;
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
