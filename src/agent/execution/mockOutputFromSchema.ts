// Mock node output, derived FROM the node's own output schema.
//
// WHY (CHANGE-PLAN R-17, found by T-2)
//
// The mock outputs used to be hand-written literals. When `article_body` was generalized from a baked
// article shape to a contract-driven envelope, its literal was not updated — so a dry run produced an
// object that failed all six required fields of the node's own schema, and (because nothing validated
// it, see R-16) reported `completed` anyway. `publish_payload` had the same defect more quietly: its
// schema requires `summary` and its literal never supplied one.
//
// A hand-written fixture drifts from the schema it is supposed to imitate the moment the schema moves.
// Deriving it from the schema removes the possibility: change the schema and the fixture follows.
//
// FAILS LOUDLY, BY DESIGN
//
// This generator does not attempt to satisfy every JSON Schema construct — that is a research problem,
// not a fixture problem. It covers what the workspace's schemas actually use (const, enum, type,
// required, minLength, minItems, minProperties, numeric bounds, best-effort pattern) and, where it
// cannot satisfy a constraint, produces a value that FAILS validation rather than one that silently
// looks right. The executor then fails the node with the schema issues attached, and
// tests/agent/execution/mockOutputFromSchema.test.ts asserts every canonical node's generated mock
// validates — so a schema this cannot express breaks CI with a precise message instead of producing a
// dry run that proves nothing.

import { validateOutput } from "./outputValidator.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Shallow merge of a combinator branch onto its parent. `required` unions (both apply), `properties`
// merge key-wise, and any other key from the branch wins. Enough for the schemas this repo ships, where
// branches narrow a parent rather than contradict it.
const mergeSchema = (base: Record<string, unknown>, branch: unknown): Record<string, unknown> => {
  if (!isPlainObject(branch)) return base;
  const required = [
    ...(Array.isArray(base.required) ? base.required : []),
    ...(Array.isArray(branch.required) ? branch.required : [])
  ];
  return {
    ...base,
    ...branch,
    ...(required.length ? { required: [...new Set(required)] } : {}),
    ...(isPlainObject(base.properties) || isPlainObject(branch.properties)
      ? { properties: { ...(isPlainObject(base.properties) ? base.properties : {}), ...(isPlainObject(branch.properties) ? branch.properties : {}) } }
      : {})
  };
};

/** Preferred values for named keys, applied only where the schema actually permits them. */
export type MockHints = Record<string, unknown>;

const MOCK_TEXT = "Dry-run mock value";

// A string that satisfies minLength, and — where a pattern is declared — the first candidate that
// matches it. Candidates are deliberately few: this is a fixture generator, not a solver. An
// unsatisfiable pattern falls through to the placeholder and fails validation loudly.
const mockString = (schema: Record<string, unknown>): string => {
  const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
  const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined;
  const pad = (text: string) => (text.length >= minLength ? text : text + "x".repeat(minLength - text.length));

  if (!pattern) return pad(MOCK_TEXT);
  // REVIEW: the last two are appended, never reordered, so no pattern that an earlier candidate
  // already satisfied changes answer. They cover the two shapes the brand-imagery schemas actually
  // declare — a 6-digit hex swatch (`^#[0-9A-Fa-f]{6}$`) and a "W:H" aspect ratio
  // (`^\d{1,2}:\d{1,2}$`) — without which brand_imagery_writer's outputSchema had no satisfiable
  // dry-run value at all and the visual_identity workflow could not be traversed in mock mode.
  for (const candidate of [pad(MOCK_TEXT), "n_mock1", "mock", "mock-1", "mock_1", "1", "a", "#2E5C42", "1:1"]) {
    try {
      if (new RegExp(pattern).test(candidate) && candidate.length >= minLength) return candidate;
    } catch {
      // A malformed pattern cannot be satisfied; fall through and let validation report it.
      break;
    }
  }
  return pad(MOCK_TEXT);
};

const mockNumber = (schema: Record<string, unknown>, integer: boolean): number => {
  const min = typeof schema.minimum === "number" ? schema.minimum : typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum + (integer ? 1 : 0.1) : 1;
  const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
  const value = max !== undefined && min > max ? max : min;
  return integer ? Math.ceil(value) : value;
};

const declaredType = (schema: Record<string, unknown>): string => {
  const type = schema.type;
  if (typeof type === "string") return type;
  // A union like {"type":["object","boolean"]} — take the first, which is the shape callers mean.
  if (Array.isArray(type) && typeof type[0] === "string") return type[0];
  // No declared type but declared properties means object in every schema this repo ships.
  if (isPlainObject(schema.properties) || Array.isArray(schema.required)) return "object";
  return "object";
};

