import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ImprovementRepository } from "../interfaces/ImprovementRepository.js";
import type { EvalDataset, ImprovementProposal, NodePlaybook, ProposalStatus, TrialRecord } from "../../improvement/improvementTypes.js";

const clone = <T>(value: T): T => structuredClone(value);
const newestFirst = <T extends { createdAt: string }>(records: T[]) => [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);

type ImprovementState = { proposals: Map<string, ImprovementProposal>; trials: Map<string, TrialRecord>; datasets: Map<string, EvalDataset>; playbooks: Map<string, NodePlaybook> };
const createState = (): ImprovementState => ({ proposals: new Map(), trials: new Map(), datasets: new Map(), playbooks: new Map() });

export class MemoryImprovementRepository implements ImprovementRepository {
  private static states = new Map<string, ImprovementState>();
  constructor(private readonly backend: string = "memory") { if (!MemoryImprovementRepository.states.has(backend)) MemoryImprovementRepository.states.set(backend, createState()); }
  protected state(): ImprovementState { return MemoryImprovementRepository.states.get(this.backend)!; }

  async health(): Promise<RepositoryHealth> { return healthyRepositoryStatus("memory"); }

  async saveProposal(proposal: ImprovementProposal) { this.state().proposals.set(proposal.proposalId, clone(proposal)); return clone(proposal); }
  async getProposal(proposalId: string) { const proposal = this.state().proposals.get(proposalId); return proposal ? clone(proposal) : undefined; }
  async listProposals(filters: { nodeId?: string; status?: ProposalStatus } = {}) {
    return newestFirst([...this.state().proposals.values()].filter((proposal) => (!filters.nodeId || proposal.nodeId === filters.nodeId) && (!filters.status || proposal.status === filters.status)));
  }

  async saveTrial(trial: TrialRecord) { this.state().trials.set(trial.trialId, clone(trial)); return clone(trial); }
  async getTrial(trialId: string) { const trial = this.state().trials.get(trialId); return trial ? clone(trial) : undefined; }
  async listTrials(filters: { nodeId?: string; proposalId?: string } = {}) {
    return newestFirst([...this.state().trials.values()].filter((trial) => (!filters.nodeId || trial.nodeId === filters.nodeId) && (!filters.proposalId || trial.proposalId === filters.proposalId)));
  }

  async saveDataset(dataset: EvalDataset) { this.state().datasets.set(dataset.datasetId, clone(dataset)); return clone(dataset); }
  async getDataset(datasetId: string) { const dataset = this.state().datasets.get(datasetId); return dataset ? clone(dataset) : undefined; }
  async listDatasets(filters: { nodeId?: string } = {}) {
    return newestFirst([...this.state().datasets.values()].filter((dataset) => !filters.nodeId || dataset.nodeId === filters.nodeId));
  }

  async getPlaybook(nodeId: string) { const playbook = this.state().playbooks.get(nodeId); return playbook ? clone(playbook) : undefined; }
  async savePlaybook(playbook: NodePlaybook) { this.state().playbooks.set(playbook.nodeId, clone(playbook)); return clone(playbook); }
}
