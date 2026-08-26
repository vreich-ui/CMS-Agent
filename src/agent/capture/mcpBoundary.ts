// T13.4 — THE boundary adapter. One module owns every translation between clone-engine vocabulary
// and MCP wire vocabulary, in BOTH directions, for every remote platform tool cloneEngine.ts calls.
//
// WHY THIS FILE EXISTS (see /root/T13.4-SPEC.md): three separate defects across three rounds were
// ONE bug, patched one instance at a time —
//   - a template design's `applies_to` vs. the platform's `appliesTo`
//   - a recipe's `when_to_use` vs. the platform's `whenToUse` (arrived as "")
//   - object_checkout's RESPONSE: the engine read `lock_token`; the platform returns `lockToken`.
//     The third one was live: object_checkout SUCCEEDED server-side (a lock was issued), the engine
//     read `undefined` for its token, threw, never patched the theme, and LEAKED the lock for the
//     full 15-minute lease.
// Patching a fourth instance one call site at a time is the wrong move. This module is the single
// place a field name crosses the wire, so the next instance of this bug class cannot exist: there is
// nowhere else left to author it.
//
// THE ENVELOPE / BODY DISTINCTION (the whole job, and the place a fix here can do real damage):
//   - The ENVELOPE — object_type, object_id, lock_token, requested_id, site, and the handful of
//     other fields that select and address a call — is the platform's own wire grammar and is
//     snake_case.
//   - The BODY (object_create's `body`, object_patch's `ops`) is per-object-type PLATFORM CONTENT.
//     Its real field names are whatever that type's schema says — often camelCase (`whenToUse`,
//     `appliesTo`, `brandTokens`) — and are NOT part of this boundary's vocabulary at all. Rewriting
//     a key inside a body would corrupt every object the workflow writes; recipeBody()
//     (engine/clone.mjs) already builds bodies in the platform's own camelCase, and object_patch's
//     `ops` carry the C§2.0 patch grammar verbatim (objectDialect.ts's own comment on
//     buildArticleCandidatePatch explains why `ops` content is likewise never touched here).
// So this module works from an EXPLICIT PER-TOOL ALLOWLIST of envelope field names — never a
// blanket recursive case transform — and any field named `body` or `ops` is carried through
// byte-identical, never walked into. See TOOL_WIRE_SPECS below.
//
// SCOPE: only the tools callProjectTool actually calls are registered here (registry_get,
// object_inventory, object_get, object_create, object_checkout, object_checkin, object_patch,
// site_apply_theme). Calling toWireArguments/fromWireResult with an unregistered tool name is a
// typed refusal, not a silent pass-through — a ninth verb showing up here unregistered is exactly
// the kind of thing that must fail loudly during development, not ship a call this module never
// actually checked.
//
// T15.34 (#210; ADR-2026-08-25-structure-studio §7) added the four pdf-tool bridge verbs
// (create_pdf_template, validate_pdf_template, get_pdf_template_validation, publish_pdf_template) —
// pdfTemplateEngine.ts's OWN call site, alongside cloneEngine.ts's. THE DISCIPLINE IS SHARED, THE
// TRANSPORT IS NOT: this module is still the one place any field name crosses the wire for EITHER
// caller, so a pdf-tool argument gets the identical typed-refusal-over-guess treatment a CMS object
// verb gets — but the four pdf-tool entries are a wholly separate vocabulary (site_id/template_id/
// template_json/...) from the CMS object verbs above them, addressing pdf-tool's own
// pdf-template-store, never object_publish/object_create or anything CMS-governed. Every field name
// below is copied verbatim from the live tool schemas (mcp__*__create_pdf_template et al.), not
// paraphrased.
//
// SCHEMA PROVENANCE: docs/mcp-tool-manifest.json — the two-plane drift lock — does NOT carry these
// schemas. It fingerprints CMS-Agent's OWN served tool surface (workspace_*, project_*, agent_*, ...)
// by inputSchemaHash only, to catch the Netlify/Cloud-Run planes drifting from each other; it never
// lists object_checkout/object_create at all (they are the PLATFORM's remote surface, reached through
// project_call_tool, not a tool CMS-Agent itself serves). The conformance test
// (tests/agent/capture/mcpBoundaryConformance.test.ts) validates this module's output against the
// real platform schemas instead, captured verbatim into
// tests/agent/capture/fixtures/platformToolSchemas.ts — see that fixture's own header for exactly
// where those came from and why.

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

