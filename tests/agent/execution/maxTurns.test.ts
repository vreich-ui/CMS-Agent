import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TURNS, TURN_HEADROOM, resolveMaxTurns } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";

// The defect: run_1785235767862_uvjm83 died with ["model_error", "Max turns (4) exceeded"]. research is
// the first node holding web.search + web.fetch, and maxTurns was read straight off `toolCallLimit`
// — conflating "how many tools may I call" with "how many model round-trips do I get". With
// parallelToolCalls disabled each tool call costs a turn, so the node ran out mid-search and never
// reached the turn that emits its structured output.
describe("agent-loop turn budget (resolveMaxTurns)", () => {
  it("leaves a tool-free node on the small default", () => {
    expect(resolveMaxTurns({}, 0)).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns({ toolCallLimit: 12 }, 0)).toBe(DEFAULT_MAX_TURNS);
  });

  it("gives a tool-using node room for its tool calls PLUS the turn that emits output", () => {
    // The exact shape of the research failure: 12 tool calls no longer fit in 12 turns.
    expect(resolveMaxTurns({ toolCallLimit: 12 }, 2)).toBe(12 + TURN_HEADROOM);
    expect(resolveMaxTurns({ toolCallLimit: 12 }, 2)).toBeGreaterThan(12);
    // A tool-using node that declares no limit still clears the old flat cap.
    expect(resolveMaxTurns({}, 1)).toBeGreaterThanOrEqual(DEFAULT_MAX_TURNS);
  });

  it("is per node, not one global constant: an explicit maxTurns always wins", () => {
    expect(resolveMaxTurns({ maxTurns: 40, toolCallLimit: 2 }, 5)).toBe(40);
    expect(resolveMaxTurns({ maxTurns: 1 }, 5)).toBe(1);
    // Never zero or negative — an unusable budget is a worse failure than a small one.
    expect(resolveMaxTurns({ maxTurns: 0 }, 5)).toBe(1);
    expect(resolveMaxTurns({ maxTurns: -3 }, 5)).toBe(1);
  });

  it("gives every canonical tool-using node more turns than it has tool calls", () => {
    // The invariant that makes the research failure unreachable by construction: whatever a node's
    // configured tool-call allowance, its turn budget exceeds it, so there is always a turn left to
    // emit output.
    for (const node of listWorkspaceNodes()) {
      const toolCount = node.allowedTools.length;
      if (toolCount === 0) continue;
      const config = { ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) } as Record<string, unknown>;
      const limit = typeof config.toolCallLimit === "number" ? config.toolCallLimit : 0;
      expect(resolveMaxTurns(config, toolCount), `${node.id} must be able to finish after its tool calls`).toBeGreaterThan(limit);
    }
  });

  it("research — the node that actually failed — gets a budget that clears its tool-call allowance", () => {
    const research = listWorkspaceNodes().find((node) => node.id === "research")!;
    const config = { ...(research.modelConfig ?? {}) } as Record<string, unknown>;
    expect(research.allowedTools).toEqual(expect.arrayContaining(["web.search", "web.fetch"]));
    // The node-limits audit made research's turn budget explicit (maxTurns 12 over toolCallLimit 8):
    // the invariant is unchanged — the turn budget must clear the tool-call allowance with room for
    // the output turn — the numbers are just declared now instead of derived.
    expect(typeof config.maxTurns).toBe("number");
    expect(typeof config.toolCallLimit).toBe("number");
    expect(resolveMaxTurns(config, research.allowedTools.length)).toBeGreaterThan(config.toolCallLimit as number);
  });
});
