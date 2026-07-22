import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptimizerDeps } from "../../src/agent/improvement/optimizer.js";
import type { ImprovementProposal, TrialRecord } from "../../src/agent/improvement/improvementTypes.js";
import { stableHash } from "../../src/agent/improvement/improvementTypes.js";
import type { WorkspaceNode } from "../../src/agent/workspace/nodeTypes.js";
import {
  autoPromoteEnabled,
  autoPromoteMinScore,
  autoPromoteMax,
  isLowRisk,
  autoPromoteProposals
} from "../../src/agent/improvement/autoPromote.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";
import { runConductorJob } from "../../src/agent/entrypoints/runConductorJob.js";

// Phase 7 (docs/platform/DIRECTION.md §7): eval-gated auto-promotion. optimizer.promote stays the
// human path; this promotes ONLY trial-proven proposals for LOW-RISK nodes, flag-gated OFF. These
// tests pin the flags, the low-risk gate, the trial eval gate, dry-run, and real promotion through the
// versioned funnel. As with the reflection tests, the memory store is process-static, so each real
// promotion uses a DISTINCT canonical node.

const AUTO_ENV = ["IMPROVEMENT_AUTO_PROMOTE", "IMPROVEMENT_AUTO_PROMOTE_MIN_SCORE", "IMPROVEMENT_AUTO_PROMOTE_MAX"];
const clearAutoEnv = () => { for (const key of AUTO_ENV) delete process.env[key]; };

let counter = 0;
const proposal = (over: Partial<ImprovementProposal> & Pick<ImprovementProposal, "nodeId" | "baselinePromptHash">): ImprovementProposal => ({
  proposalId: `prop_${counter++}`,
  status: "trialed",
  diagnosis: "test",
  change: { kind: "prompt", prompt: "IMPROVED PROMPT" },
  evidence: {},
  trialIds: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over
});
const winningTrial = (proposalId: string, nodeId: string, over: Partial<TrialRecord["summary"]> = {}): TrialRecord => ({
  trialId: `trial_${counter++}`,
  proposalId,
  nodeId,
  datasetId: "ds_test",
  variant: { promptOverride: "IMPROVED PROMPT" },
  executionMode: "mock",
  status: "completed",
  cases: [],
  summary: { championWins: 0, challengerWins: 2, ties: 0, inconsistent: 0, casesFailed: 0, meanChallengerScore: 0.9, ...over },
  createdAt: "2026-07-01T00:00:00.000Z"
});

const stubDeps = (over: { getNode?: (id: string) => Promise<Partial<WorkspaceNode> | undefined>; listProposals?: () => Promise<ImprovementProposal[]>; listTrials?: (a: { proposalId?: string }) => Promise<TrialRecord[]> } = {}): OptimizerDeps => ({
  workspaceRepository: { getNode: over.getNode ?? (async () => undefined) } as unknown as OptimizerDeps["workspaceRepository"],
  executionRepository: {} as unknown as OptimizerDeps["executionRepository"],
  improvementRepository: { listProposals: over.listProposals ?? (async () => []), listTrials: over.listTrials ?? (async () => []), saveProposal: async (p: unknown) => p } as unknown as OptimizerDeps["improvementRepository"],
  evaluationRepository: {} as unknown as OptimizerDeps["evaluationRepository"]
});

describe("auto-promote flags", () => {
  afterEach(clearAutoEnv);
  it("is OFF by default and treats only truthy strings as enabled", () => {
    delete process.env.IMPROVEMENT_AUTO_PROMOTE; expect(autoPromoteEnabled()).toBe(false);
    for (const on of ["true", "1", "on", "yes"]) { process.env.IMPROVEMENT_AUTO_PROMOTE = on; expect(autoPromoteEnabled()).toBe(true); }
    for (const off of ["false", "0", "", "no"]) { process.env.IMPROVEMENT_AUTO_PROMOTE = off; expect(autoPromoteEnabled()).toBe(false); }
  });
  it("min score defaults to 0.7 (override, out-of-range falls back)", () => {
    delete process.env.IMPROVEMENT_AUTO_PROMOTE_MIN_SCORE; expect(autoPromoteMinScore()).toBe(0.7);
    process.env.IMPROVEMENT_AUTO_PROMOTE_MIN_SCORE = "0.85"; expect(autoPromoteMinScore()).toBe(0.85);
    for (const bad of ["-1", "1.5", "abc"]) { process.env.IMPROVEMENT_AUTO_PROMOTE_MIN_SCORE = bad; expect(autoPromoteMinScore()).toBe(0.7); }
  });
  it("max defaults to 3 (override, invalid falls back)", () => {
    delete process.env.IMPROVEMENT_AUTO_PROMOTE_MAX; expect(autoPromoteMax()).toBe(3);
    process.env.IMPROVEMENT_AUTO_PROMOTE_MAX = "10"; expect(autoPromoteMax()).toBe(10);
    for (const bad of ["0", "abc", ""]) { process.env.IMPROVEMENT_AUTO_PROMOTE_MAX = bad; expect(autoPromoteMax()).toBe(3); }
  });
});

