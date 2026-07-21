import { beforeAll, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { runConductorJob } from "../../../src/agent/entrypoints/runConductorJob.js";
import { runRegression, type RegressionDeps } from "../../../src/agent/improvement/regression.js";
import type { EvalRubric } from "../../../src/agent/improvement/improvementTypes.js";

const deps = (): RegressionDeps => ({
  workspaceRepository: repositoryManager.getWorkspaceRepository(),
  executionRepository: repositoryManager.getExecutionRepository(),
  improvementRepository: repositoryManager.getImprovementRepository(),
  evaluationRepository: repositoryManager.getEvaluationRepository()
});

const rubricFor = (nodeId: string): EvalRubric => ({
  rubricId: `rubric_reg_${nodeId}`,
  nodeId,
  name: `${nodeId} regression rubric`,
  description: "Scaffold rubric for the regression gate.",
  status: "active",
  criteria: [
    { id: "clarity", name: "Clarity", description: "Clear and readable", weight: 0.5, scaleMax: 5 },
    { id: "completeness", name: "Completeness", description: "Covers the brief", weight: 0.5, scaleMax: 5 }
  ],
  passThreshold: 0,
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

// One mock conductor run seeds completed executions (frozen-replay source) for every node the gate
// tests below target. Distinct nodes per test keep each node's regression-report history isolated
// despite the process-static memory repositories.
beforeAll(async () => {
  const seeded = await runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "Regression gate seed" });
  expect(seeded.outcome).toBe("blocked");
});

describe("per-node regression gate", () => {
  it("first run stores a baseline; an identical re-run holds; per-case scores are recorded", async () => {
    await repositoryManager.getEvaluationRepository().createRubric(rubricFor("draft_writer"));

    const first = await runRegression({ nodeId: "draft_writer", mode: "mock" }, deps());
    expect(first.verdict).toBe("baseline_set");
    expect(first.baseline).toBeUndefined();
    expect(first.summary.casesScored).toBeGreaterThanOrEqual(1);
    // Per-case scores + pass/fail are present.
    const scoredCase = first.cases.find((entry) => entry.status === "completed");
    expect(scoredCase).toBeDefined();
    expect(typeof scoredCase!.normalizedScore).toBe("number");
    expect(typeof scoredCase!.pass).toBe("boolean");

    // Deterministic mock outputs → identical aggregate → held, compared against the last stored baseline.
    const second = await runRegression({ nodeId: "draft_writer", mode: "mock" }, deps());
    expect(second.verdict).toBe("held");
    expect(second.baseline?.reportId).toBe(first.reportId);
    expect(second.delta?.meanScore).toBe(0);
  });

  it("regresses against a stricter stored baseline (a deliberately worse-than-baseline outcome)", async () => {
    const evaluationRepository = repositoryManager.getEvaluationRepository();
    await evaluationRepository.createRubric(rubricFor("research"));

    // Establish the real mock aggregate for this node.
    const baselineRun = await runRegression({ nodeId: "research", mode: "mock" }, deps());
    expect(baselineRun.verdict).toBe("baseline_set");

    // Raise the bar: store a newer baseline whose mean is strictly above what the node can score, so
    // the next (unchanged) run regresses against it. The far-future timestamp makes it the latest.
    await evaluationRepository.recordRegressionReport({
      ...baselineRun,
      reportId: "reg_research_strict_baseline",
      summary: { ...baselineRun.summary, meanScore: baselineRun.summary.meanScore + 0.5 },
      verdict: "baseline_set",
      baseline: undefined,
      delta: undefined,
      createdAt: "2999-01-01T00:00:00.000Z"
    });

    const regressed = await runRegression({ nodeId: "research", mode: "mock" }, deps());
    expect(regressed.verdict).toBe("regressed");
    expect(regressed.baseline?.reportId).toBe("reg_research_strict_baseline");
    expect(regressed.delta!.meanScore).toBeLessThan(0);
  });

  it("is a report-only gate exposed via MCP: no promotion, no publish, no workspace mutation", async () => {
    const tools = createWorkspaceTools({});
    const runRegressionTool = tools.find((tool) => tool.name === "evaluation.run_regression");
    expect(runRegressionTool).toBeDefined();
    expect(tools.some((tool) => tool.name === "evaluation.list_regression_reports")).toBe(true);

    await repositoryManager.getEvaluationRepository().createRubric(rubricFor("angle_strategy"));
    const versionBefore = await repositoryManager.getWorkspaceRepository().getWorkspaceVersion();
    const promptBefore = (await repositoryManager.getWorkspaceRepository().getNode("angle_strategy"))?.prompt;

    const result = (await runRegressionTool!.execute({ nodeId: "angle_strategy", mode: "mock" })) as { ok: true; data: { report: { verdict: string; nodeId: string } } };
    expect(result.data.report.nodeId).toBe("angle_strategy");
    expect(result.data.report.verdict).toBe("baseline_set");

    // Gate reports only: the node definition and workspace version are untouched, and nothing was
    // promoted (promotion stays the explicit optimizer.promote / human path).
    expect(await repositoryManager.getWorkspaceRepository().getWorkspaceVersion()).toBe(versionBefore);
    expect((await repositoryManager.getWorkspaceRepository().getNode("angle_strategy"))?.prompt).toBe(promptBefore);
    const proposals = await repositoryManager.getImprovementRepository().listProposals({ nodeId: "angle_strategy" });
    expect(proposals.filter((proposal) => proposal.status === "promoted")).toEqual([]);

    // The report is retrievable through the read tool.
    const listed = (await tools.find((tool) => tool.name === "evaluation.list_regression_reports")!.execute({ nodeId: "angle_strategy" })) as { ok: true; data: { reports: unknown[] } };
    expect(listed.data.reports.length).toBeGreaterThanOrEqual(1);
  });
});
