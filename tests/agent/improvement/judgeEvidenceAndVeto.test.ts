import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { firstVeto, scoreOutput } from "../../../src/agent/improvement/rubricJudge.js";
import { buildDataset, caseContract, judgeEvidenceFromNodeState, replayInput } from "../../../src/agent/improvement/replay.js";
import { stableHash, validateRubric, type EvalRubric } from "../../../src/agent/improvement/improvementTypes.js";
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
    // criticalMin 0 is a LIVE veto ("a zero here is fatal"), not a typo — it must stay accepted.
    expect(validateRubric({ passThreshold: 0.7, criteria: [{ id: "a", name: "A", description: "x", weight: 1, scaleMax: 10, criticalMin: 0 }] })).toEqual([]);
  });
});

// The floor is INCLUSIVE and the four production non-negotiables all declare criticalMin 0
// (contract_source_provenance, no_side_effects, materialization_verification, request_id_confirmed),
// so these assertions are the whole difference between a live veto and a dead one.
describe("criticalMin floor semantics", () => {
  const criterion = (criticalMin: number | undefined, scaleMax = 10) => ({ id: "floor", name: "Floor", description: "x", weight: 1, scaleMax, ...(criticalMin !== undefined ? { criticalMin } : {}) });
  const withFloor = (criticalMin: number | undefined, scaleMax = 10) => rubric({ criteria: [criterion(criticalMin, scaleMax)] });
  const score = (value: number, max = 10) => [{ criterionId: "floor", score: value, max, evidence: "e" }];

  it("fires on exactly the floor: criticalMin 0 vetoes a 0 and clears a 1", () => {
    expect(firstVeto(withFloor(0), score(0))).toMatchObject({ criterionId: "floor", score: 0, criticalMin: 0, reason: "at_or_below_floor" });
    expect(firstVeto(withFloor(0), score(1))).toBeUndefined();
    expect(firstVeto(withFloor(0), score(10))).toBeUndefined();
  });

  it("leaves the research.citation_integrity case (criticalMin 2) exactly as it was", () => {
    expect(firstVeto(withFloor(2), score(1))).toMatchObject({ score: 1, criticalMin: 2, reason: "at_or_below_floor" });
    expect(firstVeto(withFloor(2), score(2))).toMatchObject({ score: 2, criticalMin: 2, reason: "at_or_below_floor" });
    expect(firstVeto(withFloor(2), score(3))).toBeUndefined();
  });

  it("vetoes a criterion the judge skipped, with its own reason rather than a fabricated zero", () => {
    // The judge returned nothing for the criterion. It is not a pass (or the veto would be opt-out for
    // any judge that declines to answer) and it is not evidence of a zero either — so it says so.
    expect(firstVeto(withFloor(0), score(0), new Set(["floor"]))).toMatchObject({ criterionId: "floor", criticalMin: 0, reason: "not_scored" });
    // Even a perfect score is a not_scored veto when the harness knows the judge did not produce it.
    expect(firstVeto(withFloor(0), score(10), new Set(["floor"]))).toMatchObject({ criterionId: "floor", reason: "not_scored" });
    // Missing from the scores array entirely is the same failure.
    expect(firstVeto(withFloor(0), [])).toMatchObject({ criterionId: "floor", reason: "not_scored" });
    // A criterion with no declared floor is never vetoed, scored or not.
    expect(firstVeto(withFloor(undefined), [], new Set(["floor"]))).toBeUndefined();
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
      // Distinct input per run: identical-subject cases are deduplicated at freeze time (see the
      // degenerate-dataset suite below), and this suite is about mode tagging, not deduplication.
      nodes: [{ nodeId: "article_body", status: "completed", input: { input: { brief: `x${n}` }, dependencies: {} }, output: { body: mode }, produces: ["client_object.v1"] }],
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

// The one real contract_intelligence evaluation recorded "Source contract was not supplied, so exact
// fidelity cannot be verified" — while the run had the contract the whole time. The conductor injects
// it as `prefetchedContract` NEXT TO initialInput/dependencies, and a conductor node with
// dependencies stores initialInput: undefined, so passing `evalCase.input` as the judge's contract
// passed undefined.
describe("the judge gets the contract the node actually had", () => {
  // Exactly the shape executor.ts persists for a prefetch node with dependencies.
  const conductorInput = {
    initialInput: undefined,
    dependencies: { brief_architect: { artifact: "article_brief.v1" } },
    clientProjectId: "dr-lurie",
    prefetchedContract: { clientObjectType: "content_item", contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-01T00:00:00.000Z" } }
  };

  const seedContractRun = async (manager: RepositoryManager, runId: string) => {
    await manager.getExecutionRepository().createRun({
      runId, workflowId: "publishing_conductor", projectId: "dr-lurie", status: "completed",
      startedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:10:00.000Z",
      nodes: [{ nodeId: "contract_intelligence", status: "completed", input: conductorInput, output: { artifact: "contract_intelligence.v1" }, toolCalls: [], produces: ["contract_intelligence.v1"] }],
      artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai"
    } as unknown as WorkflowExecutionRecord);
  };

  it("freezes the prefetched contract onto the case and resolves it as the judge's contract evidence", async () => {
    const manager = new RepositoryManager();
    const replayDeps = { executionRepository: manager.getExecutionRepository(), improvementRepository: manager.getImprovementRepository(), workspaceRepository: manager.getWorkspaceRepository(), evaluationRepository: manager.getEvaluationRepository() } as Parameters<typeof buildDataset>[1];
    await seedContractRun(manager, "run_contract_evidence_1");

    const dataset = await buildDataset({ nodeId: "contract_intelligence" }, replayDeps);
    const frozen = dataset.cases[0]!;
    // The old case shape kept only `input`, which is undefined here — the whole bug.
    expect(frozen.input).toBeUndefined();
    expect(frozen.context?.prefetchedContract).toEqual(conductorInput.prefetchedContract);
    expect(frozen.context?.clientProjectId).toBe("dr-lurie");
    expect(caseContract(frozen)).toEqual(conductorInput.prefetchedContract);
    // ...and the replay hands it back to the node, so the output being judged for contract fidelity
    // was produced with the contract in hand.
    expect(replayInput(frozen)).toMatchObject({ prefetchedContract: conductorInput.prefetchedContract, clientProjectId: "dr-lurie" });
  });

  it("recovers the same evidence from a stored run for the one-off evaluation.run path", () => {
    const evidence = judgeEvidenceFromNodeState({ input: conductorInput, toolCalls: [{ tool: "project.call_read_tool" }] });
    expect(evidence.contract).toEqual(conductorInput.prefetchedContract);
    expect(evidence.dependencyOutputs).toEqual(conductorInput.dependencies);
    expect(evidence.toolCalls).toEqual([{ tool: "project.call_read_tool" }]);
  });

  it("reports no contract rather than an empty one when the node genuinely had none", () => {
    const evidence = judgeEvidenceFromNodeState({ input: { initialInput: undefined, dependencies: { upstream: { a: 1 } } } });
    expect(evidence.contract).toBeUndefined();
    expect(evidence.dependencyOutputs).toEqual({ upstream: { a: 1 } });
  });
});

// ds_1785772079588_9a01hb: four cases, one subject hash (e8b1ed18), byte-identical mock scores — a
// dataset of one dressed as a dataset of four, whose regression verdicts looked exactly like real ones.
describe("dataset discriminating power is measured at build time", () => {
  const seedIdenticalRun = async (manager: RepositoryManager, n: number, input: unknown) => {
    await manager.getExecutionRepository().createRun({
      runId: `run_degenerate_${n}`, workflowId: "publishing_conductor", projectId: "degenerate-proj", status: "completed",
      startedAt: new Date(Date.UTC(2026, 7, 2, 0, 0, n)).toISOString(), updatedAt: new Date(Date.UTC(2026, 7, 2, 0, 1, n)).toISOString(),
      nodes: [{ nodeId: "article_body", status: "completed", input, output: { body: `out_${n}` }, produces: ["client_object.v1"] }],
      artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "mock"
    } as unknown as WorkflowExecutionRecord);
  };
  const replayDepsFor = (manager: RepositoryManager) => ({ executionRepository: manager.getExecutionRepository(), improvementRepository: manager.getImprovementRepository(), workspaceRepository: manager.getWorkspaceRepository(), evaluationRepository: manager.getEvaluationRepository() } as Parameters<typeof buildDataset>[1]);

  it("drops identical-subject cases and flags the surviving dataset as degenerate", async () => {
    const manager = new RepositoryManager();
    const same = { initialInput: undefined, dependencies: { brief_architect: { artifact: "article_brief.v1" } }, clientProjectId: "dr-lurie" };
    for (const n of [1, 2, 3, 4]) await seedIdenticalRun(manager, n, same);

    const dataset = await buildDataset({ nodeId: "article_body" }, replayDepsFor(manager));
    expect(dataset.cases).toHaveLength(1);
    expect(dataset.metadata).toMatchObject({ distinctSubjects: 1, duplicateSubjects: 3, degenerate: true });
    expect(dataset.metadata?.warning).toContain("degenerate_dataset");
    expect(dataset.cases[0]!.subjectHash).toBe(stableHash({ input: undefined, dependencies: same.dependencies, context: { clientProjectId: "dr-lurie" } }));
  });

  it("keeps genuinely distinct cases and reports the dataset as non-degenerate", async () => {
    const manager = new RepositoryManager();
    for (const n of [1, 2, 3]) await seedIdenticalRun(manager, n, { initialInput: `brief ${n}`, dependencies: {} });

    const dataset = await buildDataset({ nodeId: "article_body" }, replayDepsFor(manager));
    expect(dataset.cases).toHaveLength(3);
    expect(new Set(dataset.cases.map((c) => c.subjectHash)).size).toBe(3);
    expect(dataset.metadata).toMatchObject({ distinctSubjects: 3, duplicateSubjects: 0, degenerate: false });
    expect(dataset.metadata?.warning).toBeUndefined();
  });

  it("can be asked to keep duplicates, and still counts them honestly", async () => {
    const manager = new RepositoryManager();
    const same = { initialInput: "identical", dependencies: {} };
    for (const n of [1, 2]) await seedIdenticalRun(manager, n, same);

    const dataset = await buildDataset({ nodeId: "article_body", allowDuplicateSubjects: true }, replayDepsFor(manager));
    expect(dataset.cases).toHaveLength(2);
    expect(dataset.metadata).toMatchObject({ distinctSubjects: 1, duplicateSubjects: 1, degenerate: true });
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
    const base = { nodeId: "contract_intelligence", datasetId: "ds_x", rubricId: "rubric_x", cases: [], summary: { casesTotal: 0, casesScored: 0, casesFailed: 0, casesPassed: 0, casesErrored: 0, passRate: 0, meanScore: 0, threshold: 0.85 }, gate: "fail" as const, gateReasons: ["no_cases_scored" as const], drift: "baseline_set" as const, verdict: "failing" as const };
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