export class McpBoundaryError extends Error {
  constructor(readonly tool: string, readonly field: string | undefined, message: string) {
    super(message);
    this.name = "McpBoundaryError";
  }
}

// One envelope field: the clone-engine (camelCase) name this module accepts, and the wire
// (snake_case) name it produces — copied verbatim from the tool's real schema, never paraphrased.
// `opaque: true` marks a field whose VALUE is per-type platform content (`body`, `ops`): the field
// itself is still an envelope slot (it gets positioned under its wire name like any other), but
// nothing here ever looks at, renames, or recurses into what is inside it.
type EnvelopeField = { engine: string; wire: string; opaque?: boolean };
type ToolWireSpec = { fields: EnvelopeField[]; required: string[] };

// The allowlist. One entry per tool cloneEngine.ts calls, fields listed exactly as
// tests/agent/capture/fixtures/platformToolSchemas.ts's verbatim copy of each tool's real schema
// names them (wire side) alongside this module's chosen camelCase engine name. `required` is that
// same real schema's own `required` array, copied verbatim — this is what lets toWireArguments
// refuse a call that is missing a field the platform will reject, BEFORE it ever reaches the wire
// (the object_create/`site` case T13.4-SPEC.md calls out by name: `required: ["object_type","site",
// "body"]`, and the mint plan never supplied one).
const TOOL_WIRE_SPECS: Record<string, ToolWireSpec> = {
  registry_get: {
    fields: [{ engine: "registry", wire: "registry" }],
    required: []
  },
  object_inventory: {
    fields: [
      { engine: "objectId", wire: "object_id" },
      { engine: "objectType", wire: "object_type" },
      { engine: "pendingChanges", wire: "pending_changes" },
      { engine: "requiresApproval", wire: "requires_approval" },
      { engine: "reviewState", wire: "review_state" },
      { engine: "status", wire: "status" }
    ],
    required: []
  },
  object_get: {
    fields: [
      { engine: "objectId", wire: "object_id" },
      { engine: "objectType", wire: "object_type" }
    ],
    required: ["object_type", "object_id"]
  },
  object_create: {
    fields: [
      { engine: "agentName", wire: "agent_name" },
      { engine: "body", wire: "body", opaque: true },
      { engine: "idempotencyKey", wire: "idempotency_key" },
      { engine: "objectType", wire: "object_type" },
      { engine: "requestedId", wire: "requested_id" },
      { engine: "site", wire: "site" }
    ],
    required: ["object_type", "site", "body"]
  },
  object_checkout: {
    fields: [
      { engine: "leaseSeconds", wire: "lease_seconds" },
      { engine: "objectId", wire: "object_id" },
      { engine: "objectType", wire: "object_type" }
    ],
    required: ["object_type", "object_id"]
  },
  object_checkin: {
    fields: [
      { engine: "lockToken", wire: "lock_token" },
      { engine: "objectId", wire: "object_id" },
      { engine: "objectType", wire: "object_type" }
    ],
    required: ["object_type", "object_id", "lock_token"]
  },
  object_patch: {
    fields: [
      { engine: "expectedRecordVersion", wire: "expected_record_version" },
      { engine: "lockToken", wire: "lock_token" },
      { engine: "objectId", wire: "object_id" },
      { engine: "objectType", wire: "object_type" },
      { engine: "ops", wire: "ops", opaque: true }
    ],
    required: ["object_type", "object_id", "lock_token", "expected_record_version", "ops"]
  },
  site_apply_theme: {
    fields: [
      { engine: "agentName", wire: "agent_name" },
      { engine: "dryRun", wire: "dry_run" },
      { engine: "expectedRecordVersion", wire: "expected_record_version" },
      { engine: "lockToken", wire: "lock_token" },
      { engine: "siteId", wire: "site_id" },
      { engine: "themeId", wire: "theme_id" }
    ],
    required: ["theme_id", "site_id"]
  },
  // T15.34 (#210) — the pdf-tool bridge verbs. `templateJson` and `data` are opaque (per-renderer
  // pdf-tool content, exactly like object_create's `body` above — never renamed or walked into).
  create_pdf_template: {
    fields: [
      { engine: "siteId", wire: "site_id" },
      { engine: "templateJson", wire: "template_json", opaque: true },
      { engine: "renderer", wire: "renderer" },
      { engine: "templateId", wire: "template_id" },
      { engine: "label", wire: "label" },
      { engine: "tags", wire: "tags" },
      { engine: "idempotencyKey", wire: "idempotency_key" }
    ],
    required: ["site_id", "template_json"]
  },
  validate_pdf_template: {
    fields: [
      { engine: "siteId", wire: "site_id" },
      { engine: "templateId", wire: "template_id" },
      { engine: "version", wire: "version" },
      { engine: "data", wire: "data", opaque: true }
    ],
    required: ["site_id", "template_id", "data"]
  },
  get_pdf_template_validation: {
    fields: [
      { engine: "siteId", wire: "site_id" },
      { engine: "templateId", wire: "template_id" },
      { engine: "version", wire: "version" },
      { engine: "validationId", wire: "validation_id" }
    ],
    required: ["site_id", "template_id"]
  },
  publish_pdf_template: {
    fields: [
      { engine: "siteId", wire: "site_id" },
      { engine: "templateId", wire: "template_id" },
      { engine: "version", wire: "version" }
    ],
    required: ["site_id", "template_id"]
  }
};

