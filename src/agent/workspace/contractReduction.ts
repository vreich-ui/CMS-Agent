// F1 (T-2, run_1785352838155_l544ye): contract_intelligence cost $2.57 / 502,397 input tokens with
// maxTurns already capped at 8 — roughly 60K input tokens PER TURN, because the raw fetched contract
// (tens of KB of JSON schema, workflow prose, and error catalogues) got re-sent on every turn of its
// own agent loop. This module does the reduction the node's prompt used to ask an LLM to do, in plain
// deterministic code instead: no model call, no per-turn compounding, and a bounded, predictable
// output shape regardless of how large or verbose a client's raw contract is.
//
// Grounded in a real platform object_contract(content_item) response (fetched live and inspected
// during this fix): a JSON object shaped roughly like
//   { object_type, body_schema (JSON Schema), constraints[] ({id,severity,enforced_live,description}),
//     publish_policy, media_policy, creation_policy, workflow ({sequence[], patch_error_codes,
//     lock_discipline}), patch_ops[] ({op, arg_schema}), auxiliary_inputs[] ({input,when,how}) }.
// Key names are matched defensively across a few common spellings (snake_case, camelCase) rather than
// assumed fixed, since a different client's server can shape its response differently — this is NOT
// the "workspace-local schema" contract_intelligence's own prompt forbids treating as authoritative;
// it is a structural reduction of whatever THIS client returned, this run, nothing invented from
// memory or another client's conventions. Anything this reducer does not recognize is preserved,
// bounded, under `unmapped` rather than silently dropped, so a client with an unfamiliar shape still
// hands downstream nodes something rather than nothing.
//
// `fingerprint` (§2.21): a stable content hash of the RAW contract payload this reduction was built
// from — computed by the one caller that constructs a ContractSource (contractPrefetch.ts) from the
// exact `raw` it fetched, before reduceContract ever sees it. `tool`/`fetchedAtISO` alone prove a
// fetch HAPPENED; they say nothing about WHAT was fetched, so a contract that changed between fetch
// and publish was undetectable. The fingerprint closes that gap and doubles as the cache key for the
// cross-run reduced-contract cache (§2.20, contractPrefetch.ts) — same contract content, same key,
// reuse the reduction instead of recomputing it.
export type ContractSource = { tool: string; fetchedAtISO: string; fingerprint: string };

