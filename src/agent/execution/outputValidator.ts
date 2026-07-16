export type OutputValidationResult = { ok: true; value: unknown } | { ok: false; errors: string[] };

type JsonSchema = Record<string, any>;

const typeOf = (value: unknown) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

// Structural equality for enum/const comparison. Our schemas use primitive const/enum values, but a
// JSON-serialized comparison also handles object/array literals without reference-equality surprises.
const deepEqual = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

const matchesType = (value: unknown, expected: string): boolean => {
  if (expected === "any") return true;
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number";
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return typeOf(value) === "object";
  if (expected === "null") return value === null;
  return typeOf(value) === expected;
};

// Compile a schema `pattern` once per call. A malformed pattern never validates (returns false) so a
// bad schema fails closed rather than throwing out of validation.
const patternMatches = (pattern: string, value: string): boolean => {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
};

const hasUniqueItems = (items: unknown[]): boolean => {
  const seen = new Set<string>();
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
};

// Validate `value` against `schema` in isolation and return the collected errors. Used by the
// combinator keywords (anyOf/oneOf/not/if) which must probe a subschema without polluting the parent
// error list.
const collect = (value: unknown, schema: unknown, path: string): string[] => {
  const errors: string[] = [];
  validateNode(value, schema, path, errors);
  return errors;
};

