// U2 — field-by-field diffing for everything that ISN'T prose. The prompt
// field gets textDiff.ts's word-level prose treatment; every other field on
// a node (allowedTools, assignedSkills, modelConfig, inputSchema,
// outputSchema, riskLevel, …) goes through here instead of ever being
// JSON.stringify'd whole and struck through — that whole-object dump is
// exactly what Wolf called unreadable.

import { computeProseDiff, type ProseLine } from './textDiff';

export function isPrimitive(v: unknown): v is string | number | boolean | null | undefined {
  return v === null || v === undefined || typeof v !== 'object';
}

export function isPrimitiveArray(v: unknown): v is Array<string | number | boolean> {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
}

/** Structural equality, key-order independent — plain JSON.stringify would
 * false-positive a "change" on two objects that only differ in key order. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && deepEqual(ao[k], bo[k]));
}

export type FieldRowKind = 'scalar' | 'array' | 'json';

export interface FieldDiffRow {
  key: string;
  kind: FieldRowKind;
  before: unknown;
  after: unknown;
  /** kind: 'array' only. */
  arrayAdded?: unknown[];
  arrayRemoved?: unknown[];
  /** kind: 'json' only — pretty-printed, line+word diffed, the fallback for
   * a value with no better presentation (a deep schema object). */
  jsonLines?: ProseLine[];
}

/** Classifies and diffs ONE value pair — the same logic diffFields runs per
 * field, exposed standalone so a single-field caller (e.g. HistoryTab's
 * locally-recorded, single-field entries — a tools list, a schema object)
 * doesn't need to wrap its one value in a fake object first. */
export function classifyValueDiff(key: string, before: unknown, after: unknown): FieldDiffRow {
  if (isPrimitiveArray(before ?? []) && isPrimitiveArray(after ?? [])) {
    const b = (before as unknown[]) ?? [];
    const a = (after as unknown[]) ?? [];
    const added = a.filter((x) => !b.includes(x));
    const removed = b.filter((x) => !a.includes(x));
    return { key, kind: 'array', before, after, arrayAdded: added, arrayRemoved: removed };
  }
  if (isPrimitive(before) && isPrimitive(after)) {
    return { key, kind: 'scalar', before, after };
  }
  const beforeText = before === undefined ? '' : JSON.stringify(before, null, 2);
  const afterText = after === undefined ? '' : JSON.stringify(after, null, 2);
  return { key, kind: 'json', before, after, jsonLines: computeProseDiff(beforeText, afterText) };
}

export interface FieldsDiffResult {
  changed: FieldDiffRow[];
  unchanged: string[];
}

/**
 * One row per top-level field that differs between `before` and `after`,
 * excluding `exclude` (the studio always excludes "prompt" — it gets its
 * own prose pane). Fields equal on both sides collapse into `unchanged`
 * (names only) rather than a row — the "N unchanged fields" disclosure.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  opts?: { exclude?: string[] },
): FieldsDiffResult {
  const b = before ?? {};
  const a = after ?? {};
  const exclude = new Set(opts?.exclude ?? []);
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))
    .filter((k) => !exclude.has(k))
    .sort();
  const changed: FieldDiffRow[] = [];
  const unchanged: string[] = [];
  for (const key of keys) {
    const bv = b[key];
    const av = a[key];
    if (deepEqual(bv, av)) {
      unchanged.push(key);
      continue;
    }
    changed.push(classifyValueDiff(key, bv, av));
  }
  return { changed, unchanged };
}