export type ReducedContract = {
  clientObjectType: string;
  bodySchema: unknown;
  idConventions: Array<{ id: string; severity?: string; note?: string }>;
  mediaConvention: { policy: unknown; notes: Array<{ input: string; how: string }> };
  taxonomy: { notes: Array<{ input: string; how: string }>; blockingConstraints: Array<{ id: string; note?: string }> };
  constraints: Array<{ id: string; severity?: string; enforcedLive?: boolean; note?: string }>;
  publishPolicy: unknown;
  workflowSequence: string[];
  validationSurface: Array<{ op: string; requiredFields: string[]; note?: string }>;
  contractSource: ContractSource;
  // §2.16 — the client-declared aggression CEILING, carried verbatim from the raw contract's
  // top-level aggression_ceiling / aggressionCeiling field (the client-side schema change that adds
  // it is out of scope; this is the engine side reading it). Kept as `unknown` deliberately:
  // resolveAggressionVector (aggressionVector.ts) is the one validator of its shape — all four dials
  // (claim_strength, urgency, emotional_agitation, cta_density) as numbers in [0,1] — and an absent
  // or partial ceiling is a typed blocker there, never a default here.
  aggressionCeiling?: unknown;
  unmapped?: Record<string, unknown>;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const truncate = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const pick = (source: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
};

// Deep JSON Schema and prose text is where the real size lives (the platform example's body_schema
// alone was ~18KB); the schema itself is structural, not prose, so it is kept whole rather than
// truncated — article_body needs its actual required/properties/additionalProperties to conform to.
const extractBodySchema = (raw: Record<string, unknown>): unknown => pick(raw, ["body_schema", "bodySchema", "schema"]);

const extractConstraints = (raw: Record<string, unknown>): ReducedContract["constraints"] => {
  const list = pick(raw, ["constraints", "structural_constraints", "structuralConstraints"]);
  if (!isArray(list)) return [];
  return list.filter(isObject).map((entry) => ({
    id: typeof entry.id === "string" ? entry.id : "unknown",
    severity: typeof entry.severity === "string" ? entry.severity : undefined,
    enforcedLive: typeof (entry.enforced_live ?? entry.enforcedLive) === "boolean" ? Boolean(entry.enforced_live ?? entry.enforcedLive) : undefined,
    // Prose dropped to one bounded note, not the full description paragraph.
    note: truncate(entry.description ?? entry.note, 160)
  }));
};

// id/slug rules live INSIDE the constraints array on the one real client shape seen so far (ids like
// id_object / article_slug / article_node_ids), not as a separate top-level field — so this filters
// the already-extracted constraints rather than assuming a dedicated id_conventions key exists.
const extractIdConventions = (constraints: ReducedContract["constraints"]): ReducedContract["idConventions"] =>
  constraints.filter((entry) => /\bid\b|slug/i.test(entry.id)).map(({ id, severity, note }) => ({ id, severity, note }));

const extractAuxiliaryNotes = (raw: Record<string, unknown>, matcher: RegExp): Array<{ input: string; how: string }> => {
  const list = pick(raw, ["auxiliary_inputs", "auxiliaryInputs"]);
  if (!isArray(list)) return [];
  return list
    .filter(isObject)
    .filter((entry) => matcher.test(`${entry.input ?? ""} ${entry.when ?? ""}`))
    .map((entry) => ({ input: String(entry.input ?? ""), how: truncate(entry.how, 300) ?? "" }));
};

const extractMediaConvention = (raw: Record<string, unknown>): ReducedContract["mediaConvention"] => ({
  policy: pick(raw, ["media_policy", "mediaPolicy"]) ?? null,
  notes: extractAuxiliaryNotes(raw, /image|media|pdf|document/i)
});

const extractTaxonomy = (raw: Record<string, unknown>, constraints: ReducedContract["constraints"]): ReducedContract["taxonomy"] => ({
  notes: extractAuxiliaryNotes(raw, /taxonom/i),
  blockingConstraints: constraints.filter((entry) => /taxonom/i.test(entry.id)).map(({ id, note }) => ({ id, note }))
});

// publish_policy's denial_codes is exactly the "error catalogue" the task calls out to drop; the
// gated/requires_approval/pin_rules facts are what a downstream node actually needs to act on.
const extractPublishPolicy = (raw: Record<string, unknown>): unknown => {
  const policy = pick(raw, ["publish_policy", "publishPolicy"]);
  if (!isObject(policy)) return policy ?? null;
  const { denial_codes: _denialCodes, denialCodes: _denialCodes2, note, ...rest } = policy;
  return { ...rest, ...(truncate(note, 200) ? { note: truncate(note, 200) } : {}) };
};

const extractWorkflowSequence = (raw: Record<string, unknown>): string[] => {
  const workflow = pick(raw, ["workflow"]);
  if (!isObject(workflow)) return [];
  const sequence = pick(workflow, ["sequence", "tool_sequence", "toolSequence"]);
  return isArray(sequence) ? sequence.filter((step): step is string => typeof step === "string") : [];
};

// The bulk of patch_ops' size is each op's recursive arg_schema $defs (a shared any-JSON-value
// definition repeated per op in the real example) — dropped in favor of just the op name and its
// top-level required fields, which is the part a validating downstream node actually checks against.
const extractValidationSurface = (raw: Record<string, unknown>): ReducedContract["validationSurface"] => {
  const ops = pick(raw, ["patch_ops", "patchOps"]);
  if (!isArray(ops)) return [];
  return ops.filter(isObject).map((entry) => {
    const argSchema = isObject(entry.arg_schema ?? entry.argSchema) ? (entry.arg_schema ?? entry.argSchema) as Record<string, unknown> : undefined;
    const required = isArray(argSchema?.required) ? (argSchema!.required as unknown[]).filter((field): field is string => typeof field === "string") : [];
    return { op: typeof entry.op === "string" ? entry.op : "unknown", requiredFields: required, note: truncate(argSchema?.description, 160) };
  });
};

const MAPPED_KEYS = new Set([
  "object_type", "objectType", "body_schema", "bodySchema", "schema", "constraints", "structural_constraints", "structuralConstraints",
  "media_policy", "mediaPolicy", "publish_policy", "publishPolicy", "workflow", "patch_ops", "patchOps", "auxiliary_inputs", "auxiliaryInputs",
  "aggression_ceiling", "aggressionCeiling"
]);

export function reduceContract(raw: unknown, source: ContractSource, requestedObjectType: string): ReducedContract {
  const record = isObject(raw) ? raw : {};
  const constraints = extractConstraints(record);
  const clientObjectType = typeof pick(record, ["object_type", "objectType"]) === "string" ? (pick(record, ["object_type", "objectType"]) as string) : requestedObjectType;
  // Anything the extractors above did not recognize is preserved (bounded) rather than silently
  // dropped — this is what keeps the reducer honest for a client whose shape it does not fully know,
  // matching contract_intelligence's own "say so as an assumption" policy for a silent contract.
  const unmapped = Object.fromEntries(Object.entries(record).filter(([key, value]) => !MAPPED_KEYS.has(key) && value !== undefined).slice(0, 20));
  return {
    clientObjectType,
    bodySchema: extractBodySchema(record) ?? null,
    idConventions: extractIdConventions(constraints),
    mediaConvention: extractMediaConvention(record),
    taxonomy: extractTaxonomy(record, constraints),
    constraints,
    publishPolicy: extractPublishPolicy(record),
    workflowSequence: extractWorkflowSequence(record),
    validationSurface: extractValidationSurface(record),
    contractSource: source,
    ...(pick(record, ["aggression_ceiling", "aggressionCeiling"]) !== undefined ? { aggressionCeiling: pick(record, ["aggression_ceiling", "aggressionCeiling"]) } : {}),
    ...(Object.keys(unmapped).length ? { unmapped } : {})
  };
}
