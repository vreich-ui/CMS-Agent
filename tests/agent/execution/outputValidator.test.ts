import { describe, expect, it } from "vitest";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";

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

// R-6 / R-23 regression lock: the article_body node's OWN outputSchema (the client-shaped envelope)
// is the single remaining definition of "what a body is". The workspace-local {schema_version, nodes}
// monolith is deleted — this asserts the node's schema accepts a real envelope and refuses the legacy
// shape, so the monolith cannot quietly come back as "valid" anywhere the node's schema is enforced.
describe("validateOutput against the article_body node's own outputSchema", () => {
  const articleBodyNodeSchema = getWorkspaceNode("article_body")!.outputSchema;
  const envelope = {
    artifact: "client_object.v1",
    summary: "Client-shaped body.",
    clientProjectId: "dr-lurie",
    clientObjectType: "content_item",
    contractSource: { tool: "object_contract", fetchedAt: "2026-07-16T00:00:00.000Z" },
    body: { slug: "example", title: "T", nodes: [{ id: "n_x", kind: "content", public: { title: "T", body: "Reader body." } }] }
  };

  it("accepts the client-shaped envelope the node actually emits", () => {
    expect(validateOutput(envelope, articleBodyNodeSchema).ok).toBe(true);
  });

  it("rejects the deleted workspace-local {schema_version, nodes} monolith on every required field", () => {
    const legacy = { schema_version: "client_object.v1", nodes: [{ id: "n_A", kind: "content", visibility: "public", public: { title: "Title" } }] };
    const result = validateOutput(legacy, articleBodyNodeSchema);
    expect(result.ok).toBe(false);
    const errors = !result.ok ? result.errors.join("; ") : "";
    for (const field of ["artifact", "summary", "clientProjectId", "clientObjectType", "contractSource", "body"]) {
      expect(errors).toContain(`$.${field} is required`);
    }
  });

  it("rejects an envelope whose body is empty (minProperties)", () => {
    expect(validateOutput({ ...envelope, body: {} }, articleBodyNodeSchema).ok).toBe(false);
  });
});
