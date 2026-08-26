import { describe, expect, it } from "vitest";
import { toWireArguments, fromWireResult, McpBoundaryError, __test__ as mcpBoundaryTest } from "../../../src/agent/capture/mcpBoundary.js";
import { PLATFORM_TOOL_SCHEMAS, PLATFORM_TOOL_SCHEMAS_CAPTURED_AT, PLATFORM_TOOL_SCHEMAS_RECAPTURE_INSTRUCTION } from "./fixtures/platformToolSchemas.js";

// T13.4 — THE CONFORMANCE TEST THAT ENDS THIS BUG CLASS.
//
// For every tool cloneEngine.ts can call, toWireArguments' output is checked against that tool's
// REAL JSON Schema — read from tests/agent/capture/fixtures/platformToolSchemas.ts, a VERBATIM copy
// of the live platform MCP surface (see that file's header for exactly where from, and for the
// documented deviation from the spec's docs/mcp-tool-manifest.json instruction: that file does not
// carry these schemas at all — it locks CMS-Agent's own served tool surface, not the platform's
// remote one). This test never re-encodes a schema's `required`/`enum`/`type` by hand a second time;
// it walks the same schema object mcpBoundary's own comments point at.

// A small, deliberately narrow JSON-Schema subset checker — just enough for the shapes these eight
// tool schemas actually use (object/string/integer/boolean/array, enum, minLength, minimum, required,
// additionalProperties:false). Not a general-purpose validator: it exists so this test asserts
// against the schema OBJECT itself rather than a second hand-written description of it.
function schemaViolations(schema: any, value: unknown, path = "$"): string[] {
  const violations: string[] = [];
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${path}: expected an object`];
    }
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in record) || record[required] === undefined) violations.push(`${path}: missing required field "${required}"`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) violations.push(`${path}: additionalProperties:false violated by unexpected key "${key}"`);
      }
    }
    for (const [key, propSchema] of Object.entries<any>(schema.properties ?? {})) {
      if (record[key] === undefined) continue;
      violations.push(...schemaViolations(propSchema, record[key], `${path}.${key}`));
    }
    return violations;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path}: expected a string`];
    if (typeof schema.minLength === "number" && value.length < schema.minLength) violations.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path}: "${value}" is not one of ${JSON.stringify(schema.enum)}`);
    return violations;
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [`${path}: expected an integer`];
    if (typeof schema.minimum === "number" && value < schema.minimum) violations.push(`${path}: below minimum ${schema.minimum}`);
    return violations;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return [`${path}: expected a boolean`];
    return violations;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected an array`];
    return violations;
  }
  return violations;
}

const assertConforms = (tool: string, wireArgs: Record<string, unknown>) => {
  const schema = (PLATFORM_TOOL_SCHEMAS as Record<string, any>)[tool];
  expect(schema, `no real schema captured for "${tool}" — see platformToolSchemas.ts`).toBeDefined();
  const violations = schemaViolations(schema, wireArgs);
  expect(violations, `toWireArguments("${tool}", ...) produced a call that violates its real schema:\n${violations.join("\n")}`).toEqual([]);
};