// ---------------------------------------------------------------------------------------------
// Request: engine object -> wire arguments.
//
// Each field is read under EITHER its engine (camelCase) name OR, when that differs, its wire
// (snake_case) name — never both silently: a caller that supplies both with different values is a
// programmer error and is refused, not guessed at. Dual acceptance on the INPUT side (never on the
// output side, which is always canonical snake_case) exists because this module has two honest
// callers: cloneEngine.ts's own call sites (written in engine camelCase, e.g. `{ objectType,
// objectId }`) and engine/clone.mjs's pure plan builders (buildThemeApplyPlan's `step.arguments`),
// which construct their steps already snake_case because CLONE-ENGINE-API.md's own worked examples
// write them that way — cloneEngine.ts passes those straight through without re-authoring them, and
// this function still has to make sense of them.
//
// Any argument key that is neither a field's engine name nor its wire name is a typed refusal, not a
// silently dropped or silently forwarded field: an unrecognized key is far more likely a miscased
// mistake (the exact bug class this module exists to end) than a deliberate new field, and letting it
// through would either violate the platform's `additionalProperties: false` at the wire or, worse,
// collide with nothing and vanish.
export function toWireArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const spec = TOOL_WIRE_SPECS[tool];
  if (!spec) {
    throw new McpBoundaryError(
      tool,
      undefined,
      `mcpBoundary has no envelope mapping registered for "${tool}". Every tool callProjectTool can reach must be listed in TOOL_WIRE_SPECS explicitly — an unregistered tool is refused here rather than sent to the wire unchecked.`
    );
  }

  const wire: Record<string, unknown> = {};
  const consumedKeys = new Set<string>();
  for (const field of spec.fields) {
    const engineHas = Object.prototype.hasOwnProperty.call(args, field.engine) && isPresent(args[field.engine]);
    const wireHas = field.wire !== field.engine && Object.prototype.hasOwnProperty.call(args, field.wire) && isPresent(args[field.wire]);
    if (engineHas && wireHas && args[field.engine] !== args[field.wire]) {
      throw new McpBoundaryError(tool, field.wire, `${tool}: both "${field.engine}" and "${field.wire}" were supplied with different values; a field must be given once.`);
    }
    if (engineHas) {
      wire[field.wire] = args[field.engine];
      consumedKeys.add(field.engine);
    } else if (wireHas) {
      wire[field.wire] = args[field.wire];
      consumedKeys.add(field.wire);
    }
  }

  const unrecognized = Object.keys(args).filter((key) => isPresent(args[key]) && !consumedKeys.has(key));
  if (unrecognized.length > 0) {
    const known = spec.fields.map((field) => field.engine).join(", ");
    throw new McpBoundaryError(tool, unrecognized[0], `${tool}: unrecognized argument(s) [${unrecognized.join(", ")}]. mcpBoundary's allowlist for this tool is {${known}} — a misspelled or wrongly-cased field must fail loudly here, never travel to the wire and be rejected (or silently dropped) by the platform's additionalProperties:false schema.`);
  }

  for (const requiredWireKey of spec.required) {
    if (!isPresent(wire[requiredWireKey])) {
      throw new McpBoundaryError(
        tool,
        requiredWireKey,
        `${tool} requires "${requiredWireKey}" but it was not supplied. Never construct an invalid call: this must be a typed refusal naming the tool and the field, not a request the platform rejects with "400: Invalid request fields".`
      );
    }
  }

  return wire;
}

