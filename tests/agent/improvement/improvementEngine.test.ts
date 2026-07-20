import { describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { runConductorJob } from "../../../src/agent/entrypoints/runConductorJob.js";
import { applyPlaybookDelta, renderPlaybookForPrompt, createEmptyPlaybook } from "../../../src/agent/improvement/playbook.js";
import { scoreOutput, comparePairwise } from "../../../src/agent/improvement/rubricJudge.js";
import type { EvalRubric } from "../../../src/agent/improvement/improvementTypes.js";

const tools = createWorkspaceTools({});
const callTool = async (name: string, input: unknown) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return (await found.execute(input)) as { ok: true; data: any };
};

const rubricFor = (nodeId: string, overrides: Partial<EvalRubric> = {}): EvalRubric => ({
  rubricId: `rubric_${nodeId}_${Math.random().toString(36).slice(2, 8)}`,
  nodeId,
  name: `${nodeId} quality`,
  description: "Scaffold rubric",
  status: "active",
  criteria: [
    { id: "clarity", name: "Clarity", description: "Clear and readable", weight: 0.5, scaleMax: 5 },
    { id: "completeness", name: "Completeness", description: "Covers the brief", weight: 0.5, scaleMax: 5 }
  ],
  passThreshold: 0,
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides
});

const judgeDeps = () => ({ evaluationRepository: repositoryManager.getEvaluationRepository(), executionRepository: repositoryManager.getExecutionRepository() });

// The tool input schema is strict and owns the timestamps server-side; strip them for tool calls.
const toolRubric = (rubric: EvalRubric) => { const { createdAt: _c, updatedAt: _u, ...input } = rubric; return input; };

describe("improvement tool registration", () => {
  it("exposes the evaluation/feedback/dataset/optimizer/playbook namespaces", () => {
    for (const name of ["evaluation.create_rubric", "evaluation.run", "evaluation.list_results", "feedback.record", "dataset.build", "dataset.export_sft", "dataset.export_preferences", "optimizer.analyze", "optimizer.propose", "optimizer.run_trial", "optimizer.promote", "optimizer.status", "playbook.get", "playbook.apply_delta", "playbook.curate", "playbook.migrate_observations"]) {
      expect(tools.some((candidate) => candidate.name === name), name).toBe(true);
    }
  });
});

describe("mock judge", () => {
  it("scores deterministically (same output, same score) and records the result", async () => {
    const rubric = await repositoryManager.getEvaluationRepository().createRubric(rubricFor("input_triage", { passThreshold: 0 }));
    const output = { artifact: "content_source.v1", summary: "Judge me." };
    const first = await scoreOutput({ rubric, nodeId: "input_triage", output, mode: "mock" }, judgeDeps());
    const second = await scoreOutput({ rubric, nodeId: "input_triage", output, mode: "mock" }, judgeDeps());

    expect(first.normalizedScore).toBe(second.normalizedScore);
    expect(first.subjectHash).toBe(second.subjectHash);
    expect(first.pass).toBe(true);
    expect(await repositoryManager.getEvaluationRepository().getResult(first.evalId)).toBeDefined();
  });

  it("pairwise always records BOTH presentation orders and a decisive mock verdict", async () => {
    const rubric = await repositoryManager.getEvaluationRepository().createRubric(rubricFor("input_triage"));
    const comparison = await comparePairwise({ rubric, nodeId: "input_triage", champion: { summary: "A" }, challenger: { summary: "B-different" }, mode: "mock" }, judgeDeps());

    expect(comparison.orderings).toHaveLength(2);
    expect(comparison.orderings.map((ordering) => ordering.order)).toEqual(["champion_first", "challenger_first"]);
    expect(["champion", "challenger", "tie"]).toContain(comparison.verdict);
  });
});

