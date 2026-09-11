// Read-only discovery preflight (A2). preflightOperation() answers "what would running this
// operation need, and what — if anything — already blocks it", entirely from the operation's own
// registered descriptor plus the caller's input. It never runs the operation.
//
// PERFORMS ZERO WRITES AND ZERO PROBES, BY CONSTRUCTION: this module holds no repository, no
// tenant MCP adapter, no network client, and no clock-dependent state. It cannot mutate the
// workspace or call a tenant because it is never handed anything capable of doing either — there is
// no "try the write and see if it works" path available to reach for. `deps.repository` below exists
// only so a test can hand this function a repository double (with every write method throwing) and
// prove the double records zero calls: the function never references `deps` at all.
//
// A capability gap is read from `configuredCapabilities` the CALLER already knows (e.g. from a
// project record or env flag the caller consulted before calling preflight) — never fetched here.
// That keeps the "no probing call" guarantee absolute rather than "true so far because nothing
// happens to call the read method yet".
import { getOperation } from "./operationCatalog.js";
import { validateReference } from "./operationReferences.js";
import type { OperationBlocker, OperationCapabilityGap, OperationCompletionCheck, OperationEffect } from "./operationTypes.js";
import { validateOutput } from "../execution/outputValidator.js";

export type PreflightRequest = {
  operationId: string;
  version?: number;
  tenantId: string;
  input: unknown;
  /** Capabilities the caller already knows are configured for this tenant. Diffed against the
   *  operation's requiredCapabilities; never fetched by this function. */
  configuredCapabilities?: string[];
};

// Reserved for a later task's read-only capability lookup; never referenced by this module today.
// See header comment — its whole purpose is to be handed a repository double a test can prove was
// never called.
export type PreflightDeps = { repository?: unknown };

export type PreflightResult = {
  operationId: string;
  selectedVersion: number;
  appliedDefaults: Record<string, unknown>;
  missingRequired: string[];
  blockers: OperationBlocker[];
  capabilityGaps: OperationCapabilityGap[];
  effects: OperationEffect[];
  completion: OperationCompletionCheck[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// A candidate reference carries a tenantId AND at least one of the three id fields a real
// ObjectRef/AssetRef/TemplateRef would have — that pair is what distinguishes "this is an attempted
// typed reference" from "this is just some record that happens to carry a tenantId field" (the
// operation's own top-level input, most commonly, which legitimately carries tenantId but is not
// itself a reference).
const REFERENCE_ID_FIELDS = ["objectId", "assetId", "templateId"] as const;
const looksLikeReference = (record: Record<string, unknown>): boolean =>
  typeof record.tenantId === "string" && REFERENCE_ID_FIELDS.some((field) => field in record);

// Depth-bounded scan for reference-shaped values nested anywhere in the (already-merged) input.
// Bounded so a pathological input cannot make this loop unbounded; operation inputs are shallow
// records, not deep trees.
const MAX_REFERENCE_SCAN_DEPTH = 4;
function findCandidateReferences(value: unknown, depth = MAX_REFERENCE_SCAN_DEPTH): unknown[] {
  if (depth < 0 || (!isPlainObject(value) && !Array.isArray(value))) return [];
  if (Array.isArray(value)) return value.flatMap((item) => findCandidateReferences(item, depth - 1));
  const record = value as Record<string, unknown>;
  const found: unknown[] = looksLikeReference(record) ? [record] : [];
  for (const nested of Object.values(record)) found.push(...findCandidateReferences(nested, depth - 1));
  return found;
}

const unknownOperationResult = (request: PreflightRequest, registeredOperationIds: string[]): PreflightResult => ({
  operationId: request.operationId,
  selectedVersion: request.version ?? 0,
  appliedDefaults: {},
  missingRequired: [],
  blockers: [{
    code: "unknown_operation",
    message: `No operation is registered as "${request.operationId}"${request.version !== undefined ? `@${request.version}` : ""}.`,
    remedy: registeredOperationIds.length
      ? `Use one of the registered operation ids: ${registeredOperationIds.join(", ")}.`
      : "No operations are registered in this catalog.",
    blocking: true,
    evidence: { requestedOperationId: request.operationId, requestedVersion: request.version ?? null, registeredOperationIds }
  }],
  capabilityGaps: [],
  effects: [],
  completion: []
});

export function preflightOperation(request: PreflightRequest, deps: PreflightDeps = {}): PreflightResult {
  void deps; // intentionally unused — see module header.

  const lookup = getOperation(request.operationId, request.version);
  if (!lookup.found) return unknownOperationResult(request, lookup.registeredOperationIds);
  const descriptor = lookup.descriptor;

  // A MODEL-PROPOSED PLAN MAY CARRY ANYTHING — an arbitrary tool name, approved:true, a principal,
  // a widened scope. None of it is read here. The only fields ever consulted from `request` are
  // operationId, version, tenantId, input, and configuredCapabilities; every other property a
  // caller supplies (including ones matching field names on OTHER records, like `approved`) is
  // ignored, not merely unused — this function's return value is fully determined by the
  // descriptor plus those five fields.
  const rawInput = isPlainObject(request.input) ? request.input : {};
  const appliedDefaults: Record<string, unknown> = {};
  const mergedInput: Record<string, unknown> = { ...rawInput };
  for (const [key, value] of Object.entries(descriptor.defaults)) {
    if (!(key in rawInput)) {
      mergedInput[key] = value;
      appliedDefaults[key] = value;
    }
  }

  const requiredFields = Array.isArray((descriptor.inputSchema as { required?: unknown }).required)
    ? ((descriptor.inputSchema as { required: unknown[] }).required.filter((field): field is string => typeof field === "string"))
    : [];
  const missingRequired = requiredFields.filter((field) => !(field in mergedInput));

  const blockers: OperationBlocker[] = [];
  const schemaValidation = validateOutput(mergedInput, descriptor.inputSchema);
  if (!schemaValidation.ok) {
    blockers.push({
      code: "input_schema_invalid",
      message: `Input for ${descriptor.operationId}@${descriptor.version} does not satisfy its inputSchema: ${schemaValidation.errors.join("; ")}`,
      remedy: "Correct the listed fields to match the operation's inputSchema (see operation.get) and re-run preflight.",
      blocking: true,
      evidence: { errors: schemaValidation.errors }
    });
  }

  for (const candidate of findCandidateReferences(mergedInput)) {
    const validation = validateReference(candidate, { tenantId: request.tenantId });
    if (!validation.ok) blockers.push(validation.blocker);
  }

  const configuredCapabilities = new Set(
    Array.isArray(request.configuredCapabilities) ? request.configuredCapabilities.filter((entry): entry is string => typeof entry === "string") : []
  );
  const capabilityGaps: OperationCapabilityGap[] = descriptor.requiredCapabilities
    .filter((capability) => !configuredCapabilities.has(capability))
    .map((capability) => ({
      capability,
      requiredBy: descriptor.operationId,
      reason: "not_configured" as const,
      evidence: { requiredCapabilities: descriptor.requiredCapabilities, configuredCapabilities: [...configuredCapabilities] },
      remedy: `Configure "${capability}" for this tenant (see the operation's requiredCapabilities), then re-run preflight to confirm the gap is closed.`
    }));

  return {
    operationId: descriptor.operationId,
    selectedVersion: descriptor.version,
    appliedDefaults,
    missingRequired,
    blockers,
    capabilityGaps,
    effects: descriptor.effects,
    completion: descriptor.completion
  };
}
