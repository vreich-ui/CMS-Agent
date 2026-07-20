import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ImprovementRepository } from "../interfaces/ImprovementRepository.js";
import type { EvalDataset, ImprovementProposal, NodePlaybook, ProposalStatus, TrialRecord } from "../../improvement/improvementTypes.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const proposalKey = (proposalId: string) => `improvement/proposals/${proposalId}.json`;
const trialKey = (trialId: string) => `improvement/trials/${trialId}.json`;
const datasetKey = (datasetId: string) => `improvement/datasets/${datasetId}.json`;
const playbookKey = (nodeId: string) => `improvement/playbooks/${nodeId}.json`;

const newestFirst = <T extends { createdAt: string }>(records: T[]) => records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// Blob/GCS-backed optimizer state. Proposals/trials/datasets are status-bearing documents (plain
// JSON, overwritten on status transitions); playbooks are one document per node.
export class BlobImprovementRepository implements ImprovementRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }

  private async loadAll<T>(prefix: string): Promise<T[]> {
    const { blobs } = await this.store.list({ prefix });
    const records = await Promise.all(blobs.map((blob) => getBlobJson<T>(this.store, blob.key)));
    return records.filter((record) => record !== null) as T[];
  }

  async saveProposal(proposal: ImprovementProposal) { await this.store.setJSON(proposalKey(proposal.proposalId), proposal); return proposal; }
  async getProposal(proposalId: string) { return (await getBlobJson<ImprovementProposal>(this.store, proposalKey(proposalId))) ?? undefined; }
  async listProposals(filters: { nodeId?: string; status?: ProposalStatus } = {}) {
    return newestFirst((await this.loadAll<ImprovementProposal>("improvement/proposals/")).filter((proposal) => (!filters.nodeId || proposal.nodeId === filters.nodeId) && (!filters.status || proposal.status === filters.status)));
  }

  async saveTrial(trial: TrialRecord) { await this.store.setJSON(trialKey(trial.trialId), trial); return trial; }
  async getTrial(trialId: string) { return (await getBlobJson<TrialRecord>(this.store, trialKey(trialId))) ?? undefined; }
  async listTrials(filters: { nodeId?: string; proposalId?: string } = {}) {
    return newestFirst((await this.loadAll<TrialRecord>("improvement/trials/")).filter((trial) => (!filters.nodeId || trial.nodeId === filters.nodeId) && (!filters.proposalId || trial.proposalId === filters.proposalId)));
  }

  async saveDataset(dataset: EvalDataset) { await this.store.setJSON(datasetKey(dataset.datasetId), dataset); return dataset; }
  async getDataset(datasetId: string) { return (await getBlobJson<EvalDataset>(this.store, datasetKey(datasetId))) ?? undefined; }
  async listDatasets(filters: { nodeId?: string } = {}) {
    return newestFirst((await this.loadAll<EvalDataset>("improvement/datasets/")).filter((dataset) => !filters.nodeId || dataset.nodeId === filters.nodeId));
  }

  async getPlaybook(nodeId: string) { return (await getBlobJson<NodePlaybook>(this.store, playbookKey(nodeId))) ?? undefined; }
  async savePlaybook(playbook: NodePlaybook) { await this.store.setJSON(playbookKey(playbook.nodeId), playbook); return playbook; }
}
