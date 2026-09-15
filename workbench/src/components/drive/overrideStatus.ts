// U3 — shared node_validate_output issue shape + a couple of tiny
// formatting helpers, split out so OverrideOutputModal.tsx and
// DriveCenter.tsx (both of which call node_validate_output on a candidate
// output) agree on the same normalization rather than each inventing one.
import type { SchemaIssue } from '../../screens/Workbench/tabs/Shared';
import type { Run, RunNode, WorkflowNode } from '../../types';

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

// node-default-output (W4) — a run-node's `outputProvenance` (Run.nodes[],
// ../../types.ts's RunNode) names how a SUPPLIED (not produced) output
// reached this run: pushed through from the node's standing DEFAULT, or
// pasted in as a one-run operator OVERRIDE. Both are "supplied", but they
// are not the same thing — a default is a property of the NODE, reused
// across runs; an override is one run's pasted value — and every surface
// that marks one (the rail's chip, the drive-mode grid, This-run's banner)
// must keep them visually and textually distinct rather than folding them
// into one "supplied" vocabulary. This reads straight off the RUN record
// (already fetched by every one of those surfaces via useRun/workflow_get_run)
// rather than a second per-row query — unlike the override marker below,
// which predates outputProvenance and still reads node_list_outputs.

/** This node's supplied-output provenance in this run, if any. */
export function runNodeProvenance(nodes: RunNode[] | undefined, nodeId: string): RunNode['outputProvenance'] {
  return nodes?.find((n) => n.nodeId === nodeId)?.outputProvenance;
}

/** True when this node's output in this run was pushed through from its
 * standing default (workflow.run_node/retry_node useDefaultOutput, or a
 * defaults-mode run) — never true for a pasted operator override. */
export function hasDefaultOutputMarker(run: Pick<Run, 'nodes'> | null | undefined, nodeId: string): boolean {
  return runNodeProvenance(run?.nodes, nodeId)?.source === 'default_output';
}

// Adversarial-review fix (post-W4) — an operator override is now REAL: the
// live server never produces a `node_list_outputs` entry typed
// 'operator_override' (`findOverride` below), it stamps `outputProvenance`
// on the RUN record instead, exactly like a default does. Only the fixture
// mock still synthesizes that typed row (see mockStore.ts's own comment on
// why it still exists) — which is exactly how the original bug this whole
// feature fixes stayed invisible: the fixture plane agreeing with the
// client while the live plane didn't. `hasOperatorOverrideMarker` reads the
// same authoritative run-record field `hasDefaultOutputMarker` already
// does, so both "is this supplied, and which kind" questions have exactly
// one real source from here on; `findOverride`/`node_list_outputs` remains
// only as the legacy fallback for a run recorded before outputProvenance
// existed (see its call sites' own comments on that ordering).

/** True when this node's output in this run was pasted in by an operator
 * (stage.save_output's run-scoped form) — never true for a pushed-through
 * default. */
export function hasOperatorOverrideMarker(run: Pick<Run, 'nodes'> | null | undefined, nodeId: string): boolean {
  return runNodeProvenance(run?.nodes, nodeId)?.source === 'operator_override';
}

/** The one "is this node's output in this run SUPPLIED, and which kind"
 * read every marker surface should use: default output, operator override,
 * or null (produced normally / not yet determined). */
export function suppliedOutputMarker(
  run: Pick<Run, 'nodes'> | null | undefined,
  nodeId: string,
): 'default_output' | 'operator_override' | null {
  return runNodeProvenance(run?.nodes, nodeId)?.source ?? null;
}

// U3, superseded as primary source by suppliedOutputMarker above — shared
// reading of `node_list_outputs`' entries. The live server never types an
// entry 'operator_override' (see the comment above suppliedOutputMarker);
// this now serves ONLY as a fallback for a run recorded before
// `outputProvenance` existed on the run record, or for a surface (the
// override modal's "prior variant" picker) that genuinely needs the
// historical output list itself, not just a yes/no marker. Every "does this
// node carry an override" marker (the rail's chip, the drive-mode grid,
// This-run's banner) must check suppliedOutputMarker/hasOperatorOverrideMarker
// FIRST and fall back to this only when the run record carries no
// provenance for that node at all.

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

// Adversarial-review fix (post-W4, server-contract follow-up) — a node
// that writes to a LIVE client (a real publish, a real release, a real
// emission) can never have its output supplied instead of produced on a
// live run: the server now refuses both stage.save_output's run-scoped
// form and workflow.run_node{useDefaultOutput:true} for such a node with
// `defaulted_publish_node_refused`. This mirrors the server's own
// predicate (riskLevel publish/admin, or kind publisher/releaser/emission)
// so the UI can disable the control and say why BEFORE the round-trip that
// would otherwise refuse it — see DriveCenter.tsx's push-through button.
const PUBLISH_TAIL_KINDS = new Set(['publisher', 'releaser', 'emission']);

export function isPublishTailNode(node: Pick<WorkflowNode, 'risk' | 'kind'> | null | undefined): boolean {
  if (!node) return false;
  if (node.risk === 'publish' || (node.risk as string) === 'admin') return true;
  return PUBLISH_TAIL_KINDS.has(node.kind);
}

/** A run whose model turns actually reach a live client — as opposed to a
 * `mock` run, which the server's own `defaulted_publish_node_refused`
 * refusal exempts entirely ("mock runs are unaffected"). Unrelated to the
 * `dry` flag (CLAUDE.md: "dryRun: true on a run means nothing — no gate
 * reads it"). */
export function isLiveRun(run: Pick<Run, 'exec'> | null | undefined): boolean {
  return run?.exec === 'openai';
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
