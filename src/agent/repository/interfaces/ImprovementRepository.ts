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
  /**
   * Track B — the CAS-safe read-modify-write `getPlaybook` + `savePlaybook` was never composed
   * into. `savePlaybook` is an unconditional overwrite: two concurrent callers each read a
   * playbook, compute a delta against that snapshot, and save — the second save clobbers the
   * first's effect with no error and no signal that anything was lost (lost update, not a
   * duplicate). `mutate` is re-run against the CURRENT stored value on every CAS retry, so it
   * must be a pure function of `existing` with no closed-over decision that only makes sense
   * against the snapshot it was first called with.
   */
  mutatePlaybook(
    nodeId: string,
    scope: PolicyScope | undefined,
    // Track B -- `mutate` may return `undefined` to mean "nothing to persist": the caller decided,
    // from THIS read of `existing`, that no add/markHelpful/markHarmful actually applies (e.g. a
    // contradiction candidate that turns out not to oppose anything currently in the playbook).
    // The implementation must then skip the write entirely rather than persisting a no-op delta
    // (which would otherwise fabricate an empty playbook document for a node that was never
    // actually promoted to, or re-write an unchanged one on every retry).
    mutate: (existing: NodePlaybook | undefined) => NodePlaybook | undefined
  ): Promise<NodePlaybook | undefined>;
  /**
   * Track B — atomic dedup for a promotion EFFECT (a markHelpful/markHarmful/add this pass would
   * apply to one node's playbook), keyed by the caller's own effect ids (see
   * `strategyPromotionEffectId` / `strategyCounterEffectId`). Returns the SUBSET newly claimed —
   * the effects this call is now responsible for applying. An effect id already claimed means
   * some earlier pass (or a concurrent one that won the race) already applied it; re-applying it
   * would mark a lesson helpful/harmful again for evidence that was already credited, without any
   * new window having arrived. This is a SEPARATE identity from `claimStrategyIngestionKeys`:
   * that one is about not writing the same observation twice, this one is about not applying the
   * same promotion EFFECT twice, and the two can diverge (a retried pass with no new observations
   * to write can still owe a first-time promotion of evidence already on file).
   */
  claimPromotionEffects(scope: PolicyScope | undefined, effectIds: readonly string[]): Promise<Set<string>>;
}
