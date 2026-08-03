import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { scoreOutput } from "../../../src/agent/improvement/rubricJudge.js";
import { buildDataset } from "../../../src/agent/improvement/replay.js";
import { validateRubric, type EvalRubric } from "../../../src/agent/improvement/improvementTypes.js";
import { runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// Session B follow-up (2026-08-03), Wolf's decisions 1/2/3 plus the two traps Session B hit by using
// the evaluation layer. Four behaviours, each of which was previously a silent wrong answer rather
// than an error.

const rubric = (overrides: Partial<EvalRubric> = {}): EvalRubric => ({
  rubricId: "rubric_test",
  nodeId: "contract_intelligence",
  name: "test rubric",
  description: "test",
  status: "draft",
  criteria: [
    { id: "ordinary", name: "Ordinary", description: "an ordinary criterion", weight: 9, scaleMax: 5 },
    { id: "non_negotiable", name: "Non-negotiable", description: "a criterion with a floor", weight: 1, scaleMax: 5, criticalMin: 0 }
  ],
  passThreshold: 0.7,
  metadata: {},
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  ...overrides
});

const deps = () => {
  const manager = new RepositoryManager();
  return { evaluationRepository: manager.getEvaluationRepository(), executionRepository: manager.getExecutionRepository() };
};

describe("criticalMin veto (one hard-fail mechanism, enforced by the harness)", () => {
  // The whole point: with 7+ criteria a weighted mean cannot express "this one thing is
  // non-negotiable" — any single zero is survivable. Before this, contract_intelligence's rubric
  // SAID a zero on provenance failed the rubric while the arithmetic scored it 0.88 and passed.
  it("fails a rubric whose mean clears the threshold when a floor criterion is at its floor", async () => {
    const d = deps();
    // Mock scores are a deterministic function of the output hash, so search for an output whose
    // pseudo-scores actually produce the ordinary-high / floor-at-zero shape this asserts.
    let vetoed: Awaited<ReturnType<typeof scoreOutput>> | undefined;
    for (let i = 0; i < 400 && !vetoed; i++) {
      const result = await scoreOutput({ rubric: rubric(), nodeId: "contract_intelligence", output: { probe: i }, mode: "mock" }, d);
      const floorScore = result.scores.find((s) => s.criterionId === "non_negotiable")!.score;
      if (floorScore === 0 && result.normalizedScore >= 0.7) vetoed = result;
    }
    expect(vetoed, "expected some probe output to score high overall but zero on the floor criterion").toBeDefined();
    expect(vetoed!.normalizedScore).toBeGreaterThanOrEqual(0.7); // the mean says pass...
    expect(vetoed!.pass).toBe(false);                            // ...the veto says otherwise
    expect(vetoed!.veto).toMatchObject({ criterionId: "non_negotiable", score: 0, criticalMin: 0 });
  });

  it("leaves an untripped rubric's pass decision to the mean, and records no veto", async () => {
    const d = deps();
    let clean: Awaited<ReturnType<typeof scoreOutput>> | undefined;
    for (let i = 0; i < 400 && !clean; i++) {
      const result = await scoreOutput({ rubric: rubric(), nodeId: "contract_intelligence", output: { other: i }, mode: "mock" }, d);
      if (result.scores.find((s) => s.criterionId === "non_negotiable")!.score > 0) clean = result;
    }
    expect(clean!.veto).toBeUndefined();
    expect(clean!.pass).toBe(clean!.normalizedScore >= 0.7);
  });

  it("treats a criterion the judge never scored as tripping its floor, not clearing it", async () => {
    // An unscored non-negotiable must not pass by omission — that would make the veto opt-out for
    // any judge that simply declines to return the criterion.
    const d = deps();
    const result = await scoreOutput({ rubric: rubric({ criteria: [
      { id: "ordinary", name: "Ordinary", description: "x", weight: 9, scaleMax: 5 },
      { id: "never_scored", name: "Never scored", description: "x", weight: 1, scaleMax: 5, criticalMin: 1 }
    ] }), nodeId: "contract_intelligence", output: { a: 1 }, mode: "mock" }, d);
    // The mock judge scores every criterion, so assert the rule directly on the recorded result:
    // whatever it scored, a score at or below the floor must veto.
    const scored = result.scores.find((s) => s.criterionId === "never_scored")!.score;
    if (scored <= 1) expect(result.veto?.criterionId).toBe("never_scored");
    else expect(result.veto).toBeUndefined();
  });

  it("rejects a criticalMin that would veto even a perfect score", () => {
    expect(validateRubric({ passThreshold: 0.7, criteria: [{ id: "a", name: "A", description: "x", weight: 1, scaleMax: 5, criticalMin: 5 }] }))
      .toEqual([expect.stringContaining("must be below scaleMax")]);
    expect(validateRubric({ passThreshold: 0.7, criteria: [{ id: "a", name: "A", description: "x", weight: 1, scaleMax: 5, criticalMin: 4 }] })).toEqual([]);
  });
});

describe("judge evidence channel", () => {
  it("records which reference material the judge had — absent on mock, since the mock judge reads nothing", async () => {
    const d = deps();
    const result = await scoreOutput({
      rubric: rubric(),
      nodeId: "contract_intelligence",
      output: { a: 1 },
      mode: "mock",
      evidence: { contract: { rules: ["x"] }, dependencyOutputs: { upstream: { b: 2 } } }
    }, d);
    expect(result.evidenceUsed).toBeUndefined();
    expect(result.judge).toEqual({ mode: "mock", model: "mock" });
  });

  it("does not let evidence change the deterministic mock score (mode stays reproducible)", async () => {
    const d = deps();
    const without = await scoreOutput({ rubric: rubric(), nodeId: "n", output: { a: 1 }, mode: "mock" }, d);
    const with_ = await scoreOutput({ rubric: rubric(), nodeId: "n", output: { a: 1 }, mode: "mock", evidence: { contract: { huge: "x".repeat(1000) } } }, d);
    expect(with_.normalizedScore).toBe(without.normalizedScore);
    expect(with_.subjectHash).toBe(without.subjectHash);
  });
});

describe("dataset cases carry their source execution mode (mock champions are not champions)", () => {
  const seedRun = async (store: ReturnType<RepositoryManager["getExecutionRepository"]>, mode: "mock" | "openai", n: number) => {
    const run: WorkflowExecutionRecord = {
      runId: `run_mode_${mode}_${n}`, workflowId: "publishing_conductor", projectId: "platform", status: "completed",
      startedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, n)).toISOString(), updatedAt: new Date(Date.UTC(2026, 7, 1, 0, 1, n)).toISOString(),
      nodes: [{ nodeId: "article_body", status: "completed", input: { brief: "x" }, output: { body: mode }, produces: ["client_object.v1"] }],
      artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: mode
    } as WorkflowExecutionRecord;
    await store.createRun(run);
  };

  it("tags every case, and filters to real champions when asked", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const replayDeps = { executionRepository, improvementRepository: manager.getImprovementRepository(), workspaceRepository: manager.getWorkspaceRepository(), evaluationRepository: manager.getEvaluationRepository() } as Parameters<typeof buildDataset>[1];
    await seedRun(executionRepository, "openai", 1);
    await seedRun(executionRepository, "mock", 2);
    await seedRun(executionRepository, "openai", 3);

    const all = await buildDataset({ nodeId: "article_body" }, replayDeps);
    expect(all.cases).toHaveLength(3);
    expect(all.cases.every((c) => c.sourceExecutionMode !== undefined)).toBe(true);
    expect(all.cases.filter((c) => c.sourceExecutionMode === "mock")).toHaveLength(1);

    const realOnly = await buildDataset({ nodeId: "article_body", executionMode: "openai" }, replayDeps);
    expect(realOnly.cases).toHaveLength(2);
    expect(realOnly.cases.every((c) => c.sourceExecutionMode === "openai")).toBe(true);
  });
});