// ---------------------------------------------------------------------------------------------
// Response: wire result -> engine object.
//
// Most of these tools' results are passed straight through: object_get's `record.body`,
// object_inventory's rows, registry_get's registries are all per-type PLATFORM CONTENT (the same
// "never rewrite a body" law as the request side) that cloneEngine.ts's own recordOf/bodyOf helpers
// and engine/clone.mjs's own tolerant row readers (recipeRowField, brandTokensFromSiteBody, ...)
// already know how to read in the platform's own shape — canonicalizing their casing here would
// silently BREAK those readers rather than fix anything.
//
// The one tool this module actually has to read is object_checkout: the live incident evidence is a
// real response shaped `{"action":"checkout","lockToken":"361cb72b-...","lock":{...},
// "record_version":52}` — `lockToken` camelCase sitting next to `record_version` snake_case IN THE
// SAME RESPONSE. That inconsistency is the platform's; this function absorbs it once, here, so
// nothing downstream has to guess which casing it will get on any given call. A result that carries
// NEITHER `lockToken` nor `lock_token` is a typed refusal naming the tool — never `undefined` handed
// back to a caller that will only notice three steps later (this is precisely how a real checkout
// once leaked its lock for a full 15-minute lease: the platform's response was fine, only the reader
// was wrong).
type ResultField = { engine: string; wireNames: string[]; required?: boolean };
type ToolResultSpec = { fields: ResultField[] };

const TOOL_RESULT_SPECS: Record<string, ToolResultSpec> = {
  object_checkout: {
    fields: [
      { engine: "lockToken", wireNames: ["lockToken", "lock_token"], required: true },
      { engine: "recordVersion", wireNames: ["recordVersion", "record_version"], required: false }
    ]
  }
};

// Bounded-depth search for ONE of a short list of NAMED candidate keys. This is intentionally not a
// generic deep-key walk: it never descends into a `body` (per-type content is never this boundary's
// business), and it only ever looks for the handful of fields TOOL_RESULT_SPECS names — the same
// explicit-allowlist posture as the request side, just applied to reading instead of writing.
function findEnvelopeValue(value: unknown, names: string[], depth = 0): unknown {
  if (depth > 4 || !isRecord(value)) return undefined;
  for (const name of names) {
    if (isPresent(value[name])) return value[name];
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "body") continue;
    const found = findEnvelopeValue(child, names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function fromWireResult(tool: string, result: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = isRecord(result) ? { ...result } : {};
  const spec = TOOL_RESULT_SPECS[tool];
  if (!spec) return record;

  for (const field of spec.fields) {
    const value = findEnvelopeValue(record, field.wireNames);
    if (value !== undefined) {
      record[field.engine] = value;
    } else if (field.required) {
      throw new McpBoundaryError(
        tool,
        field.engine,
        `${tool}'s result carried none of [${field.wireNames.join(", ")}]; refusing rather than letting a missing token flow onward as undefined (T13.4: this is exactly how a successful object_checkout once leaked its lock — the wire call succeeded and the reader still came away empty-handed).`
      );
    }
  }
  return record;
}

// Test-only seam, following cloneEngine.ts's own __test__ precedent.
export const __test__ = { TOOL_WIRE_SPECS, TOOL_RESULT_SPECS, findEnvelopeValue };
