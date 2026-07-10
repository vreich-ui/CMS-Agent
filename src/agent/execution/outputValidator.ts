export type OutputValidationResult = { ok: true; value: unknown } | { ok: false; errors: string[] };
const typeOf = (value: unknown) => Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
function validateAgainstSchema(value: unknown, schema: any, path = "$", errors: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return errors;
  const expected = schema.type;
  if (expected && expected !== "any") {
    const actual = typeOf(value);
    if (expected === "integer") { if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path} must be integer`); }
    else if (expected === "number") { if (typeof value !== "number") errors.push(`${path} must be number`); }
    else if (expected === "array") { if (!Array.isArray(value)) errors.push(`${path} must be array`); }
    else if (expected === "object") { if (actual !== "object") errors.push(`${path} must be object`); }
    else if (actual !== expected) errors.push(`${path} must be ${expected}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in obj) validateAgainstSchema(obj[key], child, `${path}.${key}`, errors);
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) value.forEach((item, i) => validateAgainstSchema(item, schema.items, `${path}[${i}]`, errors));
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