// Realistic engine-side argument samples, one per tool cloneEngine.ts's callProjectTool can reach —
// written the way this codebase's own call sites now construct them (engine camelCase; see
// cloneEngine.ts's cloneIntakeStep/cloneMintStep/cloneThemeBindStep/cloneRestampStep).
// T13.4 FOLLOW-UP — THE STALENESS GUARD.
//
// A verbatim fixture is only honest on the day it is captured. Nothing re-fetches
// platformToolSchemas.ts automatically, so the one drift this suite CAN catch without a live
// network call (a test that needs the network is a test that fails in CI, so this deliberately does
// not attempt one) is a NEW tool: if mcpBoundary.ts's TOOL_WIRE_SPECS ever starts routing a tool
// this fixture never captured, conformance for that tool would otherwise be silently skipped rather
// than checked (there is no schema to check it against). This test fails loudly instead, naming the
// fixture and how to fix it — see PLATFORM_TOOL_SCHEMAS_RECAPTURE_INSTRUCTION and the fixture's own
// header for the same instruction in full.
//
// What this CANNOT catch: an EXISTING entry's schema changing on the platform side out from under
// this fixture. That class of drift has no local signal to test against — it needs a human to
// re-run the fixture's RE-CAPTURE step periodically or when a platform change is suspected (the
// fixture header names PLATFORM_TOOL_SCHEMAS_CAPTURED_AT for exactly that judgment call).
describe("mcpBoundary conformance — fixture staleness guard", () => {
  it(`every tool mcpBoundary.ts can route to has a captured real schema (platformToolSchemas.ts, captured ${PLATFORM_TOOL_SCHEMAS_CAPTURED_AT})`, () => {
    const registeredTools = Object.keys(mcpBoundaryTest.TOOL_WIRE_SPECS).sort();
    const capturedTools = new Set(Object.keys(PLATFORM_TOOL_SCHEMAS));
    const missing = registeredTools.filter((tool) => !capturedTools.has(tool));

    expect(
      missing,
      missing.length === 0
        ? undefined
        : `tests/agent/capture/fixtures/platformToolSchemas.ts is missing the real schema for: ${missing.join(", ")}. ` +
          `mcpBoundary.ts's TOOL_WIRE_SPECS just started routing a tool this fixture (captured ${PLATFORM_TOOL_SCHEMAS_CAPTURED_AT}) has never seen, ` +
          `so conformance for it would silently go unchecked rather than fail. ${PLATFORM_TOOL_SCHEMAS_RECAPTURE_INSTRUCTION}`
    ).toEqual([]);
  });
});

describe("mcpBoundary conformance — toWireArguments output validates against the real platform schema", () => {
  it("registry_get", () => assertConforms("registry_get", toWireArguments("registry_get", { registry: "component" })));

  it("object_inventory", () => assertConforms("object_inventory", toWireArguments("object_inventory", { objectType: "page" })));

  it("object_get", () => assertConforms("object_get", toWireArguments("object_get", { objectType: "site", objectId: "site_x" })));

  it("object_checkout", () => assertConforms("object_checkout", toWireArguments("object_checkout", { objectType: "theme", objectId: "thm_x" })));

  it("object_checkin", () => assertConforms("object_checkin", toWireArguments("object_checkin", { objectType: "theme", objectId: "thm_x", lockToken: "lk_1" })));

  it("object_patch", () =>
    assertConforms(
      "object_patch",
      toWireArguments("object_patch", {
        objectType: "page",
        objectId: "pg_home",
        lockToken: "lk_1",
        expectedRecordVersion: 4,
        ops: [{ op: "upsert_section", section: { id: "s_1" }, position: 0 }]
      })
    ));

  it("site_apply_theme", () =>
    assertConforms("site_apply_theme", toWireArguments("site_apply_theme", { siteId: "site_x", themeId: "thm_x", dryRun: true })));

  it('object_create — a fully-formed mint call (the "site" the spec\'s defect table names) conforms', () =>
    assertConforms(
      "object_create",
      toWireArguments("object_create", {
        objectType: "template",
        requestedId: "tpl_clone_abc123",
        site: "site_x",
        body: { name: "Landing", description: "", whenToUse: "", scope: "evergreen", appliesTo: ["home"], slots: [] }
      })
    ));

  // T13.4-SPEC.md, verbatim: "object_create without a site throws rather than producing an invalid
  // call." This is the exact non-naming sibling defect the spec calls out: object_create's real
  // schema requires ["object_type","site","body"], and the mint plan never supplied one.
  it("object_create WITHOUT site throws a typed refusal naming the tool and the field, rather than building an invalid call", () => {
    expect(() =>
      toWireArguments("object_create", { objectType: "template", requestedId: "tpl_clone_abc123", body: { name: "Landing" } })
    ).toThrow(McpBoundaryError);
    try {
      toWireArguments("object_create", { objectType: "template", requestedId: "tpl_clone_abc123", body: { name: "Landing" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpBoundaryError);
      expect((error as McpBoundaryError).tool).toBe("object_create");
      expect((error as McpBoundaryError).field).toBe("site");
    }
  });

  it("every tool's `required` in the real schema is honored: dropping any one required field throws", () => {
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "object_get", args: { objectType: "page" } }, // missing objectId
      { tool: "object_get", args: { objectId: "pg_1" } }, // missing objectType
      { tool: "object_checkout", args: { objectType: "page" } },
      { tool: "object_checkin", args: { objectType: "page", objectId: "pg_1" } }, // missing lockToken
      { tool: "object_patch", args: { objectType: "page", objectId: "pg_1", lockToken: "lk_1", expectedRecordVersion: 1 } }, // missing ops
      { tool: "site_apply_theme", args: { siteId: "site_x" } }, // missing themeId
      { tool: "site_apply_theme", args: { themeId: "thm_x" } } // missing siteId
    ];
    for (const { tool, args } of cases) {
      expect(() => toWireArguments(tool, args), `${tool} with ${JSON.stringify(args)} should have thrown`).toThrow(McpBoundaryError);
    }
  });
});

