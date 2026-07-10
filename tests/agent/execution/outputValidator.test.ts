import { describe, expect, it } from "vitest";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";

describe("validateOutput", () => {
  const schema = { type: "object", required: ["title"], properties: { title: { type: "string" }, count: { type: "integer" } } };
  it("accepts valid structured JSON", () => { expect(validateOutput('{"title":"ok","count":1}', schema).ok).toBe(true); });
  it("rejects invalid output", () => { const result = validateOutput({ count: 1 }, schema); expect(result.ok).toBe(false); });
});
