// C2 — THE SKILL SET A RUN ACTUALLY USED, pinned at dispatch and never re-read.
//
// THE DEFECT. Every dispatch and every inspection resolved skills the same way:
// `resolveSkillsForNode(node, repo)` reads `node.assignedSkills` — one global, mutable list per
// node, shared by every run on every tenant. Three consequences, all live today:
//
//   1. A `skill.assign` or `skill.unassign` lands mid-run. The nodes that have already dispatched
//      used the old set, the nodes still to come use the new one, and nothing on the record says a
//      switch happened. One run, two policies, no evidence.
//   2. Two runs cannot want different skills for the same node. Serving a foundation About page and
//      a commercial About page from one `organization_narrative_writer` means mutating
//      `assignedSkills` between them — and if they overlap, the second mutation decides what the
//      first one runs with. That is the race, and it is won by whoever writes last.
//   3. "What did this run use?" was unanswerable. Every surface — `node.get_effective_skills`,
//      `skill.resolve_for_node`, the Workbench — reported the CURRENT assignment and presented it as
//      the run's. For a finished run that is not a stale answer, it is a wrong one.
//
// THE FIX IS A PIN, NOT A LOCK. At the moment the executor stamps a node's dispatch claim, it also
// records which skills that node is dispatching with, and at which versions. The write rides along
// with the claim save that already happens (executor.ts's `if (claim)` block), so a dispatch costs
// no extra run write. From then on the runner resolves against the PINNED ids; the live assignment
// is not consulted again for that node in that run.
//
// THE BOUNDARY, STATED PLAINLY, because W2 requires the UI to state it and a prompt sentence is not
// enforcement: the selection is pinned PER NODE, AT ITS FIRST DISPATCH. It is NOT pinned for the
// whole run at run start. So an assignment changed while a run is in flight still reaches the nodes
// of that run that have not dispatched yet — and that is now a visible, recorded fact rather than an
// invisible one, because each node's entry carries its own `selectedAt`. A retry reuses the node's
// existing pin: a retry is another attempt at the same dispatch, not a new decision about policy.
//
// WHAT THIS MODULE DOES NOT DO. It does not decide which skills SHOULD apply to a site, task or
// objective — there is no scope vocabulary here, and `assignedSkills` is taken as given. Pinning is
// the correctness half (a race, and an inspection that lied); scoped selection is the design half
// and belongs with the C0 contract, on top of this.
import type { SkillRepository } from "../repository/interfaces/SkillRepository.js";
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";

export const RUN_SKILL_SELECTION_CONTRACT = "run_skill_selection.v1";

export type RunSkillSelection = {
  contract: typeof RUN_SKILL_SELECTION_CONTRACT;
  /** The skill ids this node dispatched with, in the node's own assignment order. */
  skillIds: string[];
  /**
   * The version of each pinned skill AS IT STOOD AT DISPATCH. Recorded so a later reader can tell
   * "this run used v1.0.0 and the store now holds v1.2.0" from "this run used what is there now" —
   * a distinction the optimizer's regression evidence and W2's execution snapshot both depend on,
   * and one that no amount of re-reading the store can reconstruct after the fact.
   */
  versions: Record<string, string>;
  selectedAt: string;
  /** Where the set came from. One value today; the field exists so a scoped selection can say so. */
  source: "node_assignment";
};

const unique = <T>(values: T[]) => [...new Set(values)];

/** The pinned selection for one node of one run, or undefined when that node has not dispatched yet. */
export const selectedSkillsFor = (run: Pick<WorkflowExecutionRecord, "skillSelection">, nodeId: string): RunSkillSelection | undefined =>
  run.skillSelection?.[nodeId];

/**
 * Record the skill selection for a node about to dispatch, on the run record IN MEMORY. The caller
 * persists it — in practice with the dispatch-claim save it already makes, which is what keeps this
 * free.
 *
 * WRITE-ONCE. An existing entry is returned untouched and is never recomputed: that is the whole
 * guarantee, and a retry, a reclaim after a stale claim, or a second driver arriving at the same
 * node must all see the same answer as the first dispatch did.
 *
 * Best-effort on the version read only. If the skill repository cannot be read, the ids are still
 * pinned and `versions` is left empty — losing the version stamp degrades the evidence, whereas
 * refusing to pin would put the dispatch back on the racing global read this module replaces. The
 * ids are what stop the race; the versions are what explain it afterwards.
 */
export async function pinSkillSelection(
  run: WorkflowExecutionRecord,
  node: Pick<WorkspaceNode, "id" | "assignedSkills">,
  repository: SkillRepository,
  now: () => Date = () => new Date()
): Promise<RunSkillSelection> {
  const existing = run.skillSelection?.[node.id];
  if (existing) return existing;

  const skillIds = unique(node.assignedSkills ?? []);
  let versions: Record<string, string> = {};
  if (skillIds.length) {
    try {
      const defined = await repository.list({ skillIds });
      versions = Object.fromEntries(defined.map((skill) => [skill.skillId, skill.version]));
    } catch {
      // Deliberately swallowed — see the doc comment above. A missing version stamp is recorded as
      // an absent key, never as a guessed one.
    }
  }

  const selection: RunSkillSelection = {
    contract: RUN_SKILL_SELECTION_CONTRACT,
    skillIds,
    versions,
    selectedAt: now().toISOString(),
    source: "node_assignment"
  };
  run.skillSelection = { ...(run.skillSelection ?? {}), [node.id]: selection };
  return selection;
}

/**
 * Union of two selection maps, with STORED WINNING on a key both hold.
 *
 * Used by `mergeNodeAdvance` when a save conflicts. Stored wins because a selection is write-once:
 * if the record already carries an entry for a node, that entry is the one its dispatch used, and
 * this advance's copy of it is at best identical and at worst a second computation of something
 * that was already decided. Taking `advanced` alone would drop an entry another driver pinned while
 * this advance was in flight — which is the `defaultedNodeIds` bug #353 fixed, one field over.
 */
export const mergeSkillSelections = (
  stored: Record<string, RunSkillSelection> | undefined,
  advanced: Record<string, RunSkillSelection> | undefined
): Record<string, RunSkillSelection> | undefined => {
  if (!stored && !advanced) return undefined;
  const merged = { ...(advanced ?? {}), ...(stored ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
};
