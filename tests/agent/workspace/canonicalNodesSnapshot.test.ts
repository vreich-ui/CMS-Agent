import { describe, expect, it } from "vitest";
import { publishingConductorNodes } from "../../../src/agent/workspace/nodes.js";

// S3 item 1 — the executor validates against `outputSchema` (never the deprecated `schema` alias), so
// every canonical node must carry one; and brief_architect's contract must REQUIRE the five carriers
// downstream nodes read (`npm run nodes:check:offline` separately proves nodes.ts round-trips through
// the seed generator without store credentials).

describe("canonical nodes: outputSchema presence and brief_architect's required carriers", () => {
  it("every node carries an object outputSchema", () => {
    for (const node of publishingConductorNodes as Array<{ id: string; outputSchema?: unknown }>) {
      expect(node.outputSchema, `node ${node.id} has no outputSchema`).toBeDefined();
      expect(typeof node.outputSchema, node.id).toBe("object");
    }
  });

  it("brief_architect requires artifact, summary, mediaSlots, resolved and resolvedBasis", () => {
    const brief = publishingConductorNodes.find((node) => node.id === "brief_architect") as { outputSchema: { required: string[] } };
    expect(brief.outputSchema.required).toEqual(expect.arrayContaining(["artifact", "summary", "mediaSlots", "resolved", "resolvedBasis"]));
  });
});