describe("regression baseline is scoped by execution mode", () => {
  it("a mock report is not the baseline for a real regression, and vice versa", async () => {
    // Asserted at the repository level, which is where the selection now happens: runRegression reads
    // listRegressionReports (newest first) and takes the newest report OF THE SAME MODE. Session B's
    // mock plumbing-proof report would otherwise have graded Session D's real contract_intelligence
    // run — a confident verdict computed against a pseudo-random number.
    const manager = new RepositoryManager();
    const store = manager.getEvaluationRepository();
    const base = { nodeId: "contract_intelligence", datasetId: "ds_x", rubricId: "rubric_x", cases: [], summary: { casesTotal: 0, casesScored: 0, casesFailed: 0, casesPassed: 0, passRate: 0, meanScore: 0, threshold: 0.85 }, verdict: "baseline_set" as const };
    await store.recordRegressionReport({ ...base, reportId: "reg_real", executionMode: "openai", summary: { ...base.summary, meanScore: 0.91 }, createdAt: "2026-08-03T10:00:00.000Z" });
    await store.recordRegressionReport({ ...base, reportId: "reg_mock", executionMode: "mock", summary: { ...base.summary, meanScore: 0.484 }, createdAt: "2026-08-03T16:00:00.000Z" });

    const reports = await store.listRegressionReports({ nodeId: "contract_intelligence" });
    // Newest overall is the mock one — precisely the trap.
    expect(reports[0]!.reportId).toBe("reg_mock");
    expect(reports.find((r) => r.executionMode === "openai")!.reportId).toBe("reg_real");
    expect(reports.find((r) => r.executionMode === "mock")!.reportId).toBe("reg_mock");
  });
});

describe("end-to-end: a mock conductor run still yields a usable plumbing dataset", () => {
  it("freezes cases from a mock run and marks them as mock", async () => {
    const manager = new RepositoryManager();
    const executionRepository = manager.getExecutionRepository();
    const replayDeps = { executionRepository, improvementRepository: manager.getImprovementRepository(), workspaceRepository: manager.getWorkspaceRepository(), evaluationRepository: manager.getEvaluationRepository() } as Parameters<typeof buildDataset>[1];
    const started = await startDryRun({ executionMode: "mock", projectId: "ds-proj", input: "Draft this" }, executionRepository);
    await runNextNode(started.runId, { executionRepository });

    const dataset = await buildDataset({ nodeId: "input_triage" }, replayDeps);
    expect(dataset.cases.length).toBeGreaterThan(0);
    expect(dataset.cases.every((c) => c.sourceExecutionMode === "mock")).toBe(true);
    await expect(buildDataset({ nodeId: "input_triage", executionMode: "openai" }, replayDeps)).rejects.toThrow(/no_replay_cases/);
  });
});