// T15.34 (#210; ADR-2026-08-25-structure-studio §7) — the pdf-tool bridge's four verbs,
// pdfTemplateEngine.ts's own call site. Same conformance discipline as every CMS object verb above,
// against the SAME kind of real, verbatim-captured schema (platformToolSchemas.ts's own T15.34 note
// records this batch's distinct provenance/date).
describe("mcpBoundary conformance — pdf-tool bridge verbs (T15.34)", () => {
  it("create_pdf_template", () =>
    assertConforms(
      "create_pdf_template",
      toWireArguments("create_pdf_template", { siteId: "site_x", templateJson: { html: "<div/>", css: "" }, renderer: "chromium", idempotencyKey: "abc123" })
    ));

  it("validate_pdf_template", () =>
    assertConforms("validate_pdf_template", toWireArguments("validate_pdf_template", { siteId: "site_x", templateId: "tpl_1", data: { title: "x" } })));

  it("get_pdf_template_validation", () =>
    assertConforms("get_pdf_template_validation", toWireArguments("get_pdf_template_validation", { siteId: "site_x", templateId: "tpl_1" })));

  it("publish_pdf_template", () =>
    assertConforms("publish_pdf_template", toWireArguments("publish_pdf_template", { siteId: "site_x", templateId: "tpl_1", version: 1 })));

  it("every pdf-tool verb's `required` in the real schema is honored: dropping any one required field throws", () => {
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "create_pdf_template", args: { templateJson: { html: "<div/>" } } }, // missing siteId
      { tool: "create_pdf_template", args: { siteId: "site_x" } }, // missing templateJson
      { tool: "validate_pdf_template", args: { siteId: "site_x", templateId: "tpl_1" } }, // missing data
      { tool: "get_pdf_template_validation", args: { siteId: "site_x" } }, // missing templateId
      { tool: "publish_pdf_template", args: { templateId: "tpl_1" } } // missing siteId
    ];
    for (const { tool, args } of cases) {
      expect(() => toWireArguments(tool, args), `${tool} with ${JSON.stringify(args)} should have thrown`).toThrow(McpBoundaryError);
    }
  });
});

// THE ENVELOPE / BODY BOUNDARY — the subtle part, and the place a fix here can do real damage.
// MCP envelope keys are snake_case; a `body` (or `ops`) payload is per-type PLATFORM CONTENT whose
// real field names are the platform's own — often camelCase (`whenToUse`, `appliesTo`,
// `brandTokens`) — and must survive completely untouched, at every depth. A blanket recursive
// camelCase<->snake_case transform would silently corrupt every object this workflow writes; this is
// the test that proves toWireArguments does NOT do that.
describe("mcpBoundary — body/ops payloads pass through byte-identical (never recursed into)", () => {
  it("a recipe body's real camelCase field names are untouched, at every depth, while the envelope around it is cased", () => {
    const body = {
      name: "Landing",
      description: "cloned from example.com",
      whenToUse: "Use for a marketing landing page with a single primary CTA.",
      scope: "evergreen",
      appliesTo: ["landing", "campaign"],
      slots: [{ slotId: "hero", allowed: ["hero"], required: true, repeatable: false }],
      // A nested camelCase field that would collide with an envelope name if this were a blanket
      // transform (`brandTokens` -> `brand_tokens` would be exactly the kind of silent corruption
      // the spec warns about) — must survive untouched at depth too.
      brandTokens: { colors: { brandPrimary: "#111111" }, fonts: { bodyFont: "Inter, sans-serif" } }
    };

    const wire = toWireArguments("object_create", { objectType: "template", requestedId: "tpl_1", site: "site_x", body });

    // The envelope around it WAS translated (site/object_type/requested_id are wire-cased)...
    expect(wire.object_type).toBe("template");
    expect(wire.requested_id).toBe("tpl_1");
    expect(wire.site).toBe("site_x");
    // ...but the body itself is the exact same object, byte-identical — not a re-keyed copy.
    expect(wire.body).toBe(body);
    expect(wire.body).toEqual(body);
    expect(JSON.stringify(wire.body)).toBe(JSON.stringify(body));
  });

  it("object_patch's `ops` array (arbitrary C§2.0 patch grammar) is passed through untouched", () => {
    const ops = [{ op: "set_article_meta", fields: { headline: "x", appliesTo: ["y"] } }, { op: "upsert_node", node: { whenToUse: "z" } }];
    const wire = toWireArguments("object_patch", { objectType: "page", objectId: "pg_1", lockToken: "lk_1", expectedRecordVersion: 1, ops });
    expect(wire.ops).toBe(ops);
    expect(wire.ops).toEqual(ops);
  });
});