// Recursive JSON Schema (draft 2020-12 subset) validator. Supports the keywords the workspace node
// output schemas actually use: type/enum/const, object (required, properties, patternProperties,
// additionalProperties, dependentRequired), array (items, prefixItems, minItems, maxItems,
// uniqueItems), string (minLength, maxLength, pattern), number (minimum/maximum/exclusive*,
// multipleOf), and the applicators allOf/anyOf/oneOf/not and if/then/else. Enforcement is consistent
// at every nesting depth, so a constraint on article_body.nodes[].public.media.src is checked exactly
// like a top-level one.
function validateNode(value: unknown, schema: unknown, path: string, errors: string[]): void {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    errors.push(`${path} is not allowed`);
    return;
  }
  if (typeof schema !== "object") return;
  const node = schema as JsonSchema;

  const expected = node.type;
  if (expected !== undefined && expected !== "any") {
    const types = Array.isArray(expected) ? expected : [expected];
    if (!types.some((candidate) => matchesType(value, candidate))) errors.push(`${path} must be ${types.join(" or ")}`);
  }

  if (node.enum && !node.enum.some((option: unknown) => deepEqual(option, value))) errors.push(`${path} must be one of ${node.enum.map((option: unknown) => JSON.stringify(option)).join(", ")}`);
  if (node.const !== undefined && !deepEqual(node.const, value)) errors.push(`${path} must equal ${JSON.stringify(node.const)}`);

  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) errors.push(`${path} must have at least ${node.minLength} character(s)`);
    if (typeof node.maxLength === "number" && value.length > node.maxLength) errors.push(`${path} must have at most ${node.maxLength} character(s)`);
    if (typeof node.pattern === "string" && !patternMatches(node.pattern, value)) errors.push(`${path} must match pattern ${node.pattern}`);
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) errors.push(`${path} must be >= ${node.minimum}`);
    if (typeof node.maximum === "number" && value > node.maximum) errors.push(`${path} must be <= ${node.maximum}`);
    if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) errors.push(`${path} must be > ${node.exclusiveMinimum}`);
    if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) errors.push(`${path} must be < ${node.exclusiveMaximum}`);
    if (typeof node.multipleOf === "number" && node.multipleOf > 0 && !Number.isInteger(value / node.multipleOf)) errors.push(`${path} must be a multiple of ${node.multipleOf}`);
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) errors.push(`${path} must contain at least ${node.minItems} item(s)`);
    if (typeof node.maxItems === "number" && value.length > node.maxItems) errors.push(`${path} must contain at most ${node.maxItems} item(s)`);
    if (node.uniqueItems === true && !hasUniqueItems(value)) errors.push(`${path} items must be unique`);
    // prefixItems (draft 2020-12) or a tuple-style items array: positional schemas, with `items`
    // (object form) / additionalItems validating the tail.
    const tuple = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : undefined;
    if (tuple) {
      tuple.forEach((sub: unknown, index: number) => { if (index < value.length) validateNode(value[index], sub, `${path}[${index}]`, errors); });
      const rest = node.items && !Array.isArray(node.items) ? node.items : node.additionalItems;
      if (rest && typeof rest === "object") value.slice(tuple.length).forEach((item, index) => validateNode(item, rest, `${path}[${tuple.length + index}]`, errors));
    } else if (node.items && typeof node.items === "object") {
      value.forEach((item, index) => validateNode(item, node.items, `${path}[${index}]`, errors));
    }
  }

  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    for (const key of node.required ?? []) if (!(key in object)) errors.push(`${path}.${key} is required`);
    const properties: Record<string, unknown> = node.properties ?? {};
    for (const [key, child] of Object.entries(properties)) if (key in object) validateNode(object[key], child, `${path}.${key}`, errors);
    const patternProperties: Record<string, unknown> = node.patternProperties ?? {};
    for (const [pattern, child] of Object.entries(patternProperties)) {
      for (const [key, entry] of Object.entries(object)) if (patternMatches(pattern, key)) validateNode(entry, child, `${path}.${key}`, errors);
    }
    for (const [key, dependents] of Object.entries(node.dependentRequired ?? {})) {
      if (key in object) for (const dependent of dependents as string[]) if (!(dependent in object)) errors.push(`${path}.${dependent} is required when ${key} is present`);
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== true) {
      const known = new Set(Object.keys(properties));
      const patternKeys = Object.keys(patternProperties);
      for (const key of Object.keys(object)) {
        if (known.has(key) || patternKeys.some((pattern) => patternMatches(pattern, key))) continue;
        if (node.additionalProperties === false) errors.push(`${path}.${key} is not an allowed property`);
        else validateNode(object[key], node.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }

  if (Array.isArray(node.allOf)) node.allOf.forEach((sub: unknown) => validateNode(value, sub, path, errors));
  if (Array.isArray(node.anyOf) && !node.anyOf.some((sub: unknown) => collect(value, sub, path).length === 0)) errors.push(`${path} must match at least one allowed schema`);
  if (Array.isArray(node.oneOf)) {
    const matched = node.oneOf.filter((sub: unknown) => collect(value, sub, path).length === 0).length;
    if (matched !== 1) errors.push(`${path} must match exactly one allowed schema (matched ${matched})`);
  }
  if (node.not !== undefined && collect(value, node.not, path).length === 0) errors.push(`${path} must not match the excluded schema`);
  if (node.if !== undefined) {
    const ifSatisfied = collect(value, node.if, path).length === 0;
    if (ifSatisfied && node.then !== undefined) validateNode(value, node.then, path, errors);
    if (!ifSatisfied && node.else !== undefined) validateNode(value, node.else, path, errors);
  }
}

function validateAgainstSchema(value: unknown, schema: unknown, path = "$"): string[] {
  const errors: string[] = [];
  validateNode(value, schema, path, errors);
  return errors;
}

export function safeParseJson(value: unknown): OutputValidationResult {
  if (typeof value !== "string") return { ok: true, value };
  try { return { ok: true, value: JSON.parse(value) }; } catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "invalid_json"] }; }
}

export function validateOutput(value: unknown, outputSchema: unknown): OutputValidationResult {
  const parsed = safeParseJson(value);
  if (!parsed.ok) return parsed;
  const schema = outputSchema && typeof outputSchema === "object" && (outputSchema as any).type === "json_schema" ? (outputSchema as any).schema : outputSchema;
  const errors = validateAgainstSchema(parsed.value, schema);
  return errors.length ? { ok: false, errors } : { ok: true, value: parsed.value };
}
