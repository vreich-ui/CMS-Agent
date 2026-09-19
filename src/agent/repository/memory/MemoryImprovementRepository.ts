import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import { sortNewestFirst } from "../newestFirst.js";
import type { ImprovementRepository } from "../interfaces/ImprovementRepository.js";
import type { EvalDataset, ImprovementProposal, NodePlaybook, ProposalStatus, TrialRecord } from "../../improvement/improvementTypes.js";
import { playbookSeeds } from "../../improvement/playbookSeeds.js";
import { applyPlaybookDelta, assertPlaybookScope } from "../../improvement/playbook.js";
import { isFleetScope, scopeKey, type PolicyScope } from "../../scope/policyScope.js";

// C2 (part 2) — the in-memory analogue of the blob key: scope first so one node's fleet and per-site
// playbooks are distinct entries rather than one entry the last writer wins.
const playbookMapKey = (nodeId: string, scope?: PolicyScope): string => {
  assertPlaybookScope(scope);
  return `${scopeKey(scope)}::${nodeId}`;
};

const clone = <T>(value: T): T => structuredClone(value);
const newestFirst = <T extends { createdAt: string }>(records: T[]) => sortNewestFirst(records).map(clone);

type ImprovementState = { proposals: Map<string, ImprovementProposal>; trials: Map<string, TrialRecord>; datasets: Map<string, EvalDataset>; playbooks: Map<string, NodePlaybook>; promotionEffectClaims: Map<string, Set<string>> };
const createState = (): ImprovementState => ({ proposals: new Map(), trials: new Map(), datasets: new Map(), playbooks: new Map(), promotionEffectClaims: new Map() });

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

  // T15.17 — lazy-seed judgment-node playbooks from seeds on first access.
  async getPlaybook(nodeId: string, scope?: PolicyScope) {
    const key = playbookMapKey(nodeId, scope);
    let playbook = this.state().playbooks.get(key);
    // Fleet-only seeding, for the reason given in BlobImprovementRepository.
    if (!playbook && isFleetScope(scope) && playbookSeeds.has(nodeId)) {
      // Seed from T15.17 playbook seeds (capture and clone conductor judgment nodes).
      const seed = playbookSeeds.get(nodeId)!;
      const now = new Date().toISOString();
      playbook = applyPlaybookDelta(undefined, nodeId, seed, now);
      this.state().playbooks.set(key, playbook);
    }
    return playbook ? clone(playbook) : undefined;
  }
  async savePlaybook(playbook: NodePlaybook) { this.state().playbooks.set(playbookMapKey(playbook.nodeId, playbook.scope), clone(playbook)); return clone(playbook); }

  // Track B — see ImprovementRepository.mutatePlaybook. No real concurrency inside one process
  // (no `await` sits between the read and the write below), so this is a faithful double of the
  // Blob CAS loop's OBSERVABLE contract — read-current, mutate, store — without needing the retry
  // machinery a networked store requires.
  async mutatePlaybook(
    nodeId: string,
    scope: PolicyScope | undefined,
    mutate: (existing: NodePlaybook | undefined) => NodePlaybook | undefined
  ): Promise<NodePlaybook | undefined> {
    const key = playbookMapKey(nodeId, scope);
    const existing = this.state().playbooks.get(key);
    // Fleet-only seeding, mirroring getPlaybook above.
    const seeded = existing ?? (isFleetScope(scope) && playbookSeeds.has(nodeId)
      ? applyPlaybookDelta(undefined, nodeId, playbookSeeds.get(nodeId)!, new Date().toISOString())
      : undefined);
    const next = mutate(seeded ? clone(seeded) : undefined);
    // Track B -- see BlobImprovementRepository.mutatePlaybook: `undefined` is "nothing to persist",
    // never a fabricated empty playbook.
    if (next === undefined) return seeded ? clone(seeded) : undefined;
    this.state().playbooks.set(key, clone(next));
    return clone(next);
  }

  async claimPromotionEffects(scope: PolicyScope | undefined, effectIds: readonly string[]): Promise<Set<string>> {
    const ledgerKey = scopeKey(scope);
    const claims = this.state().promotionEffectClaims;
    const claimed = claims.get(ledgerKey) ?? new Set<string>();
    claims.set(ledgerKey, claimed);
    const newlyClaimed = new Set<string>();
    for (const effectId of effectIds) {
      if (claimed.has(effectId)) continue;
      claimed.add(effectId);
      newlyClaimed.add(effectId);
    }
    return newlyClaimed;
  }
}
