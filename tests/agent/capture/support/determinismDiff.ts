// T15.25 (#200) — the comparison core of the determinism harness.
//
// THE INVARIANT (stated in every T15 ADR and task brief this series has shipped):
//   "Consistency over liveness: if a change would make two runs of the same URL diverge, it is wrong."
//
// This module is deliberately NOT the capture/clone engine's own code: it is a test-only tool that
// walks two governed-object trees produced by two independent runs of the SAME source and reports
// every leaf value that differs, by JSON path, naming what run A produced and what run B produced.
//
// Design choices that matter for what this actually proves:
//   * `diffGovernedObjects` records EVERY divergence by default. Nothing is silently dropped. A caller
//     that wants to permit a specific field's variance must say so explicitly, as one entry in an
//     `AllowlistEntry[]` it passes in — never as a default behaviour of this function. This is the
//     brief's own requirement: "an over-eager normalizer that hides real divergence is the failure
//     mode here."
//   * An allowlist entry matches by JSON PATH, not by bare key name — `allowlistEntry({ path: "runId" })`
//     matches only the top-level `runId` field, never `stageOutputs.capture_map.pages[0].runId` (which
//     would be a real bug if it ever existed). Callers that truly need a key matched at any depth pass
//     a RegExp explicitly and must justify why the broad match is safe in the entry's `reason`.
//   * The diff is structural: object key sets are unioned (a key present on one side and absent on the
//     other is its own divergence, not silently treated as `undefined === undefined`), and arrays are
//     compared position-by-position with an explicit length check first.

export type Divergence = { path: string; a: unknown; b: unknown };

export type AllowlistEntry = {
  // Matches a full JSON path (e.g. "runId", "stageOutputs.capture_emit_live.report.createdObjects[0].objectId").
  // A string must match EXACTLY (no partial/substring matching); a RegExp is tested against the whole
  // path with `.test()`. Prefer a string; reach for RegExp only when the path has a variable index/key
  // and say so in `reason`.
  path: string | RegExp;
  // WHY this specific field is legitimately run-scoped or wall-clock, never governed content. Required
  // — an allowlist entry with no justification is exactly the "silently stripped" failure mode the
  // brief calls out.
  reason: string;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const matchesAllowlist = (path: string, allowlist: readonly AllowlistEntry[]): AllowlistEntry | undefined =>
  allowlist.find((entry) => (typeof entry.path === "string" ? entry.path === path : entry.path.test(path)));

/**
 * Structural diff of two JSON-shaped values, returning one Divergence per leaf (or per key-set
 * mismatch) that differs and is not covered by `allowlist`. Empty result == the two trees are
 * identical modulo the allowlist.
 */
export function diffGovernedObjects(a: unknown, b: unknown, allowlist: readonly AllowlistEntry[] = [], path = "$"): Divergence[] {
  // Identical by reference or by primitive equality (covers matching strings/numbers/booleans/null).
  if (a === b) return [];

  const bothArrays = Array.isArray(a) && Array.isArray(b);
  if (bothArrays) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    const divergences: Divergence[] = [];
    if (arrA.length !== arrB.length) {
      const lengthPath = `${path}.length`;
      if (!matchesAllowlist(lengthPath, allowlist)) {
        divergences.push({ path: lengthPath, a: arrA.length, b: arrB.length });
      }
    }
    const max = Math.max(arrA.length, arrB.length);
    for (let i = 0; i < max; i += 1) {
      divergences.push(...diffGovernedObjects(arrA[i], arrB[i], allowlist, `${path}[${i}]`));
    }
    return divergences;
  }

  const bothObjects = isPlainObject(a) && isPlainObject(b);
  if (bothObjects) {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
    const divergences: Divergence[] = [];
    for (const key of [...keys].sort()) {
      divergences.push(...diffGovernedObjects(objA[key], objB[key], allowlist, `${path}.${key}`));
    }
    return divergences;
  }

  // Type mismatch (e.g. array vs object, object vs primitive) or unequal primitives/leaves.
  if (matchesAllowlist(path, allowlist)) return [];
  return [{ path, a, b }];
}

export const formatDivergences = (divergences: readonly Divergence[]): string =>
  divergences
    .map((d) => `  ${d.path}: run A = ${JSON.stringify(d.a)}  |  run B = ${JSON.stringify(d.b)}`)
    .join("\n");

/**
 * Throws a single, readable error naming every divergent field (and what each run produced) when any
 * survive the allowlist. Intended as `assertDeterministic(diffGovernedObjects(a, b, allowlist), "...")`
 * so a CI failure names the exact field, not just "not identical".
 */
export function assertDeterministic(divergences: readonly Divergence[], context: string): void {
  if (divergences.length === 0) return;
  throw new Error(
    `${context}: ${divergences.length} field(s) diverged between two runs of the same source.\n${formatDivergences(divergences)}`
  );
}