export function mockValueFromSchema(schema: unknown, hints: MockHints = {}): unknown {
  // Boolean schemas: `true` permits anything, `false` permits nothing.
  if (schema === true) return {};
  if (schema === false) return undefined;
  if (!isPlainObject(schema)) return {};

  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  // allOf — every branch applies at once, so merge them all and generate from the result.
  if (Array.isArray(schema.allOf)) {
    const merged = schema.allOf.reduce<Record<string, unknown>>((accumulated, branch) => mergeSchema(accumulated, branch), { ...schema, allOf: undefined });
    return mockValueFromSchema(merged, hints);
  }

  // anyOf / oneOf — only ONE branch has to hold, and which one is satisfiable is not something to guess
  // at. So generate a candidate per branch and let the REAL validator decide, against the full schema
  // (siblings, dependentRequired, nested if/then and all). First candidate that validates wins.
  //
  // This is the gap that shipped in the first version of this file: `article_body`'s legacy monolith
  // declares `public: { anyOf: [{required:["eyebrow"]}, {required:["title"]}, …] }`, and without this
  // the generator emitted `public: {}` — which fails, loudly but uselessly.
  for (const combinator of ["anyOf", "oneOf"] as const) {
    const branches = schema[combinator];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const base = { ...schema, anyOf: undefined, oneOf: undefined };
    const candidates = branches.map((branch) => mockValueFromSchema(mergeSchema(base, branch), hints));
    const satisfying = candidates.find((candidate) => validateOutput(candidate, schema).ok);
    // No branch satisfiable: return the first candidate so validation reports the real constraint rather
    // than the generator's failure to choose.
    return satisfying ?? candidates[0];
  }

  switch (declaredType(schema)) {
    case "string":
      return mockString(schema);
    case "integer":
      return mockNumber(schema, true);
    case "number":
      return mockNumber(schema, false);
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
      if (minItems <= 0) return [];
      const items = schema.items;
      return Array.from({ length: minItems }, () => mockValueFromSchema(items, hints));
    }
    default:
      break;
  }

  // Object.
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  const closed = schema.additionalProperties === false;
  const result: Record<string, unknown> = {};

  // Every required property, recursed. An unknown required key (declared required but with no schema)
  // still gets a value, because omitting it would fail validation for a reason the generator caused.
  for (const key of required) {
    result[key] = key in properties ? mockValueFromSchema(properties[key], hints) : (hints[key] ?? MOCK_TEXT);
  }

  // Hints are the dry-run markers a reader expects (`dryRun`, `nodeId`, …) and any per-node extras.
  // They are applied only where the schema permits: a declared property always, an undeclared one only
  // when the object is open. A strict schema must not be polluted to make a fixture friendlier.
  for (const [key, value] of Object.entries(hints)) {
    if (key in properties || !closed) result[key] = value;
  }

  // minProperties can require more keys than `required` names.
  const minProperties = typeof schema.minProperties === "number" ? schema.minProperties : 0;
  if (Object.keys(result).length < minProperties) {
    const spare = Object.keys(properties).filter((key) => !(key in result));
    for (const key of spare) {
      if (Object.keys(result).length >= minProperties) break;
      result[key] = mockValueFromSchema(properties[key], hints);
    }
    // REVIEW: an object closed by `additionalProperties: false` but opened by `patternProperties` is
    // not "closed" in the sense this branch meant — it accepts any key matching a declared pattern,
    // which is exactly how a keyed map (brandImagery.aspectRatios: context key -> "W:H" ratio) is
    // spelled in the draft-2020-12 subset outputValidator.ts implements. `properties` is empty for
    // such an object, so `spare` above is empty and the old code left it short forever: no dry-run
    // value could satisfy `minProperties: 1`, and the node failed its own output schema in mock mode.
    // Filled from the pattern itself — a key mockString derives from the KEY pattern, a value from
    // that pattern's own subschema — so nothing is invented that the schema would not accept.
    const patternProperties = isPlainObject(schema.patternProperties) ? schema.patternProperties : undefined;
    if (patternProperties && Object.keys(result).length < minProperties) {
      for (const [keyPattern, child] of Object.entries(patternProperties)) {
        if (Object.keys(result).length >= minProperties) break;
        const key = mockString({ pattern: keyPattern });
        try {
          if (!new RegExp(keyPattern).test(key) || key in result) continue;
        } catch {
          continue;
        }
        result[key] = mockValueFromSchema(child, hints);
      }
    }
    // Still short, and the object is open: synthesize filler keys. If it is closed, leave it short so
    // validation reports the real problem rather than the generator inventing fields.
    for (let index = 0; Object.keys(result).length < minProperties && !closed; index += 1) {
      result[`mockField${index}`] = MOCK_TEXT;
    }
  }

  return result;
}
