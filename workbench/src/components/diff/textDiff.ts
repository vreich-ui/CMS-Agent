// U2 — the diff & merge studio's diff engine. Pure, dependency-free,
// unit-testable (see tests/diff.spec.ts and this repo's plain `node`-run
// unit checks — no React, no fixtures, no network in this file).
//
// Two passes, same primitive underneath:
//   1. line-level LCS over the two texts split on "\n"
//   2. inside every hunk where lines were replaced (not purely added or
//      purely removed), word-level LCS over the paired-up line texts
//
// That's what turns "the whole paragraph is struck through" into "this one
// word changed" — the actual ask (Wolf: "a wall of raw JSON with
// strikethrough — unreadable").

export type DiffOpType = 'equal' | 'add' | 'remove';

export interface DiffOp<T> {
  type: DiffOpType;
  value: T;
}

/**
 * Classic O(n*m) LCS diff, generalized over any array (used for lines AND
 * for word tokens — same algorithm, different granularity). Backtracks
 * favoring "remove before add" when lengths tie, which is what produces
 * stable, minimal-looking hunks for the common case (a short edit inside a
 * much longer unchanged text).
 */
export function diffArray<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): DiffOp<T>[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      ops.push({ type: 'equal', value: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', value: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', value: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'remove', value: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', value: b[j] });
    j++;
  }
  return ops;
}

export function splitLines(text: string): string[] {
  return text.split('\n');
}

/** Tokenizes on whitespace runs, keeping the whitespace as its own token so
 * re-joining tokens reconstructs the original line exactly — needed so a
 * word-diff render can just concatenate `token.value` pieces back together. */
export function tokenizeWords(text: string): string[] {
  const m = text.match(/\s+|[^\s]+/g);
  return m ?? [];
}

export interface ProseLine {
  /** 'modify' = this line exists on both sides but differs — the case that
   * gets word-level highlighting. 'add'/'remove' are whole-line, one side
   * only. 'equal' lines are shown for context. */
  type: 'equal' | 'add' | 'remove' | 'modify';
  before?: string;
  after?: string;
  words?: DiffOp<string>[];
}

/**
 * Line-level LCS, then — for every hunk where lines were both removed and
 * added (i.e. genuinely replaced, not purely inserted or purely deleted) —
 * pairs them up index-wise and runs word-level LCS on each pair. A hunk
 * with more removes than adds (or vice versa) pairs up to the shorter
 * count; the leftover lines stay whole-line add/remove.
 */
export function computeProseDiff(a: string, b: string): ProseLine[] {
  const ops = diffArray(splitLines(a), splitLines(b));
  const result: ProseLine[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'equal') {
      result.push({ type: 'equal', before: op.value, after: op.value });
      i++;
      continue;
    }
    const removes: string[] = [];
    const adds: string[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'remove') removes.push(ops[i].value);
      else adds.push(ops[i].value);
      i++;
    }
    const pairCount = Math.min(removes.length, adds.length);
    for (let k = 0; k < pairCount; k++) {
      const words = diffArray(tokenizeWords(removes[k]), tokenizeWords(adds[k]));
      result.push({ type: 'modify', before: removes[k], after: adds[k], words });
    }
    for (let k = pairCount; k < removes.length; k++) result.push({ type: 'remove', before: removes[k] });
    for (let k = pairCount; k < adds.length; k++) result.push({ type: 'add', after: adds[k] });
  }
  return result;
}

/** True when the two texts have no line- or word-level differences at all. */
export function proseDiffIsEmpty(lines: ProseLine[]): boolean {
  return lines.every((l) => l.type === 'equal');
}

export interface MergeResult {
  text: string;
  /** Number of lines both sides edited differently — each wrapped in
   * git-style conflict markers in `text` for the operator to resolve by
   * hand (a convention Wolf, or anyone who has used git, already reads). */
  conflicts: number;
}

/**
 * Auto-merge: B's text, with every line only B touched (or that's
 * unchanged) taken as-is, every line only A had (B dropped it) omitted, and
 * every line BOTH sides changed differently wrapped in conflict markers
 * instead of silently picking a winner.
 */
export function autoMergeText(a: string, b: string, labelA = 'A', labelB = 'B'): MergeResult {
  const lines = computeProseDiff(a, b);
  const out: string[] = [];
  let conflicts = 0;
  for (const line of lines) {
    if (line.type === 'equal') {
      out.push(line.after ?? line.before ?? '');
    } else if (line.type === 'add') {
      out.push(line.after ?? '');
    } else if (line.type === 'remove') {
      // B dropped this line — auto-merge follows B, so it stays dropped.
    } else {
      conflicts++;
      out.push(`<<<<<<< ${labelA}`);
      out.push(line.before ?? '');
      out.push('=======');
      out.push(line.after ?? '');
      out.push(`>>>>>>> ${labelB}`);
    }
  }
  return { text: out.join('\n'), conflicts };
}
