import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import { sortNewestFirst } from "../newestFirst.js";
import type { ImprovementRepository } from "../interfaces/ImprovementRepository.js";
import type { EvalDataset, ImprovementProposal, NodePlaybook, ProposalStatus, TrialRecord } from "../../improvement/improvementTypes.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";
import { playbookSeeds } from "../../improvement/playbookSeeds.js";
import { applyPlaybookDelta, assertPlaybookScope } from "../../improvement/playbook.js";
import { isFleetScope, scopeKey, scopeStorageSegments, type PolicyScope } from "../../scope/policyScope.js";

const proposalKey = (proposalId: string) => `improvement/proposals/${proposalId}.json`;
const trialKey = (trialId: string) => `improvement/trials/${trialId}.json`;
const datasetKey = (datasetId: string) => `improvement/datasets/${datasetId}.json`;
// C2 (part 2) — the FLEET scope produces no segments, so its key is byte-identical to the one every
// existing playbook already occupies: `improvement/playbooks/{nodeId}.json`. A narrower scope writes
// a NEW key beside it (`improvement/playbooks/by-site/{projectId}/{nodeId}.json`). Nothing moves.
const playbookKey = (nodeId: string, scope?: PolicyScope) => {
  assertPlaybookScope(scope);
  return `improvement/playbooks/${[...scopeStorageSegments(scope), `${nodeId}.json`].join("/")}`;
};

const newestFirst = <T extends { createdAt: string }>(records: T[]) => sortNewestFirst(records);
const MAX_WRITE_RETRIES = 5;

// Track B — the promotion-effect claim ledger. One ledger per SCOPE (not per node: a scope can
// promote to several nodes in one pass, and each node's effect ids are already distinct strings,
// so one ledger per scope keeps this to one blob read/write per promotion pass instead of one per
// node). `${nodeId}` never appears in this key; it is already inside every effect id
// (`strategyPromotionEffectId`/`strategyCounterEffectId` both hash it in).
type PromotionEffectLedger = { claimed: string[] };
const promotionEffectLedgerKeyFor = (scope?: PolicyScope) => `improvement/promotion-effects/${encodeURIComponent(scopeKey(scope))}.json`;
const emptyPromotionEffectLedger = (): PromotionEffectLedger => ({ claimed: [] });

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

  // T15.17 — lazy-seed judgment-node playbooks from seeds on first access.
  async getPlaybook(nodeId: string, scope?: PolicyScope) {
    let playbook = await getBlobJson<NodePlaybook>(this.store, playbookKey(nodeId, scope));
    // T15.17 seeds are FLEET lessons — they are the shipped judgment-node craft, not any tenant's —
    // so a site-scoped read never materializes one. Seeding a per-tenant copy would hand every new
    // tenant an editable duplicate of shared craft and quietly fork it.
    if (!playbook && isFleetScope(scope) && playbookSeeds.has(nodeId)) {
      // Seed from T15.17 playbook seeds (capture and clone conductor judgment nodes).
      const seed = playbookSeeds.get(nodeId)!;
      const now = new Date().toISOString();
      playbook = applyPlaybookDelta(undefined, nodeId, seed, now);
      await this.store.setJSON(playbookKey(nodeId), playbook);
    }
    return playbook ?? undefined;
  }
  async savePlaybook(playbook: NodePlaybook) { await this.store.setJSON(playbookKey(playbook.nodeId, playbook.scope), playbook); return playbook; }

  // Track B — see ImprovementRepository.mutatePlaybook. Read-with-etag, mutate, conditional write,
  // retry on conflict against the value that actually landed — the same CAS shape as
  // BlobLearningRepository.mutateLedger, applied to a playbook instead of a ledger. `mutate` is
  // called fresh on every attempt so a retry never re-applies a decision made against stale data.
  async mutatePlaybook(
    nodeId: string,
    scope: PolicyScope | undefined,
    mutate: (existing: NodePlaybook | undefined) => NodePlaybook | undefined
  ): Promise<NodePlaybook | undefined> {
    const key = playbookKey(nodeId, scope);
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const current = await getBlobJsonWithEtag<NodePlaybook>(this.store, key);
      // T15.17 seeding: mirrors getPlaybook's own fleet-seed materialization, so a mutate against a
      // never-read seeded node starts from the seed rather than from nothing.
      const existing = current.data ?? (isFleetScope(scope) && playbookSeeds.has(nodeId)
        ? applyPlaybookDelta(undefined, nodeId, playbookSeeds.get(nodeId)!, new Date().toISOString())
        : undefined);
      const next = mutate(existing);
      // Track B -- `undefined` means the caller determined, from this exact `existing`, that
      // nothing actually needs to change (e.g. a contradiction candidate that does not oppose any
      // current item). Return the untouched value and skip the write -- never persist a no-op
      // delta, which would otherwise fabricate an empty playbook document the first time any node
      // is merely CONSIDERED for promotion.
      if (next === undefined) return existing;
      const result = await this.store.setJSON(key, next, current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
      if (!result || (result as { modified?: boolean }).modified !== false) return next;
    }
    throw new Error(`playbook_mutation_conflict:${nodeId}:${scopeKey(scope)}`);
  }

  // Track B — see ImprovementRepository.claimPromotionEffects. Same CAS shape as
  // BlobLearningRepository.claimStrategyIngestionKeys, one ledger per scope instead of per project.
  async claimPromotionEffects(scope: PolicyScope | undefined, effectIds: readonly string[]): Promise<Set<string>> {
    const wanted = [...new Set(effectIds)];
    if (!wanted.length) return new Set();
    const key = promotionEffectLedgerKeyFor(scope);
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const current = await getBlobJsonWithEtag<PromotionEffectLedger>(this.store, key);
      const ledger = current.data ?? emptyPromotionEffectLedger();
      const already = new Set(ledger.claimed);
      const newlyClaimed = wanted.filter((candidate) => !already.has(candidate));
      if (!newlyClaimed.length) return new Set();
      const next: PromotionEffectLedger = { claimed: [...ledger.claimed, ...newlyClaimed] };
      const result = await this.store.setJSON(key, next, current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
      if (!result || (result as { modified?: boolean }).modified !== false) return new Set(newlyClaimed);
    }
    throw new Error(`promotion_effect_claim_conflict:${scopeKey(scope)}`);
  }
}
