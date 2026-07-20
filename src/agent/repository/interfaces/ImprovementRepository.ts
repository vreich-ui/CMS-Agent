import type { RepositoryHealth } from "../RepositoryHealth.js";
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
  getPlaybook(nodeId: string): Promise<NodePlaybook | undefined>;
  savePlaybook(playbook: NodePlaybook): Promise<NodePlaybook>;
}