describe("ACE playbook", () => {
  it("dedups adds into counters, enforces the item budget, and renders within the char budget", () => {
    const timestamp = new Date().toISOString();
    let playbook = applyPlaybookDelta(undefined, "n1", { add: [{ text: "Cite sources.", kind: "strategy" }] }, timestamp);
    playbook = applyPlaybookDelta(playbook, "n1", { add: [{ text: "  cite   SOURCES. ", kind: "strategy" }] }, timestamp);
    expect(playbook.items).toHaveLength(1);
    expect(playbook.items[0]!.helpfulCount).toBe(2);

    for (let index = 0; index < 15; index++) playbook = applyPlaybookDelta(playbook, "n1", { add: [{ text: `Lesson number ${index}`, kind: "pitfall" }] }, timestamp);
    expect(playbook.items.filter((item) => item.status === "active").length).toBeLessThanOrEqual(playbook.budget.maxItems);

    const rendered = renderPlaybookForPrompt(playbook);
    expect(rendered.length).toBeLessThanOrEqual(playbook.budget.maxChars);
    expect(rendered).toContain("- (");
  });

  it("retire flips status and empty playbooks render empty", () => {
    const timestamp = new Date().toISOString();
    let playbook = applyPlaybookDelta(undefined, "n2", { add: [{ text: "Temporary lesson", kind: "constraint" }] }, timestamp);
    playbook = applyPlaybookDelta(playbook, "n2", { retire: [playbook.items[0]!.itemId] }, timestamp);
    expect(playbook.items[0]!.status).toBe("retired");
    expect(renderPlaybookForPrompt(playbook)).toBe("");
    expect(renderPlaybookForPrompt(createEmptyPlaybook("n3", timestamp))).toBe("");
  });
});

