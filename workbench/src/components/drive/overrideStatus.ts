// U3 — shared node_validate_output issue shape + a couple of tiny
// formatting helpers, split out so OverrideOutputModal.tsx and
// DriveCenter.tsx (both of which call node_validate_output on a candidate
// output) agree on the same normalization rather than each inventing one.
import type { SchemaIssue } from '../../screens/Workbench/tabs/Shared';

export function normalizeValidationIssues(raw: unknown): SchemaIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it): SchemaIssue | null => {
      if (it && typeof it === 'object' && 'message' in it) {
        const rec = it as { path?: unknown; message?: unknown };
        return { path: typeof rec.path === 'string' && rec.path ? rec.path : '(root)', message: String(rec.message) };
      }
      return typeof it === 'string' ? { path: '(root)', message: it } : null;
    })
    .filter((x): x is SchemaIssue => x !== null);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// U3 — shared reading of `node_list_outputs`' entries, so every surface
// that shows "this node carries an operator override" (the rail's chip —
// Rail.tsx, not ours to edit — the drive-mode grid, This-run's override
// banner, the override modal's "prior variant" picker) agrees on the same
// shape and the same definition of "override": an entry whose `type` reads
// exactly 'operator_override'. Mirrors Rail.tsx's own reading of this verb
// exactly, deliberately, so the marker means the same thing everywhere it
// appears rather than inventing a second vocabulary.

export interface NodeOutputEntry {
  id?: string;
  runId?: string;
  nodeId?: string;
  type?: string;
  createdAt?: string;
  value?: unknown;
  /** Not returned by every backend (the fixture mock never sets it on the
   * override entry it synthesizes) — read defensively, never assumed. */
  note?: string;
  [key: string]: unknown;
}

/** `node_list_outputs` wraps `{outputs: [...]}` live; verbs.ts's return type
 * also allows a bare array defensively. Same unwrap Rail.tsx uses. */
export function extractOutputList(raw: { outputs?: unknown[] } | unknown[] | undefined | null): NodeOutputEntry[] {
  if (Array.isArray(raw)) return raw as NodeOutputEntry[];
  return (raw?.outputs ?? []) as NodeOutputEntry[];
}

export function findOverride(list: NodeOutputEntry[]): NodeOutputEntry | undefined {
  return list.find((e) => e.type === 'operator_override');
}

export function formatWhen(iso: string | undefined): string {
  if (!iso) return 'an unknown time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}
