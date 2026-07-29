// Structural compatibility between a node's output schema and an assigned skill's.
//
// R-2. The previous check was `JSON.stringify(nodeSchema) !== JSON.stringify(skillSchema)`, with a
// single escape hatch for a bare {"type":"object"} on either side. Exact text equality is not a
// compatibility test: it reports a blocker for any skill schema that is merely *different* — a
// reordered key, an added description, a narrower-but-agreeing property — and it reports agreement
// only when the two are byte-identical. The cost was not theoretical: 7 of the 12 seeded skills had
// their outputSchema flattened to the {"type":"object"} placeholder purely to slip through the
// escape hatch, and those are exactly the seven that are actually assigned to nodes. The check
// designed to protect the contract-path nodes was the reason they had no contract.
//
// What compatibility actually means here: a skill's outputSchema is a CONSTRAINT layered on the
// node's own output, so the pair is compatible unless they genuinely contradict — a value could
// exist that satisfies both. This walks the two schemas structurally and reports only real
// contradictions:
//
//   - declared `type`s that cannot both hold (object vs array, string vs number, ...);
//   - a property declared on both sides whose types contradict, recursively;
//   - array `items` that contradict, recursively;
//   - a property the skill REQUIRES that the node's schema forbids outright (the node declares
//     `properties` and `additionalProperties: false` without it) — nothing could satisfy both;
//   - contradictory `enum` sets (disjoint value sets on the same property).
//
// Everything else — extra properties, differing descriptions, one side silent about a field, one
// side unconstrained — is compatible, because it is. An absent or empty schema constrains nothing.

export type SchemaCompatibility = { compatible: true } | { compatible: false; reasons: string[] };

type JsonSchema = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonSchema => typeof value === "object" && value !== null && !Array.isArray(value);

// A schema that constrains nothing: absent, empty, or a bare type declaration with no shape.
const isUnconstrained = (schema: unknown): boolean => {
  if (!isRecord(schema)) return true;
  const meaningful = Object.keys(schema).filter((key) => key !== "$schema" && key !== "title" && key !== "description");
  if (meaningful.length === 0) return true;
  return meaningful.length === 1 && meaningful[0] === "type" && (schema.type === "object" || schema.type === "array");
};

const typesOf = (schema: JsonSchema): string[] | undefined => {
  const declared = schema.type;
  if (typeof declared === "string") return [declared];
  if (Array.isArray(declared) && declared.every((entry) => typeof entry === "string")) return declared as string[];
  return undefined;
};

// "integer" satisfies "number"; everything else must match by name.
const typesOverlap = (left: string[], right: string[]): boolean =>
  left.some((a) => right.some((b) => a === b || (a === "integer" && b === "number") || (a === "number" && b === "integer")));

const enumOf = (schema: JsonSchema): unknown[] | undefined => (Array.isArray(schema.enum) ? schema.enum : undefined);

const propertiesOf = (schema: JsonSchema): JsonSchema | undefined => (isRecord(schema.properties) ? schema.properties : undefined);

const requiredOf = (schema: JsonSchema): string[] => (Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []);

const path = (segments: string[]) => (segments.length ? segments.join(".") : "$");

const walk = (nodeSchema: unknown, skillSchema: unknown, segments: string[], reasons: string[]): void => {
  if (isUnconstrained(nodeSchema) || isUnconstrained(skillSchema)) return;
  if (!isRecord(nodeSchema) || !isRecord(skillSchema)) return;

  const nodeTypes = typesOf(nodeSchema);
  const skillTypes = typesOf(skillSchema);
  if (nodeTypes && skillTypes && !typesOverlap(nodeTypes, skillTypes)) {
    reasons.push(`${path(segments)}: node declares type ${nodeTypes.join("|")} but the skill declares ${skillTypes.join("|")} — no value satisfies both.`);
    return;
  }

  const nodeEnum = enumOf(nodeSchema);
  const skillEnum = enumOf(skillSchema);
  if (nodeEnum && skillEnum && !skillEnum.some((value) => nodeEnum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)))) {
    reasons.push(`${path(segments)}: node enum and skill enum are disjoint — no value satisfies both.`);
  }

  const nodeProperties = propertiesOf(nodeSchema);
  const skillProperties = propertiesOf(skillSchema);

  // A property the skill requires that the node's schema forbids outright is a genuine contradiction:
  // the node can never emit it, so the skill can never be satisfied.
  if (nodeProperties && nodeSchema.additionalProperties === false) {
    for (const name of requiredOf(skillSchema)) {
      if (!(name in nodeProperties)) reasons.push(`${path([...segments, name])}: the skill requires this property but the node's schema declares additionalProperties:false without it, so the node can never produce it.`);
    }
  }

  if (nodeProperties && skillProperties) {
    for (const [name, skillProperty] of Object.entries(skillProperties)) {
      if (name in nodeProperties) walk(nodeProperties[name], skillProperty, [...segments, name], reasons);
    }
  }

  if (nodeSchema.items !== undefined && skillSchema.items !== undefined) walk(nodeSchema.items, skillSchema.items, [...segments, "items"], reasons);
};

export function checkSchemaCompatibility(nodeSchema: unknown, skillSchema: unknown): SchemaCompatibility {
  const reasons: string[] = [];
  walk(nodeSchema, skillSchema, [], reasons);
  return reasons.length ? { compatible: false, reasons } : { compatible: true };
}
