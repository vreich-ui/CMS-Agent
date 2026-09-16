import type { RepositoryHealth } from "../RepositoryHealth.js";
import type { PolicyScope } from "../../scope/policyScope.js";
import type { EvalDataset, ImprovementProposal, NodePlaybook, ProposalStatus, TrialRecord } from "../../improvement/improvementTypes.js";

// Optimizer state: frozen replay datasets, proposals, trials, and per-node ACE playbooks.
export interface ImprovementRepository {
  health(): Promise<RepositoryHealth>;
  saveProposal(proposal: ImprovementProposal): Promise<ImprovementProposal>;
  getProposal(proposalId: string): Promise<ImprovementProposal | undefined>;
  listProposals(filters?: { nodeId?: string; status?: ProposalStatus }): Promise<ImprovementProposal[]>;
  saveTrial(trial: TrialRecord): Promise<TrialRecord>;
  getTrial(trialId: string): Promise<TrialRecord | undefined>;
  listTrials(filters?: { nodeId?: string; proposalId?: string }): Promise<TrialRecord[]>;
  saveDataset(dataset: EvalDataset): Promise<EvalDataset>;
  getDataset(datasetId: string): Promise<EvalDataset | undefined>;
  listDatasets(filters?: { nodeId?: string }): Promise<EvalDataset[]>;
  /**
   * C2 (part 2) — a node's playbook AT A SCOPE. Omitting the scope reads the fleet playbook, at the
   * key it has always occupied, which is why introducing scope migrated nothing.
   *
   * Absent means absent: a tenant with no lessons of its own returns `undefined` for its site scope
   * and the caller composes the chain (playbookScopeChain). Nothing is inherited at this layer —
   * inheritance is a rendering decision, made once, in composeScopedPlaybooksForPrompt.
   */
  getPlaybook(nodeId: string, scope?: PolicyScope): Promise<NodePlaybook | undefined>;
  /** Writes to the scope the RECORD carries (`playbook.scope`), never to one passed separately. */
  savePlaybook(playbook: NodePlaybook): Promise<NodePlaybook>;
}
