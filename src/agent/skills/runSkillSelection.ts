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
// C2 PART 2 — SCOPED SELECTION, the design half #358 deliberately left out, now filled in here
// rather than in a second module, because "which skills did this node dispatch with" and "which
// skills were eligible to" are one answer written down once. `assignedSkills` is no longer taken as
// given: it is the CANDIDATE list, and the pin is what narrows it, using the scope vocabulary
// (scope/policyScope.ts) against the run's own situation (site = projectId, task = nodeId,
// objective = the run's, when it was started under one).
//
// NARROWING NEVER INVENTS AN ASSIGNMENT. A skill reaches a dispatch only if a node assigned it AND
// its scope applies. So the blast radius of this change is exactly: skills that carry a scope. An
// unscoped skill behaves precisely as it did before, on every node, on every tenant.
//
// AND IT NEVER NARROWS ON DATA IT COULD NOT READ. If the skill repository refuses, the ids are
// pinned unfiltered, `source` stays `node_assignment`, and `degradedReason` says so — because an
// unreadable store is not evidence that a skill is out of scope, and silently dropping a node's
// craft skills on a transient read failure is a worse outcome than running with a wider set.
import { compareScopeSpecificity, scopeApplies, scopeLabel, type ScopeContext } from "../scope/policyScope.js";
import type { SkillRepository } from "../repository/interfaces/SkillRepository.js";
import type { SkillDefinition } from "./skillTypes.js";
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
  /**
   * Where the set came from. `scoped_selection` means the scope vocabulary was applied to the node's
   * candidates; `node_assignment` means it was not — either because nothing was assigned, or because
   * the skill read failed and `degradedReason` says which.
   */
  source: "node_assignment" | "scoped_selection";
  /**
   * The situation the selection was made against, recorded so a later reader can re-derive the same
   * answer instead of re-deriving the situation. Absent on a pin made before this field existed.
   */
  context?: ScopeContext;
  /**
   * The candidates that did NOT survive, each with the reason. This is the difference between "this
   * node has no SEO skill" and "this node's SEO skill is scoped to another site" — one is a gap to
   * fill and the other is the vocabulary working, and an operator cannot tell them apart from the
   * surviving list alone.
   */
  dropped?: DroppedSkill[];
  /** Set when narrowing could not be attempted. Its presence means `skillIds` is wider than the scope vocabulary would have made it. */
  degradedReason?: string;
};

export type DroppedSkill = {
  skillId: string;
  /**
   * `out_of_scope` — the skill declares a scope this run is not in.
   * `superseded` — a narrower member of the same family applies here, named in `detail`.
   */
  reason: "out_of_scope" | "superseded";
  detail: string;
};

/**
 * THE RUN'S SITUATION, in the vocabulary's terms. One derivation, used by the pin and by any
 * inspection that wants to explain a pin.
 *
 * `task` is the nodeId: the unit of work a skill is scoped to is the node, which is also how
 * playbooks have always been addressed, so the two halves of C2 part 2 narrow along the same axis.
 */
export const runScopeContext = (run: Pick<WorkflowExecutionRecord, "projectId" | "objective">, nodeId: string): ScopeContext => ({
  ...(run.projectId ? { site: run.projectId } : {}),
  task: nodeId,
  ...(run.objective ? { objective: run.objective } : {})
});

export type ScopedSkillSelection = { skillIds: string[]; dropped: DroppedSkill[] };

/**
 * Narrow a node's candidate skills to the ones that apply here. Pure — no reads, no clock.
 *
 * Two passes, in this order and no other:
 *   1. SCOPE. A skill whose declared scope does not apply to this context is dropped. An unscoped
 *      skill always survives this pass.
 *   2. FAMILY. Among the survivors of one family, the NARROWEST applies and the wider members are
 *      dropped as superseded — that is what makes a DTC/foundation pair work: both are assigned to
 *      the node, both may apply, and the site-scoped one displaces the fleet one on that site while
 *      the fleet one still serves every other tenant.
 *
 * A TIE IS NOT RESOLVED HERE. Two equally-narrow members of one family are both kept, so that
 * `resolveSkillsForNode` raises a blocker naming them. Picking one by id order would be a silent,
 * arbitrary answer to a question the operator did not actually answer — and the run would then be
 * shaped by alphabet. Ordering of the survivors is otherwise the node's own assignment order, which
 * is what decides the order their instructions are concatenated in.
 */