describe("isLowRisk", () => {
  it("treats read/write as low risk and publish/admin as not", () => {
    expect(isLowRisk({ riskLevel: "read" } as WorkspaceNode)).toBe(true);
    expect(isLowRisk({ riskLevel: "write" } as WorkspaceNode)).toBe(true);
    expect(isLowRisk({ riskLevel: "publish" } as WorkspaceNode)).toBe(false);
    expect(isLowRisk({ riskLevel: "admin" } as WorkspaceNode)).toBe(false);
  });
});

describe("autoPromoteProposals gating (stub deps)", () => {
  it("considers only trialed proposals (fresh 'proposed' / already 'promoted' are ignored)", async () => {
    const listProposals = async () => [
      proposal({ proposalId: "p_fresh", nodeId: "n", baselinePromptHash: "h", status: "proposed" }),
      proposal({ proposalId: "p_done", nodeId: "n", baselinePromptHash: "h", status: "promoted" })
    ];
    const result = await autoPromoteProposals({}, stubDeps({ listProposals }));
    expect(result.promoted).toEqual([]);
    expect(result.eligible).toEqual([]);
    expect(result.skipped).toEqual([]); // neither is even a candidate
  });

  it("skips a trialed proposal on a publish/admin node (never crosses the publish gate)", async () => {
    const result = await autoPromoteProposals({}, stubDeps({
      getNode: async () => ({ riskLevel: "publish", prompt: "P" }),
      listProposals: async () => [proposal({ proposalId: "p1", nodeId: "publication_controller", baselinePromptHash: "h" })],
      listTrials: async () => [winningTrial("p1", "publication_controller")]
    }));
    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual([{ proposalId: "p1", nodeId: "publication_controller", reason: "not_low_risk" }]);
  });

  it("skips a trialed proposal whose trial does not clear the bar", async () => {
    const cases = [
      { label: "challenger not winning", trial: winningTrial("p1", "n", { challengerWins: 1, championWins: 2 }) },
      { label: "below score", trial: winningTrial("p1", "n", { meanChallengerScore: 0.5 }) },
      { label: "a case failed", trial: winningTrial("p1", "n", { casesFailed: 1 }) }
    ];
    for (const { trial } of cases) {
      const result = await autoPromoteProposals({}, stubDeps({
        getNode: async () => ({ riskLevel: "write", prompt: "P" }),
        listProposals: async () => [proposal({ proposalId: "p1", nodeId: "n", baselinePromptHash: "h" })],
        listTrials: async () => [trial]
      }));
      expect(result.skipped).toEqual([{ proposalId: "p1", nodeId: "n", reason: "trial_below_bar" }]);
      expect(result.promoted).toEqual([]);
    }
  });

  it("dry-run reports eligibility without promoting", async () => {
    const result = await autoPromoteProposals({ dryRun: true }, stubDeps({
      getNode: async () => ({ riskLevel: "write", prompt: "P" }),
      listProposals: async () => [proposal({ proposalId: "p1", nodeId: "n", baselinePromptHash: "h" })],
      listTrials: async () => [winningTrial("p1", "n")]
    }));
    expect(result.dryRun).toBe(true);
    expect(result.eligible).toEqual([{ proposalId: "p1", nodeId: "n" }]);
    expect(result.promoted).toEqual([]);
  });
});

