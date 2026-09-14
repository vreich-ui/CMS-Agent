// The dry-run fixture generator and JSON Schema CONDITIONALS (`if` / `then` / `else`).
//
// THE DEFECT, as it actually shipped. monetization_strategy's `evFloor` is a conditional:
//
//   if   clusterRole === "supporting_asset"
//   then supportingFor is a non-empty string
//   else supportingFor is null
//
// `supportingFor`'s base type is ["string","null"], so the generator picked "string", while
// `clusterRole` came from its own enum as "money_page" — which selects the `else` branch and demands
// null. Every mock dispatch of that node failed its own outputSchema with
// `$.evFloor.supportingFor must be null`, and because the executor leaves a schema-violating node
// `failed`, a dry run stalled there and never reached the publishing tail at all.
//
// This is a LIVE defect, not one canonical introduced: the conditional lives on the node's STORED
// schema, and metadata/schema are store-owned, so store-sourced mock runs have been hitting it
// independently of what nodes.ts says. mockOutputFromSchema.ts already resolved allOf/anyOf/oneOf by
// generating a candidate per branch and letting the real validator choose; `if`/`then`/`else` simply
// was not in that list. These tests hold it there.
import { describe, expect, it } from "vitest";
import { mockValueFromSchema } from "../../../src/agent/execution/mockOutputFromSchema.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";

// The real shape, reduced to the part that matters.
const EV_FLOOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clusterRole", "supportingFor"],
  properties: {
    clusterRole: { type: "string", enum: ["money_page", "supporting_asset", "unattached"] },
    supportingFor: { type: ["string", "null"] }
  },
  if: { properties: { clusterRole: { const: "supporting_asset" } } },
  then: { properties: { supportingFor: { type: "string", minLength: 1 } } },
  else: { properties: { supportingFor: { type: "null" } } }
};

describe("mockValueFromSchema — if/then/else", () => {
  it("generates a value that satisfies the conditional it was generated from", () => {
    const value = mockValueFromSchema(EV_FLOOR_SCHEMA);

    // The assertion that matters: the generator's own output passes the real validator. Which branch
    // it lands on is not the point and is deliberately not pinned.
    expect(validateOutput(value, EV_FLOOR_SCHEMA).ok).toBe(true);
  });

  it("honours the `else` branch when the `if` does not match", () => {
    // clusterRole is pinned away from "supporting_asset", so `else` applies and null is the only legal
    // value — the exact case that failed before.
    const schema = { ...EV_FLOOR_SCHEMA, properties: { ...EV_FLOOR_SCHEMA.properties, clusterRole: { const: "money_page" } } };
    const value = mockValueFromSchema(schema) as { supportingFor: unknown };

    expect(value.supportingFor).toBeNull();
    expect(validateOutput(value, schema).ok).toBe(true);
  });

  it("honours the `then` branch when the `if` matches", () => {
    const schema = { ...EV_FLOOR_SCHEMA, properties: { ...EV_FLOOR_SCHEMA.properties, clusterRole: { const: "supporting_asset" } } };
    const value = mockValueFromSchema(schema) as { supportingFor: unknown };

    expect(typeof value.supportingFor).toBe("string");
    expect(value.supportingFor).not.toBe("");
    expect(validateOutput(value, schema).ok).toBe(true);
  });

  it("terminates on a conditional with no branches rather than recursing", () => {
    // The re-entry guard is `"if" in schema`, and a spread that assigns `undefined` KEEPS the key —
    // which recursed until the stack blew. The keys are omitted instead; this is that regression.
    const value = mockValueFromSchema({ type: "object", properties: { a: { type: "string" } }, if: { properties: { a: { const: "x" } } } });

    expect(value).toBeTypeOf("object");
  });

  it("leaves a schema with no conditional exactly as it was", () => {
    const plain = { type: "object", required: ["a"], properties: { a: { type: "string", minLength: 1 } } };

    expect(validateOutput(mockValueFromSchema(plain), plain).ok).toBe(true);
  });
});
