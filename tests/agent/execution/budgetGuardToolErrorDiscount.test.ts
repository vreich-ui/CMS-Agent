import { describe, it, expect } from "vitest";
import { wrapModelWithBudgetGuard, type BudgetGuardState } from "../../../src/agent/execution/runners/budgetGuard.js";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";

// run_1786557897658_elj34j (2026-08-12, verified live): topic_opportunity was stopped by the
// mid-loop budget guard with only $0.02 of its $0.10 node ceiling actually spent, because a stray
// workspace.get_node tool call ERRORED the turn before and the SDK's own error text for that call
// (see budgetGuard.ts's SDK_TOOL_ERROR_PREFIX) inflated the very next prospective-turn estimate.
// These tests reproduce that false stop directly against wrapModelWithBudgetGuard (no SDK mocking
// needed — the guard only ever reads request.input/request.systemInstructions and the response's
// usage) and assert the companion cases that must still stop.

const makeInnerModel = (usages: Array<{ inputTokens: number; outputTokens: number }>): Model => {
  let call = 0;
  return {
    async getResponse(): Promise<ModelResponse> {
      const usage = usages[call++];
      return { usage, output: [] } as unknown as ModelResponse;
    },
    async *getStreamedResponse() {
      // unused by these tests
    }
  } as unknown as Model;
};

// Builds the exact shape the guard's lastItemWasToolError() matches on: the newest history item is
// a function_call_result whose text carries the Agents SDK's own default tool-error prefix (see
// @openai/agents-core's tool.js defaultToolErrorFunction, which every thrown tool-execute error is
// routed through before it re-enters the model's conversation).
const requestWithTrailingToolError = (paddingChars: number): ModelRequest =>
  ({
    input: [
      { type: "message", role: "user", content: "seed prompt" },
      { type: "function_call", name: "workspace_get_node", callId: "call_1", arguments: "{}" },
      {
        type: "function_call_result",
        name: "workspace_get_node",
        callId: "call_1",
        status: "completed",
        output: { type: "text", text: `An error occurred while running the tool. Please try again. Error: Error: tool_failed:not_found ${"x".repeat(paddingChars)}` }
      }
    ]
  }) as unknown as ModelRequest;

// A conversation that grew by the same magnitude but WITHOUT any tool-call error — the cap must
// never engage here, so genuine history growth still prices in full.
const requestWithPlainGrowth = (chars: number): ModelRequest =>
  ({ input: [{ type: "message", role: "user", content: "x".repeat(chars) }] }) as unknown as ModelRequest;

describe("budgetGuard: a tool-error detour must not inflate the prospective-turn estimate", () => {
  it("does not false-stop $0.02-spent-of-$0.10 after a stray tool-call error (run_1786557897658_elj34j)", async () => {
    const state: BudgetGuardState = { accrued: { inputTokens: 0, outputTokens: 0 } };
    // Turn 1: a cheap, successful turn — 4000 input tokens at gpt-5.5's $5/M list rate is $0.02.
    const model = wrapModelWithBudgetGuard(
      makeInnerModel([{ inputTokens: 4000, outputTokens: 0 }]),
      { nodeId: "topic_opportunity", model: "gpt-5.5", nodeBudgetUsd: 0.1, priorSpendUsd: 0, maxOutputTokens: 200 },
      state
    );
    await model.getResponse(requestWithPlainGrowth(2000));
    expect(state.lastSuccessfulTurnInputTokens).toBe(4000);

    // Turn 2 follows a stray tool-call error; its SDK-formatted error text pads the raw request to
    // ~60K chars (~15K tokens, ~$0.075 uncapped) — enough to trip the OLD estimate ($0.02 + $0.075 >
    // $0.10) though only $0.02 was ever really spent. Capped at the last successful turn's own 4000
    // input tokens, the prospective cost stays small and the turn must proceed.
    await expect(model.getResponse(requestWithTrailingToolError(60_000))).resolves.toBeDefined();
  });

  it("still stops a genuinely over-budget turn when the growth is NOT a tool-error detour", async () => {
    const state: BudgetGuardState = { accrued: { inputTokens: 0, outputTokens: 0 } };
    const model = wrapModelWithBudgetGuard(
      makeInnerModel([{ inputTokens: 4000, outputTokens: 0 }]),
      { nodeId: "topic_opportunity", model: "gpt-5.5", nodeBudgetUsd: 0.1, priorSpendUsd: 0, maxOutputTokens: 200 },
      state
    );
    await model.getResponse(requestWithPlainGrowth(2000));

    // Same ~60K-char growth, but with no trailing tool error to discount: the cap never engages, so
    // this must still refuse before spending anything.
    await expect(model.getResponse(requestWithPlainGrowth(60_000))).rejects.toThrow(/budget_exceeded/);
  });

  it("still stops after a tool-call error when accrued spend alone is already over the ceiling", async () => {
    const state: BudgetGuardState = { accrued: { inputTokens: 0, outputTokens: 0 } };
    // Turn 1 already spends $0.095 of the $0.10 ceiling (19,000 input tokens at $5/M).
    const model = wrapModelWithBudgetGuard(
      makeInnerModel([{ inputTokens: 19_000, outputTokens: 0 }]),
      { nodeId: "topic_opportunity", model: "gpt-5.5", nodeBudgetUsd: 0.1, priorSpendUsd: 0, maxOutputTokens: 200 },
      state
    );
    await model.getResponse(requestWithPlainGrowth(2000));

    // Turn 2 follows a tool-call error whose raw request (~200K chars, ~50K tokens) is far above the
    // last-successful-turn cap (19,000 tokens), so the cap DOES engage and reduces the estimate — but
    // $0.095 already accrued plus even the capped turn still crosses $0.10, so the stop must hold.
    await expect(model.getResponse(requestWithTrailingToolError(200_000))).rejects.toThrow(/budget_exceeded/);
  });
});