describe("autoPromoteProposals promotion (real repositories)", () => {
  beforeEach(() => { clearAutoEnv(); resetRepositoryManager(); });
  afterEach(() => { clearAutoEnv(); resetRepositoryManager(); });

  const realDeps = (): OptimizerDeps => ({
    workspaceRepository: repositoryManager.getWorkspaceRepository(),
    executionRepository: repositoryManager.getExecutionRepository(),
    improvementRepository: repositoryManager.getImprovementRepository(),
    evaluationRepository: repositoryManager.getEvaluationRepository()
  });

  // Seed a trialed proposal + winning trial for a real low-risk node, with the baseline hash pinned to
  // the node's CURRENT prompt (so promoteProposal's stale-baseline guard passes).
  const seedTrialed = async (nodeId: string, baselinePromptHash: string, proposalId: string) => {
    const improvement = repositoryManager.getImprovementRepository();
    await improvement.saveProposal(proposal({ proposalId, nodeId, baselinePromptHash, change: { kind: "prompt", prompt: `PROMOTED ${nodeId}` } }));
    await improvement.saveTrial(winningTrial(proposalId, nodeId));
  };

  it("promotes a trial-proven proposal for a low-risk node through the versioned funnel", async () => {
    const ws = repositoryManager.getWorkspaceRepository();
    const node = await ws.getNode("research");
    await seedTrialed("research", stableHash(node!.prompt), "p_research");

    const result = await autoPromoteProposals({ nodeId: "research" }, realDeps());
    expect(result.promoted.map((entry) => entry.proposalId)).toEqual(["p_research"]);
    expect(result.promoted[0]!.workspaceVersion).toBeGreaterThan(0);

    expect((await ws.getNode("research"))!.prompt).toBe("PROMOTED research");
    expect((await repositoryManager.getImprovementRepository().getProposal("p_research"))!.status).toBe("promoted");
  });

  it("dry-run leaves the node untouched", async () => {
    const ws = repositoryManager.getWorkspaceRepository();
    const node = await ws.getNode("angle_strategy");
    const before = node!.prompt;
    await seedTrialed("angle_strategy", stableHash(before), "p_angle");

    const result = await autoPromoteProposals({ nodeId: "angle_strategy", dryRun: true }, realDeps());
    expect(result.eligible.map((entry) => entry.proposalId)).toEqual(["p_angle"]);
    expect(result.promoted).toEqual([]);
    expect((await ws.getNode("angle_strategy"))!.prompt).toBe(before);
    expect((await repositoryManager.getImprovementRepository().getProposal("p_angle"))!.status).toBe("trialed");
  });

  it("isolates a stale-baseline failure into errors and never throws", async () => {
    // baselinePromptHash pinned to a prompt the node no longer has → promoteProposal throws stale_baseline.
    await seedTrialed("objection_mapping", stableHash("A DIFFERENT OLD PROMPT"), "p_stale");
    const result = await autoPromoteProposals({ nodeId: "objection_mapping" }, realDeps());
    expect(result.promoted).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.proposalId).toBe("p_stale");
    expect(result.errors[0]!.message).toContain("stale_baseline");
  });
});

describe("conductor fires auto-promotion on completion (integration)", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => { clearAutoEnv(); resetRepositoryManager(); });
  afterEach(() => { process.env = { ...savedEnv }; resetRepositoryManager(); });

  const seedTrialed = async (nodeId: string, proposalId: string) => {
    const ws = repositoryManager.getWorkspaceRepository();
    const node = await ws.getNode(nodeId);
    const improvement = repositoryManager.getImprovementRepository();
    await improvement.saveProposal(proposal({ proposalId, nodeId, baselinePromptHash: stableHash(node!.prompt), change: { kind: "prompt", prompt: `AUTO ${nodeId}` } }));
    await improvement.saveTrial(winningTrial(proposalId, nodeId));
  };
  const run = () => runConductorJob({ projectId: "dr-lurie", executionMode: "mock", input: "auto-promote integration", approved: true });

  it("promotes a ripe proposal when a run completes with the flag on", async () => {
    process.env.IMPROVEMENT_AUTO_PROMOTE = "true";
    process.env.IMPROVEMENT_AUTO_PROMOTE_MAX = "50"; // never starve our target behind accumulated proposals
    await seedTrialed("input_triage", "p_ci_on");
    const result = await run();
    expect(result.outcome).toBe("completed");
    expect((await repositoryManager.getImprovementRepository().getProposal("p_ci_on"))!.status).toBe("promoted");
    expect((await repositoryManager.getWorkspaceRepository().getNode("input_triage"))!.prompt).toBe("AUTO input_triage");
  });

  it("does not auto-promote when the flag is off (default)", async () => {
    delete process.env.IMPROVEMENT_AUTO_PROMOTE;
    await seedTrialed("topic_opportunity", "p_ci_off");
    const before = (await repositoryManager.getWorkspaceRepository().getNode("topic_opportunity"))!.prompt;
    const result = await run();
    expect(result.outcome).toBe("completed");
    expect((await repositoryManager.getImprovementRepository().getProposal("p_ci_off"))!.status).toBe("trialed");
    expect((await repositoryManager.getWorkspaceRepository().getNode("topic_opportunity"))!.prompt).toBe(before);
  });
});
