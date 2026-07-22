import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvalResult, PairwiseResult } from "../../src/agent/improvement/improvementTypes.js";
import {
  fineTuneMinExamples,
  fineTuneMinPreferencePairs,
  evaluateFineTuneReadiness
} from "../../src/agent/improvement/fineTune.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";

// Phase 8 (docs/platform/DIRECTION.md §8): fine-tuning flywheel trigger. Report-only readiness over a
// node's accumulated approved examples + decisive preference pairs. These tests pin the thresholds and
// the recommendation ladder; synthetic nodeIds keep them isolated from the process-static store.

const FT_ENV = ["IMPROVEMENT_FINETUNE_MIN_EXAMPLES", "IMPROVEMENT_FINETUNE_MIN_PREFERENCE_PAIRS"];
const clearFtEnv = () => { for (const key of FT_ENV) delete process.env[key]; };

let counter = 0;
const result = (nodeId: string, over: Partial<EvalResult> = {}): EvalResult => ({
  evalId: `eval_${counter++}`, rubricId: "rub", nodeId, runId: `run_${counter}`, subjectHash: "h",
  scores: [], normalizedScore: 0.9, pass: true, judge: { mode: "mock", model: "m" }, createdAt: "2026-07-01T00:00:00.000Z", ...over
});
const pairwise = (nodeId: string, verdict: PairwiseResult["verdict"]): PairwiseResult => ({
  comparisonId: `cmp_${counter++}`, nodeId, rubricId: "rub", championHash: "c", challengerHash: "h",
  orderings: [], verdict, judge: { mode: "mock", model: "m" }, createdAt: "2026-07-01T00:00:00.000Z"
});

describe("fine-tune thresholds", () => {
  afterEach(clearFtEnv);
  it("min examples defaults to 500 (override, invalid falls back)", () => {
    delete process.env.IMPROVEMENT_FINETUNE_MIN_EXAMPLES; expect(fineTuneMinExamples()).toBe(500);
    process.env.IMPROVEMENT_FINETUNE_MIN_EXAMPLES = "1200"; expect(fineTuneMinExamples()).toBe(1200);
    for (const bad of ["0", "abc", ""]) { process.env.IMPROVEMENT_FINETUNE_MIN_EXAMPLES = bad; expect(fineTuneMinExamples()).toBe(500); }
  });
  it("min preference pairs defaults to 200 (override, invalid falls back)", () => {
    delete process.env.IMPROVEMENT_FINETUNE_MIN_PREFERENCE_PAIRS; expect(fineTuneMinPreferencePairs()).toBe(200);
    process.env.IMPROVEMENT_FINETUNE_MIN_PREFERENCE_PAIRS = "50"; expect(fineTuneMinPreferencePairs()).toBe(50);
    for (const bad of ["-3", "x"]) { process.env.IMPROVEMENT_FINETUNE_MIN_PREFERENCE_PAIRS = bad; expect(fineTuneMinPreferencePairs()).toBe(200); }
  });
});

describe("evaluateFineTuneReadiness", () => {
  beforeEach(() => { clearFtEnv(); resetRepositoryManager(); process.env.IMPROVEMENT_FINETUNE_MIN_EXAMPLES = "3"; process.env.IMPROVEMENT_FINETUNE_MIN_PREFERENCE_PAIRS = "2"; });
  afterEach(() => { clearFtEnv(); resetRepositoryManager(); });

  const deps = () => ({ evaluationRepository: repositoryManager.getEvaluationRepository() });
  const seedResults = async (nodeId: string, n: number, over: Partial<EvalResult> = {}) => { const repo = repositoryManager.getEvaluationRepository(); for (let index = 0; index < n; index++) await repo.recordResult(result(nodeId, over)); };
  const seedPairs = async (nodeId: string, verdicts: PairwiseResult["verdict"][]) => { const repo = repositoryManager.getEvaluationRepository(); for (const verdict of verdicts) await repo.recordPairwise(pairwise(nodeId, verdict)); };

  it("reports insufficient_data with no evidence", async () => {
    const readiness = await evaluateFineTuneReadiness({ nodeId: "ft_none" }, deps());
    expect(readiness).toMatchObject({ approvedExamples: 0, preferencePairs: 0, recommendation: "insufficient_data" });
    expect(readiness.thresholds).toEqual({ minExamples: 3, minPreferencePairs: 2 });
  });

  it("reports accumulate below both thresholds", async () => {
    await seedResults("ft_acc", 1);
    const readiness = await evaluateFineTuneReadiness({ nodeId: "ft_acc" }, deps());
    expect(readiness.recommendation).toBe("accumulate");
  });

  it("reports ready_sft when approved examples cross the bar", async () => {
    await seedResults("ft_sft", 3);
    const readiness = await evaluateFineTuneReadiness({ nodeId: "ft_sft" }, deps());
    expect(readiness).toMatchObject({ approvedExamples: 3, preferencePairs: 0, recommendation: "ready_sft" });
  });

  it("reports ready_preferences when decisive pairs cross the bar", async () => {
    await seedPairs("ft_pref", ["challenger", "champion", "tie", "inconsistent"]); // only the first two are decisive
    const readiness = await evaluateFineTuneReadiness({ nodeId: "ft_pref" }, deps());
    expect(readiness).toMatchObject({ approvedExamples: 0, preferencePairs: 2, recommendation: "ready_preferences" });
  });

  it("reports ready_both when both cross the bar", async () => {
    await seedResults("ft_both", 3);
    await seedPairs("ft_both", ["challenger", "challenger"]);
    const readiness = await evaluateFineTuneReadiness({ nodeId: "ft_both" }, deps());
    expect(readiness.recommendation).toBe("ready_both");
  });

  it("counts only run-attributed, bar-clearing results (pass flag or minScore)", async () => {
    await seedResults("ft_filter", 2);                                      // qualifying (runId + pass)
    await seedResults("ft_filter", 2, { runId: undefined });               // excluded: no runId
    await seedResults("ft_filter", 2, { pass: false, normalizedScore: 0.65 }); // excluded by pass flag...
    expect((await evaluateFineTuneReadiness({ nodeId: "ft_filter" }, deps())).approvedExamples).toBe(2);
    // ...but counted when minScore lowers the bar under their score.
    expect((await evaluateFineTuneReadiness({ nodeId: "ft_filter", minScore: 0.6 }, deps())).approvedExamples).toBe(4);
  });
});