// fromWireResult — the tolerant reader. Extracts a lock token from BOTH {lockToken} and {lock_token}
// shapes and returns ONE canonical name; a result carrying neither is a typed refusal naming the
// tool, never `undefined` silently flowing onward.
describe("mcpBoundary — fromWireResult reads a checkout lock token tolerantly", () => {
  it("extracts lockToken/recordVersion from a snake_case response", () => {
    expect(fromWireResult("object_checkout", { lock_token: "lk_1", record_version: 4 })).toMatchObject({ lockToken: "lk_1", recordVersion: 4 });
  });

  it("extracts lockToken/recordVersion from a camelCase response", () => {
    expect(fromWireResult("object_checkout", { lockToken: "lk_1", recordVersion: 4 })).toMatchObject({ lockToken: "lk_1", recordVersion: 4 });
  });

  it("matches the LIVE incident evidence exactly: lockToken camelCase next to record_version snake_case in the SAME response", () => {
    const liveResponse = { action: "checkout", lockToken: "361cb72b-1234-4abc-9def-abcdef012345", lock: { holder: "clone_conductor", expires_at: "2026-08-24T12:00:00Z" }, record_version: 52 };
    const result = fromWireResult("object_checkout", liveResponse);
    expect(result.lockToken).toBe("361cb72b-1234-4abc-9def-abcdef012345");
    expect(result.recordVersion).toBe(52);
    // The rest of the platform's own response shape is preserved untouched (recordOf/bodyOf-style
    // callers downstream may still want `action`/`lock`).
    expect(result.action).toBe("checkout");
    expect(result.lock).toEqual(liveResponse.lock);
  });

  it("a result with neither lockToken nor lock_token is a typed refusal naming the tool, not undefined flowing onward", () => {
    expect(() => fromWireResult("object_checkout", { action: "checkout", record_version: 4 })).toThrow(McpBoundaryError);
    try {
      fromWireResult("object_checkout", { action: "checkout" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpBoundaryError);
      expect((error as McpBoundaryError).tool).toBe("object_checkout");
      expect((error as McpBoundaryError).message).toContain("object_checkout");
    }
  });

  it("tools with no registered result spec pass their platform-shaped result through untouched (object_get's record.body stays exactly as the platform sent it)", () => {
    const raw = { record: { object_id: "pg_1", body: { route: "/", appliesTo: ["ignored-here"], brandTokens: {} } } };
    expect(fromWireResult("object_get", raw)).toEqual(raw);
  });
});

describe("mcpBoundary — unregistered tool and unrecognized argument are typed refusals, not silent pass-throughs", () => {
  it("toWireArguments refuses a tool it has no envelope mapping for", () => {
    expect(() => toWireArguments("object_publish", {})).toThrow(McpBoundaryError);
  });

  it("toWireArguments refuses an argument key that is neither the engine nor the wire name for any field on this tool", () => {
    expect(() => toWireArguments("object_get", { objectType: "page", objectId: "pg_1", objectID: "typo" })).toThrow(McpBoundaryError);
  });

  it("toWireArguments refuses when a field is supplied under BOTH its engine and wire name with conflicting values", () => {
    expect(() => toWireArguments("object_get", { objectType: "page", object_type: "site", objectId: "pg_1" })).toThrow(McpBoundaryError);
  });

  it("toWireArguments accepts a field supplied under its wire (snake_case) name too — engine/clone.mjs's own plan steps already emit near-wire args", () => {
    expect(toWireArguments("object_checkout", { object_type: "theme", object_id: "thm_x" })).toEqual({ object_type: "theme", object_id: "thm_x" });
  });
});
