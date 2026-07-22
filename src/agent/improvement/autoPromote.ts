// Eval-gated automatic promotion (docs/platform/DIRECTION.md Phase 7). Promotion is human-approved by
// design — optimizer.promote is an explicit call. This adds an OPT-IN automatic path for the safest
// subset: a proposal whose champion/challenger TRIAL already proves the change is better, for a
// LOW-RISK node (never a publish/admin node). It is deliberately narrow:
//   • Gated by IMPROVEMENT_AUTO_PROMOTE — default OFF, so promotion stays human-only unless an operator
//     opts in. The reflection hook only invokes this when the flag is on; the MCP tool is an explicit
//     human action (which IS approval) and can dry-run.
//   • EVAL-GATED: only a "trialed" proposal whose newest trial completed with no case failures, a
//     challenger-wins majority, AND meanChallengerScore >= threshold qualifies. A fresh ("proposed")
//     proposal — e.g. one just drafted by post-run reflection — is never auto-promoted; it has no trial
//     evidence yet. (Auto-TRIALING is a separate, not-yet-wired step.)
//   • LOW-RISK ONLY: publish/admin nodes are always skipped — the publish gate is never crossed
//     automatically.
//   • SAFE FUNNEL: promotion still goes through promoteProposal (the versioned mutate() path with the
//     stale-baseline guard), so every auto-promotion is attributable and one-step reversible via
//     changes.restore. Best-effort: a per-proposal error never aborts the pass.
import type { WorkspaceNode } from "../workspace/nodeTypes.js";
import type { WorkspaceActor } from "../workspace/changeTypes.js";
import type { ImprovementProposal, TrialRecord } from "./improvementTypes.js";
import { promoteProposal, type OptimizerDeps } from "./optimizer.js";

const truthy = (value: string | undefined): boolean => /^(1|true|on|yes)$/i.test(value?.trim() ?? "");

export const autoPromoteEnabled = (): boolean => truthy(process.env.IMPROVEMENT_AUTO_PROMOTE);

// Minimum meanChallengerScore (0..1) a trial must reach for its proposal to auto-promote. Default 0.7;
// an out-of-range / NaN value falls back to the default.
export const autoPromoteMinScore = (): number => {
  const value = Number(process.env.IMPROVEMENT_AUTO_PROMOTE_MIN_SCORE);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.7;
};

// Max promotions per pass (a safety bound). Default 3; non-positive / NaN falls back to the default.
export const autoPromoteMax = (): number => {
  const value = Number(process.env.IMPROVEMENT_AUTO_PROMOTE_MAX);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3;
};

// A publish/admin node is never auto-promoted — the publish gate is never crossed automatically.
export const isLowRisk = (node: WorkspaceNode): boolean => node.riskLevel !== "publish" && node.riskLevel !== "admin";

export type AutoPromoteSkipReason = "not_trialed" | "not_low_risk" | "trial_below_bar" | "unknown_node" | "max_reached";
export type AutoPromoteResult = {
  enabled: boolean;
  dryRun: boolean;
  minScore: number;
  promoted: Array<{ proposalId: string; nodeId: string; workspaceVersion?: number }>;
  eligible: Array<{ proposalId: string; nodeId: string }>;   // dry-run: what WOULD promote
  skipped: Array<{ proposalId: string; nodeId: string; reason: AutoPromoteSkipReason }>;
  errors: Array<{ proposalId: string; message: string }>;
};

// The eval gate: the newest trial must be a decisive, clean challenger win at or above the score bar.
const trialClearsBar = (trial: TrialRecord | undefined, minScore: number): boolean =>
  !!trial && trial.status === "completed" && trial.summary.casesFailed === 0 &&
  trial.summary.challengerWins > trial.summary.championWins && trial.summary.meanChallengerScore >= minScore;

// Scan trialed proposals and promote (or, in dryRun, list) the eval-qualified ones for low-risk nodes.
// NEVER throws: each proposal is isolated. Does not check the env flag — the caller decides whether to
// invoke (the reflection hook gates on autoPromoteEnabled(); the MCP tool is an explicit human call).
export async function autoPromoteProposals(params: { nodeId?: string; dryRun?: boolean; minScore?: number; max?: number; actor?: string | WorkspaceActor }, deps: OptimizerDeps): Promise<AutoPromoteResult> {
  const dryRun = params.dryRun ?? false;
  const minScore = params.minScore ?? autoPromoteMinScore();
  const max = params.max ?? autoPromoteMax();
  const result: AutoPromoteResult = { enabled: autoPromoteEnabled(), dryRun, minScore, promoted: [], eligible: [], skipped: [], errors: [] };

  // Only trialed proposals carry the eval evidence auto-promotion requires.
  const proposals = (await deps.improvementRepository.listProposals(params.nodeId ? { nodeId: params.nodeId } : {}))
    .filter((proposal: ImprovementProposal) => proposal.status === "trialed");

  for (const proposal of proposals) {
    try {
      const node = await deps.workspaceRepository.getNode(proposal.nodeId);
      if (!node) { result.skipped.push({ proposalId: proposal.proposalId, nodeId: proposal.nodeId, reason: "unknown_node" }); continue; }
      if (!isLowRisk(node)) { result.skipped.push({ proposalId: proposal.proposalId, nodeId: proposal.nodeId, reason: "not_low_risk" }); continue; }
      const bestTrial = (await deps.improvementRepository.listTrials({ proposalId: proposal.proposalId }))[0];
      if (!trialClearsBar(bestTrial, minScore)) { result.skipped.push({ proposalId: proposal.proposalId, nodeId: proposal.nodeId, reason: "trial_below_bar" }); continue; }
      if (result.promoted.length >= max) { result.skipped.push({ proposalId: proposal.proposalId, nodeId: proposal.nodeId, reason: "max_reached" }); continue; }
      if (dryRun) { result.eligible.push({ proposalId: proposal.proposalId, nodeId: proposal.nodeId }); continue; }
      const reason = `auto-promote: eval-gated (trial challenger ${bestTrial!.summary.challengerWins}W/${bestTrial!.summary.championWins}L, mean ${bestTrial!.summary.meanChallengerScore} >= ${minScore}); low-risk node.`;
      const { workspaceVersion } = await promoteProposal({ proposalId: proposal.proposalId, meta: { actor: params.actor ?? { kind: "system", label: "auto_promote" }, reason, summary: `Auto-promote proposal ${proposal.proposalId}` } }, deps);
      result.promoted.push({ proposalId: proposal.proposalId, nodeId: proposal.nodeId, workspaceVersion });
    } catch (error) {
      result.errors.push({ proposalId: proposal.proposalId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
