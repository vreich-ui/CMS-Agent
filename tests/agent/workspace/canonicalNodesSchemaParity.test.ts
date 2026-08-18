import { describe, expect, it } from "vitest";
import { publishingConductorNodes, getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";

// S1 (chat-path engine fixes). The canonical node seed carries both `outputSchema` (canonical) and the
// deprecated `schema` alias. They must be byte-for-byte the same contract — a node whose two copies
// disagree is exactly the drift the store's updateNodeSchema used to reintroduce on every write. And
// brief_architect's contract must REQUIRE the aggression carrier draft_writer reads (`resolved`,
// `resolvedBasis`) plus the media carrier artifact_plan reads (`mediaSlots`), so the model cannot
// satisfy the schema while leaving downstream nodes to guess.

describe("canonical nodes: outputSchema and schema never drift", () => {
  it("every node's outputSchema deep-equals its schema alias (or schema is absent)", () => {
    for (const node of publishingConductorNodes as Array<{ id: string; schema?: unknown; outputSchema?: unknown }>) {
      if (node.schema === undefined) continue;
      expect(node.outputSchema, `node ${node.id}: outputSchema must equal schema`).toEqual(node.schema);
    }
  });

  it("brief_architect requires resolved, resolvedBasis and mediaSlots", () => {
    const node = getWorkspaceNode("brief_architect");
    expect(node).toBeDefined();
    const output = node!.outputSchema as { required?: string[]; properties?: Record<string, { type?: string; required?: string[]; additionalProperties?: boolean; description?: string }> };
    expect(output.required).toEqual(expect.arrayContaining(["artifact", "summary", "mediaSlots", "resolved", "resolvedBasis"]));
    expect(output.properties?.resolved?.type).toBe("object");
    expect(output.properties?.resolved?.additionalProperties).toBe(false);
    expect(output.properties?.resolved?.required).toEqual(["claim_strength", "urgency", "emotional_agitation", "cta_density"]);
    expect(output.properties?.resolvedBasis?.type).toBe("string");
    // The provenance descriptions on the carriers survived the schema edit.
    expect(typeof output.properties?.mediaSlots?.description).toBe("string");
    expect(typeof output.properties?.trafficSource?.description).toBe("string");
    expect(typeof output.properties?.awarenessStage?.description).toBe("string");
  });

  it("draft_writer carries the SOFT missing-vector rule, never a blocker", () => {
    const node = getWorkspaceNode("draft_writer");
    expect(node?.prompt).toContain("record `aggression_vector_assumed` in `notes` — do not block");
    expect(node?.prompt).not.toMatch(/missing (`?resolved`? vector|aggression vector)[^.]*blocker/i);
  });

  it("research modelConfig carries the tightened budget", () => {
    const node = getWorkspaceNode("research");
    expect(node?.modelConfig).toMatchObject({ budgetUsd: 3, toolCallLimit: 5, maxTurns: 8 });
  });
});
