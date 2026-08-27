import { describe, expect, it } from "vitest";
import { MemoryUsageRepository } from "../../../src/agent/repository/memory/MemoryUsageRepository.js";
import { estimateModelCost, estimatePricedCost, modelPricingCatalog, pricingCostIndex, recordModelUsage, resolvePricing } from "../../../src/agent/observability/modelUsage.js";
import { NodeBudgetExceededError, wrapModelWithBudgetGuard } from "../../../src/agent/execution/runners/budgetGuard.js";

// T6 — NEVER INVENT A RATE.
//
// estimateModelCost used to read `catalog[model] ?? catalog["gpt-5.5"]`. That substitution happened
// inside the function that gates real money — the budget guard prices every turn through it, both
// in-loop and between nodes — so an unrecognised model id was enforced against $5/$30 that nobody
// had checked. modelLadder.ts handled the identical case the OPPOSITE way (undefined, candidate
// dropped), which is how one catalog came to have two contradictory answers. The unknown-model path
// had no test at all.

const UNLISTED = "totally-not-a-real-model-9000";

describe("T6 — unknown model pricing", () => {
  it("resolves a listed model to its own rate and reports it as known", () => {
    const { pricing, known } = resolvePricing("gpt-5.5");
    expect(known).toBe(true);
    expect(pricing).toBe(modelPricingCatalog["gpt-5.5"]);
    expect(estimatePricedCost({ model: "gpt-5.5", inputTokens: 1_000_000, outputTokens: 0 }).pricingUnknown).toBe(false);
  });

  it("never silently substitutes gpt-5.5 for an unlisted model", () => {
    const { pricing, known } = resolvePricing(UNLISTED);
    expect(known).toBe(false);
    // The old behaviour, stated as the thing that must not happen.
    expect(pricing).not.toBe(modelPricingCatalog["gpt-5.5"]);
    // What it resolves to instead is the catalog's dearest entry — an upper bound for callers that
    // must produce a number, never a rate presented as this model's own.
    const dearest = Object.values(modelPricingCatalog).reduce((worst, entry) =>
      entry.inputUsdPerMillion + entry.outputUsdPerMillion > worst.inputUsdPerMillion + worst.outputUsdPerMillion ? entry : worst);
    expect(pricing).toBe(dearest);
    expect(estimateModelCost({ model: UNLISTED, inputTokens: 1_000_000, outputTokens: 1_000_000 }))
      .toBeGreaterThanOrEqual(estimateModelCost({ model: "gpt-5.5", inputTokens: 1_000_000, outputTokens: 1_000_000 }));
  });

  it("gives the model ladder and the budget gate the SAME answer about an unlisted model", () => {
    // The ladder still drops an unpriceable candidate (undefined cost index), and the cost path still
    // flags it — but both now come from one helper rather than two opposite hand-rolled branches.
    expect(pricingCostIndex(UNLISTED)).toBeUndefined();
    expect(pricingCostIndex("gpt-5.5")).toBe(modelPricingCatalog["gpt-5.5"]!.inputUsdPerMillion + modelPricingCatalog["gpt-5.5"]!.outputUsdPerMillion);
    expect(estimatePricedCost({ model: UNLISTED, inputTokens: 10, outputTokens: 10 }).pricingUnknown).toBe(true);
  });

  it("flags a usage record whose cost this module had to estimate without a listed rate", async () => {
    const store = new MemoryUsageRepository();
    const flagged = await recordModelUsage({ model: UNLISTED, provider: "openai", inputTokens: 100, outputTokens: 100, status: "estimated" }, store);
    expect(flagged.metadata).toMatchObject({ pricingUnknown: true, pricingUnknownModel: UNLISTED });

    const listed = await recordModelUsage({ model: "gpt-5.5", provider: "openai", inputTokens: 100, outputTokens: 100, status: "estimated" }, store);
    expect(listed.metadata?.pricingUnknown).toBeUndefined();

    // A caller-supplied cost is authoritative and is never re-priced, so it is never flagged.
    const supplied = await recordModelUsage({ model: UNLISTED, provider: "openai", inputTokens: 100, outputTokens: 100, costUsdEstimate: 0.42, status: "actual" }, store);
    expect(supplied.costUsdEstimate).toBe(0.42);
    expect(supplied.metadata?.pricingUnknown).toBeUndefined();
  });
});

describe("T6 — the budget gate fails loud rather than enforcing a ceiling against a guess", () => {
  const noopModel = { getResponse: async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }), getStreamedResponse: async function* () {} } as never;
  const request = { input: [{ role: "user", content: "hello" }] } as never;
  const state = () => ({ accrued: { inputTokens: 0, outputTokens: 0 } }) as never;

  it("refuses a BUDGETED node whose model has no listed rate, and names the remedy", async () => {
    const guarded = wrapModelWithBudgetGuard(noopModel, { nodeId: "n", model: UNLISTED, nodeBudgetUsd: 0.5, priorSpendUsd: 0, maxOutputTokens: 100 }, state());
    await expect(guarded.getResponse(request)).rejects.toThrow(NodeBudgetExceededError);
    await expect(guarded.getResponse(request)).rejects.toThrow(/model_pricing_unknown/);
    // The dollar figures are meaningless in this case, so the message must not quote them as if a
    // real ceiling had been crossed.
    await expect(guarded.getResponse(request)).rejects.not.toThrow(/already spent/);
  });

  it("leaves an UNBUDGETED node alone — there is no ceiling there to enforce wrongly", async () => {
    const guarded = wrapModelWithBudgetGuard(noopModel, { nodeId: "n", model: UNLISTED, priorSpendUsd: 0, maxOutputTokens: 100 }, state());
    await expect(guarded.getResponse(request)).resolves.toBeDefined();
  });

  it("still gates a listed model on its real ceiling", async () => {
    const generous = wrapModelWithBudgetGuard(noopModel, { nodeId: "n", model: "gpt-5.5", nodeBudgetUsd: 100, priorSpendUsd: 0, maxOutputTokens: 100 }, state());
    await expect(generous.getResponse(request)).resolves.toBeDefined();

    const stingy = wrapModelWithBudgetGuard(noopModel, { nodeId: "n", model: "gpt-5.5", nodeBudgetUsd: 0.000_000_1, priorSpendUsd: 0, maxOutputTokens: 100_000 }, state());
    await expect(stingy.getResponse(request)).rejects.toThrow(/already spent/);
  });
});
