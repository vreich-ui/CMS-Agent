// R2 — THE OTHER TWO "Initial limits" NAMED BY THE PROGRAMME SPEC, alongside the no-progress
// fingerprint (noProgressFingerprint.ts): at most two quality revisions per affected artifact, and at
// most one added specialist-resolution round per unresolved capability.
//
// STATUS, STATED PLAINLY RATHER THAN OVERCLAIMED: these are tested, ready primitives with a durable
// home on the run record (WorkflowExecutionRecord.progressBudgets — see executionTypes.ts). NEITHER
// is called from any dispatch path in this codebase today, because neither concept has an existing
// caller to wire into:
//   - a "quality revision" would be a round trip where a review node sends a draft back for another
//     pass (e.g. review_aggregator -> draft_writer) — the canonical workflow has exactly that shape in
//     its dependency graph, but nothing in executor.ts today treats a second dispatch of draft_writer
//     as A REVISION OF THE SAME ARTIFACT rather than an ordinary re-run; there is no revision-loop
//     controller to consult this budget.
//   - a "specialist-resolution round" would be an extra attempt routed at an unresolved capability gap
//     once Piece 2's durable capability-gap record (capabilityGapRecords.ts) already exists for it —
//     but this task's explicit out-of-scope list forbids building automatic node creation or new
//     routing on a gap, so there is no specialist node this budget could bound a round of yet.
// Building a fabricated call site for either would be exactly the scope expansion AGENTS.md /
// CLAUDE.md and this task's brief both warn against ("bounded implementation only — do not expand
// scope"). What ships here is the budget itself, fully enforced and tested as a pure function of the
// run record, so the FIRST real caller (a future revision loop, a future specialist-routing task) has
// a durable, CAS-safe counter to consult on day one instead of inventing its own.
//
// PERSISTENCE. Both maps live under WorkflowExecutionRecord.progressBudgets, so — like every other
// field on the run record — they survive pause/resume and a driver restart for free: they are part of
// the same JSON object every `saveRun` CAS-writes, never a side channel. This module itself performs
// no I/O and holds no lock; it only computes the next value of that field, exactly like
// nodeAttemptHistory.ts and noProgressFingerprint.ts do for their own pieces of the run record. The
// CALLER (a future revision-loop / specialist-routing task, under withRunLock + CAS saveRun per
// AGENTS.md invariant 2) is responsible for persisting the value these functions return.
export const MAX_QUALITY_REVISIONS_PER_ARTIFACT = 2;
export const MAX_SPECIALIST_ROUNDS_PER_CAPABILITY = 1;

export type ProgressBudgets = {
  // Keyed by the affected artifact's own id (e.g. an ExecutionArtifact.id, or a nodeId standing in
  // for "the artifact that node produces" when no finer-grained artifact id exists yet).
  qualityRevisions?: Record<string, number>;
  // Keyed by capability id (capabilityVocabulary.ts's own ids — see that module; this reuses the
  // vocabulary, it does not extend it).
  specialistRounds?: Record<string, number>;
};

export type BudgetCheck =
  | { allowed: true; nextCount: number; limit: number }
  | { allowed: false; count: number; limit: number };

function checkAndAdvance(counts: Record<string, number> | undefined, key: string, limit: number): { check: BudgetCheck; counts: Record<string, number> } {
  const current = counts?.[key] ?? 0;
  if (current >= limit) return { check: { allowed: false, count: current, limit }, counts: counts ?? {} };
  const nextCount = current + 1;
  return { check: { allowed: true, nextCount, limit }, counts: { ...(counts ?? {}), [key]: nextCount } };
}

/**
 * Would recording one more quality revision for `artifactId` stay within budget? Returns the check
 * AND the counts map the caller should persist (under withRunLock + CAS saveRun) when `allowed` is
 * true. Never mutates its input.
 */
export function checkQualityRevisionBudget(budgets: ProgressBudgets | undefined, artifactId: string): { check: BudgetCheck; qualityRevisions: Record<string, number> } {
  const { check, counts } = checkAndAdvance(budgets?.qualityRevisions, artifactId, MAX_QUALITY_REVISIONS_PER_ARTIFACT);
  return { check, qualityRevisions: counts };
}

/**
 * Would recording one more specialist-resolution round for `capabilityId` stay within budget? Same
 * contract as checkQualityRevisionBudget above, over the other map.
 */
export function checkSpecialistRoundBudget(budgets: ProgressBudgets | undefined, capabilityId: string): { check: BudgetCheck; specialistRounds: Record<string, number> } {
  const { check, counts } = checkAndAdvance(budgets?.specialistRounds, capabilityId, MAX_SPECIALIST_ROUNDS_PER_CAPABILITY);
  return { check, specialistRounds: counts };
}