export const selectScopedSkills = (candidateIds: string[], defined: SkillDefinition[], context: ScopeContext): ScopedSkillSelection => {
  const byId = new Map(defined.map((skill) => [skill.skillId, skill]));
  const dropped: DroppedSkill[] = [];
  const inScope = candidateIds.filter((id) => {
    const skill = byId.get(id);
    // An id with no definition is NOT dropped here. It is the existing "assigned skill not found"
    // blocker, raised by the resolver with a remedy attached; swallowing it as a scope decision
    // would turn a missing skill into a silently narrower run.
    if (!skill?.scope) return true;
    if (scopeApplies(skill.scope, context)) return true;
    dropped.push({ skillId: id, reason: "out_of_scope", detail: `Scoped to ${scopeLabel(skill.scope)}; this run is ${scopeLabel(context)}.` });
    return false;
  });

  const narrowestByFamily = new Map<string, SkillDefinition>();
  for (const id of inScope) {
    const skill = byId.get(id);
    if (!skill?.family) continue;
    const incumbent = narrowestByFamily.get(skill.family);
    if (!incumbent || compareScopeSpecificity(skill.scope, incumbent.scope) > 0) narrowestByFamily.set(skill.family, skill);
  }

  const selected = inScope.filter((id) => {
    const skill = byId.get(id);
    if (!skill?.family) return true;
    const winner = narrowestByFamily.get(skill.family)!;
    if (winner.skillId === skill.skillId) return true;
    // Equal specificity is the unresolved tie: keep it, and let the resolver block on the family.
    if (compareScopeSpecificity(skill.scope, winner.scope) === 0) return true;
    dropped.push({ skillId: id, reason: "superseded", detail: `Family "${skill.family}": ${winner.skillId} is scoped to ${scopeLabel(winner.scope)} and applies here; this one is scoped to ${scopeLabel(skill.scope)}.` });
    return false;
  });

  return { skillIds: selected, dropped };
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
  options: { now?: () => Date; context?: ScopeContext } = {}
): Promise<RunSkillSelection> {
  const now = options.now ?? (() => new Date());
  const existing = run.skillSelection?.[node.id];
  if (existing) return existing;

  const candidates = unique(node.assignedSkills ?? []);
  const context = options.context ?? runScopeContext(run, node.id);
  let skillIds = candidates;
  let versions: Record<string, string> = {};
  let dropped: DroppedSkill[] = [];
  let source: RunSkillSelection["source"] = "node_assignment";
  let degradedReason: string | undefined;
  if (candidates.length) {
    try {
      const defined = await repository.list({ skillIds: candidates });
      versions = Object.fromEntries(defined.map((skill) => [skill.skillId, skill.version]));
      // C2 part 2 — the SAME read serves the version stamp and the scope filter, so narrowing costs
      // no extra round trip on any dispatch.
      const scoped = selectScopedSkills(candidates, defined, context);
      skillIds = scoped.skillIds;
      dropped = scoped.dropped;
      source = "scoped_selection";
    } catch (error) {
      // Deliberately swallowed for the VERSION stamp — see the doc comment above. For the SCOPE
      // filter it is recorded rather than swallowed: the pin is wider than the vocabulary would have
      // made it, and every reader of this record has to be able to see that.
      degradedReason = `Skill repository unreadable at dispatch; scope narrowing was not applied. ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const selection: RunSkillSelection = {
    contract: RUN_SKILL_SELECTION_CONTRACT,
    skillIds,
    versions,
    selectedAt: now().toISOString(),
    source,
    context,
    ...(dropped.length ? { dropped } : {}),
    ...(degradedReason ? { degradedReason } : {})
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
