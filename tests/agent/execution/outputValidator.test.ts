import { describe, expect, it } from "vitest";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { articleBodyJsonSchema } from "../../../src/agent/mcp/workspace/store.js";

describe("validateOutput", () => {
  const schema = { type: "object", required: ["title"], properties: { title: { type: "string" }, count: { type: "integer" } } };
  it("accepts valid structured JSON", () => { expect(validateOutput('{"title":"ok","count":1}', schema).ok).toBe(true); });
  it("rejects invalid output", () => { const result = validateOutput({ count: 1 }, schema); expect(result.ok).toBe(false); });
});

describe("validateOutput full JSON Schema keyword enforcement", () => {
  it("enforces minItems on arrays", () => {
    const schema = { type: "object", properties: { nodes: { type: "array", minItems: 1, items: { type: "string" } } }, required: ["nodes"] };
    expect(validateOutput({ nodes: [] }, schema).ok).toBe(false);
    expect(validateOutput({ nodes: ["a"] }, schema).ok).toBe(true);
  });

  it("enforces maxItems and uniqueItems", () => {
    const schema = { type: "array", maxItems: 2, uniqueItems: true, items: { type: "number" } };
    expect(validateOutput([1, 2, 3], schema).ok).toBe(false);
    expect(validateOutput([1, 1], schema).ok).toBe(false);
    expect(validateOutput([1, 2], schema).ok).toBe(true);
  });

  it("enforces string minLength/maxLength/pattern including nested paths", () => {
    const schema = { type: "object", properties: { id: { type: "string", pattern: "^n_[A-Za-z0-9]+$", minLength: 3, maxLength: 8 } } };
    expect(validateOutput({ id: "n_ok1" }, schema).ok).toBe(true);
    expect(validateOutput({ id: "bad" }, schema).ok).toBe(false);
    expect(validateOutput({ id: "n_wayTooLong" }, schema).ok).toBe(false);
  });

  it("enforces number bounds", () => {
    const schema = { type: "number", minimum: 0, maximum: 10, multipleOf: 2 };
    expect(validateOutput(4, schema).ok).toBe(true);
    expect(validateOutput(11, schema).ok).toBe(false);
    expect(validateOutput(3, schema).ok).toBe(false);
  });

  it("enforces additionalProperties: false", () => {
    const schema = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
    expect(validateOutput({ a: "x" }, schema).ok).toBe(true);
    expect(validateOutput({ a: "x", b: "y" }, schema).ok).toBe(false);
  });

  it("enforces dependentRequired", () => {
    const schema = { type: "object", dependentRequired: { ctaText: ["ctaLink"] }, properties: { ctaText: { type: "string" }, ctaLink: { type: "string" } } };
    expect(validateOutput({ ctaText: "Read" }, schema).ok).toBe(false);
    expect(validateOutput({ ctaText: "Read", ctaLink: "/x" }, schema).ok).toBe(true);
  });

  it("enforces anyOf / oneOf / not", () => {
    const anyOf = { anyOf: [{ required: ["title"] }, { required: ["body"] }], type: "object", properties: {} };
    expect(validateOutput({}, anyOf).ok).toBe(false);
    expect(validateOutput({ title: "x" }, anyOf).ok).toBe(true);

    // validateOutput JSON-parses string inputs, so string values are passed JSON-encoded.
    const oneOf = { oneOf: [{ type: "string" }, { type: "number" }] };
    expect(validateOutput('"x"', oneOf).ok).toBe(true);
    expect(validateOutput(true, oneOf).ok).toBe(false);

    const not = { not: { type: "string" } };
    expect(validateOutput(5, not).ok).toBe(true);
    expect(validateOutput('"x"', not).ok).toBe(false);
  });

  it("enforces if/then conditional subschemas", () => {
    const schema = {
      type: "object",
      properties: { type: { type: "string" }, src: { type: "string" } },
      allOf: [{ if: { properties: { type: { const: "image" } }, required: ["type"] }, then: { properties: { src: { pattern: "^/" } } } }]
    };
    expect(validateOutput({ type: "image", src: "/local.png" }, schema).ok).toBe(true);
    expect(validateOutput({ type: "image", src: "https://remote/x.png" }, schema).ok).toBe(false);
    // The then-branch does not apply when the if-condition is unmet.
    expect(validateOutput({ type: "video", src: "https://remote/x.mp4" }, schema).ok).toBe(true);
  });
});

// The article_body node output schema is the canonical article_body.v1 JSON Schema; the generic
// validator must now enforce every one of its constraints (previously only const fields were honored).
describe("validateOutput against the canonical article_body.v1 schema", () => {
  const node = (media?: unknown) => ({ id: "n_A", kind: "content", visibility: "public", public: { title: "Title", ...(media ? { media } : {}) } });

  it("accepts a well-formed body", () => {
    expect(validateOutput({ schema_version: "article_body.v1", nodes: [node()] }, articleBodyJsonSchema).ok).toBe(true);
  });

  it("rejects an empty nodes array (minItems)", () => {
    expect(validateOutput({ schema_version: "article_body.v1", nodes: [] }, articleBodyJsonSchema).ok).toBe(false);
  });

  it("rejects a remote image url in public.media.src (nested if/then pattern)", () => {
    const remote = validateOutput({ schema_version: "article_body.v1", nodes: [node({ type: "image", src: "https://example.com/x.png" })] }, articleBodyJsonSchema);
    expect(remote.ok).toBe(false);
    const materialized = validateOutput({ schema_version: "article_body.v1", nodes: [node({ type: "image", src: "/media/x.png" })] }, articleBodyJsonSchema);
    expect(materialized.ok).toBe(true);
  });

  it("rejects a bad node id pattern and an unknown public field", () => {
    expect(validateOutput({ schema_version: "article_body.v1", nodes: [{ ...node(), id: "bad" }] }, articleBodyJsonSchema).ok).toBe(false);
    expect(validateOutput({ schema_version: "article_body.v1", nodes: [{ id: "n_A", kind: "content", public: { title: "t", bogus: "x" } }] }, articleBodyJsonSchema).ok).toBe(false);
  });
});
