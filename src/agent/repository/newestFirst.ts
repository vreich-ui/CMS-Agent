// One sort order for every "give me the newest N" read in the repositories (T-15).
//
// WHY A TIEBREAK IS NEEDED. `createdAt` is an ISO-8601 millisecond stamp, so every record written
// inside the same millisecond compares EQUAL, and sorting on it alone is not a total order.
// Array.prototype.sort is stable only with respect to the array it was handed — which for the
// memory repositories is insertion order (fine) and for the blob repositories is whatever order the
// store happened to list the keys in (not fine). Five records written in one tick could therefore
// come back in any order at all, and `limit: 3` would return three arbitrary ones of the five while
// presenting itself as "the newest three".
//
// WHY TIEBREAKING ON THE ID DID NOT WORK BEFORE. The original T-15 entry said the fix was to break
// the tie on the record id. It was not, because ids were `${prefix}_${Date.now()}_${random}` —
// inside one millisecond the only varying part was the random tail, so ordering by id was ordering
// by coin flip. It looked deterministic and was not. `makeImprovementId` now carries a per-process
// sequence that resets when the clock advances, which is what makes the id a real tiebreak; this
// helper is the other half of that fix and neither half works alone.
//
// IDENTITY FIELD. These record types do not share an `id` property — each names its own
// (`feedbackId`, `evalId`, …). The order below is not alphabetical and must not be sorted: a type is
// listed before any key it merely REFERENCES, so a FeedbackRecord ties on its own `feedbackId` and
// not on the optional `evalId` it may point at, and a TrialRecord on `trialId` and not on the
// `proposalId` it belongs to. A record matching none of them falls back to no tiebreak, which is
// exactly the old behaviour rather than a wrong one.
const IDENTITY_KEYS = [
  "feedbackId",
  "comparisonId",
  "evalId",
  "reportId",
  "versionId",
  "trialId",
  "proposalId",
  "datasetId",
  "id",
] as const;

const identityOf = (record: unknown): string => {
  if (typeof record !== "object" || record === null) return "";
  for (const key of IDENTITY_KEYS) {
    const value = (record as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
};

/**
 * Newest first, by `createdAt` descending and then by identity descending. Returns a new array;
 * `limit` undefined means "all of them", and callers keep their own default.
 */
export const sortNewestFirst = <T extends { createdAt: string }>(records: readonly T[], limit?: number): T[] =>
  [...records]
    .sort((a, b) => {
      const byTime = b.createdAt.localeCompare(a.createdAt);
      if (byTime !== 0) return byTime;
      return identityOf(b).localeCompare(identityOf(a));
    })
    .slice(0, limit);

export const __test__ = { identityOf, IDENTITY_KEYS };
