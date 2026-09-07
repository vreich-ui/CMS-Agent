// S-07 — the read side of "a tenant may only see its own improvement records".
//
// WHY THIS EXISTS. The platform admin's Analytics → Insights tab calls `feedback_list` and
// `learning_list_observations` with the tenant's genesis-minted SCOPED bearer. Neither record type
// was ever partitioned: `FeedbackRecord` and `LearningObservation` carry only `runId`/`nodeId`, so an
// unfiltered list returns every tenant's rows. Both types now carry an OPTIONAL `projectId`, but
// every record written before that field existed lacks it — dropping those outright would empty a
// live tenant's cards, and returning them unconditionally would leak other tenants' rows.
//
// So a record matches a requested project when EITHER of two things is true:
//   1. it is stamped, and its stamp equals the requested project; or
//   2. it is unstamped, and its `runId` resolves to a run owned by the requested project.
//
// FAIL CLOSED. An unstamped record whose project cannot be established — no runId, an unknown runId,
// or a repository that threw — is EXCLUDED whenever a filter was supplied. "We could not tell" is
// never "show it to them": a leak here hands one tenant another tenant's editorial telemetry.
//
// The ids here are CMS-AGENT project ids (`dr-lurie`), the same domain a scoped bearer's
// `policy.projects` holds and `WorkflowExecutionRecord.projectId` records. The tracking sink's
// partition id for the same tenant is spelled differently (`drlurie`) and would match nothing.
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";

/** The minimum of ExecutionRepository this filter needs — one lookup, so tests can pass a stub. */
export type RunProjectLookup = Pick<ExecutionRepository, "getRun">;

export type ProjectScopedRecord = { projectId?: string; runId?: string };

/**
 * Resolve each DISTINCT runId at most once per call, including the misses. A page of feedback is
 * routinely dominated by a handful of runs, and an unbounded per-record lookup would turn one list
 * call into hundreds of blob reads.
 */
const runProjectResolver = (executionRepository: RunProjectLookup) => {
  const cache = new Map<string, Promise<string | undefined>>();
  return (runId: string): Promise<string | undefined> => {
    const cached = cache.get(runId);
    if (cached) return cached;
    // A throwing store resolves to undefined, which the caller treats as "unknown" and therefore
    // excludes — the same verdict a foreign run gets, so a transient failure cannot open the door.
    const pending = executionRepository.getRun(runId).then((run) => run?.projectId).catch(() => undefined);
    cache.set(runId, pending);
    return pending;
  };
};

/**
 * Narrow `records` to those belonging to `projectId`. With no `projectId` the input is returned
 * unchanged — the pre-existing, deliberately unfiltered behaviour every full-bearer caller relies on.
 */
export async function filterRecordsByProject<T extends ProjectScopedRecord>(
  records: T[],
  projectId: string | undefined,
  executionRepository: RunProjectLookup
): Promise<T[]> {
  if (!projectId) return records;
  const resolveRunProject = runProjectResolver(executionRepository);
  const verdicts = await Promise.all(records.map(async (record) => {
    if (record.projectId !== undefined) return record.projectId === projectId;
    if (!record.runId) return false;
    return (await resolveRunProject(record.runId)) === projectId;
  }));
  return records.filter((_record, index) => verdicts[index]);
}
