import { describe, expect, it } from "vitest";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";

// CANONICAL MUST NOT THROTTLE article_body BELOW WHAT THE LIVE STORE RUNS.
//
// The live workspace was tuned upward on 2026-08-04 — maxTurns 9, toolCallLimit 8, budgetUsd 1.125 —
// and canonical was never updated, so nodes.ts still declared 6 / 3 / 0.75. Today that difference is
// invisible: overlayStoreNode lays the STORE's modelConfig over canonical, so runs get the tuned
// numbers and nobody notices the code copy is behind.
//
// It stops being invisible the moment a store is seeded FROM canonical — a new environment, a
// rebuild, a restore. That store would run article_body with a third of its tool budget, and the
// engine-owned validate -> revise -> revalidate loop is exactly what those tool calls are for: the
// loop's validator calls come out of toolCallLimit, and starving them is what produced the
// "body could not be compiled" failures this node has already been debugged for once.
//
// So these are floors, not exact values: raising the live numbers again is fine and this test keeps
// passing. What it refuses is canonical silently sitting BELOW the tuned live configuration.
const LIVE_TUNED_FLOOR = { maxTurns: 9, toolCallLimit: 8, budgetUsd: 1.125 } as const;

describe("canonical article_body carries at least the live-tuned execution budget", () => {
  const modelConfig = getWorkspaceNode("article_body")?.modelConfig as Record<string, number> | undefined;

  it("declares a modelConfig at all", () => {
    expect(modelConfig, "article_body must exist in canonical with a modelConfig").toBeDefined();
  });

  for (const [field, floor] of Object.entries(LIVE_TUNED_FLOOR)) {
    it(`${field} is at least the live-tuned ${floor}`, () => {
      expect(modelConfig?.[field]).toBeGreaterThanOrEqual(floor);
    });
  }

  it("keeps the 300s node timeout the claim-window fix is sized against", () => {
    // T3 stamps the validate phase and the revision dispatch against this number; the staged
    // acceptance test in articleBodyClaimWindow.test.ts uses 300_000 as article_body's real timeout.
    expect(modelConfig?.timeout).toBe(300_000);
  });
});