describe("end-to-end improvement loop (mock mode)", () => {
  it("capture → evaluate → feedback → dataset → propose → trial → promote, with versioned promotion and trial isolation", async () => {
    // Capture: a real conductor mock run supplies the traces.
    const seeded = await runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "Improvement loop E2E" });
    expect(seeded.outcome).toBe("blocked");
    const runId = seeded.run.runId;

    // Evaluate the recorded draft_writer output through the MCP tool surface.
    const rubricResult = await callTool("evaluation.create_rubric", { rubric: toolRubric(rubricFor("draft_writer", { rubricId: undefined as unknown as string })) });
    const rubricId = rubricResult.data.rubric.rubricId;
    const evalResult = await callTool("evaluation.run", { nodeId: "draft_writer", rubricId, runId, mode: "mock" });
    expect(evalResult.data.result.pass).toBe(true);
    expect(evalResult.data.result.runId).toBe(runId);

    await callTool("feedback.record", { kind: "approve", nodeId: "draft_writer", runId, note: "solid draft" });
    const feedback = await callTool("feedback.list", { nodeId: "draft_writer" });
    expect(feedback.data.records.length).toBeGreaterThanOrEqual(1);

    // Freeze the replay dataset from history.
    const dataset = await callTool("dataset.build", { nodeId: "draft_writer" });
    expect(dataset.data.dataset.cases.length).toBeGreaterThanOrEqual(1);
    expect(dataset.data.dataset.cases[0].championOutput).toBeDefined();

    // Diagnose + propose (GEPA-style, deterministic in mock).
    const analysis = await callTool("optimizer.analyze", { nodeId: "draft_writer" });
    expect(analysis.data.analysis.sampleSize).toBeGreaterThanOrEqual(1);
    const proposal = await callTool("optimizer.propose", { nodeId: "draft_writer", mode: "mock" });
    expect(proposal.data.proposal.status).toBe("proposed");
    expect(proposal.data.proposal.change.kind).toBe("prompt");

    // Trial on frozen inputs: workspace state must not move (facade suppresses the stage mirror).
    const versionBeforeTrial = await repositoryManager.getWorkspaceRepository().getWorkspaceVersion();
    const trial = await callTool("optimizer.run_trial", { proposalId: proposal.data.proposal.proposalId, datasetId: dataset.data.dataset.datasetId, mode: "mock", caseLimit: 1 });
    expect(trial.data.trial.status).toBe("completed");
    expect(trial.data.trial.cases[0].status).toBe("completed");
    expect(trial.data.trial.summary.casesFailed).toBe(0);
    expect(await repositoryManager.getWorkspaceRepository().getWorkspaceVersion()).toBe(versionBeforeTrial);
    expect(trial.data.trial.cases[0].runId.startsWith("trial_")).toBe(true);

    // Promote through the versioned funnel; the node prompt changes and a change event is minted.
    const promoted = await callTool("optimizer.promote", { proposalId: proposal.data.proposal.proposalId, actor: { kind: "human", label: "test-operator" } });
    expect(promoted.data.proposal.status).toBe("promoted");
    expect(promoted.data.workspaceVersion).toBeGreaterThan(versionBeforeTrial);
    const node = await repositoryManager.getWorkspaceRepository().getNode("draft_writer");
    expect(node?.prompt).toBe(proposal.data.proposal.change.prompt);
    const events = await repositoryManager.getChangeRepository().listEvents({ nodeId: "draft_writer", limit: 10 });
    expect(JSON.stringify(events)).toContain("optimizer:");

    // Exports produce parseable JSONL with provenance.
    const sft = await callTool("dataset.export_sft", { nodeId: "draft_writer", minScore: 0 });
    expect(sft.data.count).toBeGreaterThanOrEqual(1);
    const firstLine = JSON.parse(sft.data.jsonl.split("\n")[0]);
    expect(firstLine.messages).toHaveLength(3);
    expect(firstLine.metadata.runId).toBeDefined();
    const preferences = await callTool("dataset.export_preferences", { nodeId: "draft_writer" });
    expect(preferences.data.skippedInconsistent).toBe(0);
    if (preferences.data.count > 0) {
      const pair = JSON.parse(preferences.data.jsonl.split("\n")[0]);
      expect(pair.chosen).toBeDefined();
      expect(pair.rejected).toBeDefined();
    }

    // Playbook curation from the accumulated evidence.
    const curated = await callTool("playbook.curate", { nodeId: "draft_writer", mode: "mock" });
    expect(curated.data.curated).toBe(true);
    const playbook = await callTool("playbook.get", { nodeId: "draft_writer" });
    expect(playbook.data.playbook.items.length).toBeGreaterThanOrEqual(1);
    expect(playbook.data.rendered).toContain("- (");
  });

  it("refuses to promote a stale proposal after the node prompt drifted", async () => {
    await runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "stale baseline seed" });
    await callTool("evaluation.create_rubric", { rubric: toolRubric(rubricFor("research")) });
    const proposal = await callTool("optimizer.propose", { nodeId: "research", mode: "mock" });
    await repositoryManager.getWorkspaceRepository().updateNodePrompt("research", "Manually edited after the proposal.", { actor: { kind: "human" } });

    await expect(callTool("optimizer.promote", { proposalId: proposal.data.proposal.proposalId })).rejects.toThrow(/stale_baseline/);
  });

  it("accepts stringified object arguments (MCP client coercion)", async () => {
    const created = await callTool("evaluation.create_rubric", { rubric: JSON.stringify(toolRubric(rubricFor("angle_strategy"))) });
    expect(created.data.rubric.nodeId).toBe("angle_strategy");

    const delta = await callTool("playbook.apply_delta", { nodeId: "angle_strategy", delta: JSON.stringify({ add: [{ text: "Stringified delta lesson", kind: "strategy" }] }) });
    expect(delta.data.playbook.items.some((item: { text: string }) => item.text === "Stringified delta lesson")).toBe(true);
  });

  it("rubric versions snapshot and restore", async () => {
    const evaluationRepository = repositoryManager.getEvaluationRepository();
    const rubric = await evaluationRepository.createRubric(rubricFor("reader_insight", { name: "v1 name" }));
    await evaluationRepository.updateRubric(rubric.rubricId, { name: "v2 name" });
    const versions = await evaluationRepository.listRubricVersions(rubric.rubricId);
    expect(versions.length).toBeGreaterThanOrEqual(2);

    const restored = await evaluationRepository.restoreRubricVersion(rubric.rubricId, versions[0]!.versionId);
    expect(restored.name).toBe("v1 name");
  });

  it("migrate_observations reports the empty case honestly", async () => {
    const migration = await callTool("playbook.migrate_observations", { dryRun: true });
    expect(migration.data.dryRun).toBe(true);
    expect(typeof migration.data.migratedNodes).toBe("number");
  });
});
