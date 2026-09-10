import { expect, test } from '@playwright/test';
import {
  boundedOutputText,
  emptyOutputMessage,
  resolveNodeOutput,
  type ResolvedNodeOutput,
} from '../src/screens/Workbench/outputResolution';
import type { NodeOutputEntry } from '../src/components/drive/overrideStatus';
import type { StageOutputEntry } from '../src/api/verbs';
import type { NodeRunStatus } from '../src/screens/Workbench/helpers';

// Unit tests for outputResolution.ts — Defect A's precedence resolver
// (operator override > current-run canonical artifact > legacy stage-store
// record > honest empty message) and the large-value bound. Plain Node
// assertions, no `page`, no browser — same pattern as tests/adapters.spec.ts.

const RUN = 'run_x';
const NODE = 'draft_writer';

function canonical(overrides: Partial<NodeOutputEntry> = {}): NodeOutputEntry {
  return {
    id: `${RUN}:${NODE}:artifact`,
    runId: RUN,
    nodeId: NODE,
    type: 'draft.v1',
    createdAt: '2026-08-23T13:37:08.265Z',
    value: { artifact: 'draft.v1' },
    ...overrides,
  };
}

function override(overrides: Partial<NodeOutputEntry> = {}): NodeOutputEntry {
  return {
    id: `${RUN}:${NODE}:override`,
    runId: RUN,
    nodeId: NODE,
    type: 'operator_override',
    createdAt: '2026-08-23T14:00:00.000Z',
    value: { artifact: 'operator-supplied' },
    note: 'operator note',
    ...overrides,
  };
}

function legacy(overrides: Partial<StageOutputEntry> = {}): StageOutputEntry {
  return {
    id: `${RUN}:${NODE}`,
    stage: NODE,
    createdAt: '2026-08-23T13:39:00.000Z',
    value: { legacy: true },
    ...overrides,
  };
}

function resolve(args: {
  status?: NodeRunStatus;
  nodeOutputs?: NodeOutputEntry[];
  stageOutputs?: StageOutputEntry[];
}): ResolvedNodeOutput {
  return resolveNodeOutput({
    status: args.status ?? 'completed',
    runId: RUN,
    nodeId: NODE,
    nodeOutputs: args.nodeOutputs ?? [],
    stageOutputs: args.stageOutputs ?? [],
  });
}

test.describe('outputResolution — precedence', () => {
  test('deterministic node: canonical artifact only, no stage record — resolves to the artifact', () => {
    const r = resolve({ nodeOutputs: [canonical()], stageOutputs: [] });
    expect(r.source).toBe('canonical');
    expect(r.value).toEqual({ artifact: 'draft.v1' });
    expect(r.artifactType).toBe('draft.v1');
  });

  test('model node: both a canonical artifact and a legacy stage record — resolves to the canonical one, not the legacy one, even when the legacy record is newer', () => {
    const r = resolve({
      nodeOutputs: [canonical({ createdAt: '2026-08-23T13:00:00.000Z' })],
      stageOutputs: [legacy({ createdAt: '2026-08-23T23:00:00.000Z' })], // deliberately later
    });
    expect(r.source).toBe('canonical');
    expect(r.value).toEqual({ artifact: 'draft.v1' });
  });

  test('an operator override beats both a canonical artifact and a legacy stage record', () => {
    const r = resolve({
      nodeOutputs: [canonical(), override()],
      stageOutputs: [legacy()],
    });
    expect(r.source).toBe('override');
    expect(r.value).toEqual({ artifact: 'operator-supplied' });
    expect(r.overrideNote).toBe('operator note');
  });

  test('an override present on a node that has not completed still wins (drive-mode pre-run override)', () => {
    const r = resolve({ status: 'queued', nodeOutputs: [override()], stageOutputs: [] });
    expect(r.source).toBe('override');
  });

  test('legacy stage-only: no canonical artifact, a run-attributed stage record — renders it, labelled legacy and run-scoped', () => {
    const r = resolve({ nodeOutputs: [], stageOutputs: [legacy({ id: `${RUN}:${NODE}` })] });
    expect(r.source).toBe('legacy');
    expect(r.legacyScope).toBe('run');
    expect(r.value).toEqual({ legacy: true });
  });

  test('legacy stage-only with a random, non-run-shaped id — still renders, but labelled unscoped (never claimed as this run\'s own)', () => {
    const r = resolve({ nodeOutputs: [], stageOutputs: [legacy({ id: 'stage_legacy_9f2k3q' })] });
    expect(r.source).toBe('legacy');
    expect(r.legacyScope).toBe('unscoped');
  });

  test('node_list_outputs entries for a different run or a different node are never picked up — exact (runId, nodeId) match only, for both the override and canonical tiers', () => {
    const r = resolve({
      nodeOutputs: [
        canonical({ runId: 'some_other_run' }),
        canonical({ nodeId: 'other_node' }),
        override({ runId: 'some_other_run' }),
      ],
      stageOutputs: [],
    });
    expect(r.source).toBe('empty');
  });

  test("a stage record OWNED BY ANOTHER RUN is never shown inside this run — not even as the unscoped legacy fallback (REVIEW FIX R2)", () => {
    const r = resolve({ nodeOutputs: [], stageOutputs: [legacy({ id: 'run_other_1:draft_writer' })] });
    expect(r.source).toBe('empty');
  });

  test("a stage record written by the SINGLE-NODE path (`${runId}:${executionId}:${nodeId}`) is this run's own, not 'unscoped' (REVIEW FIX R2)", () => {
    const r = resolve({ nodeOutputs: [], stageOutputs: [legacy({ id: `${RUN}:exec_7:draft_writer` })] });
    expect(r.source).toBe('legacy');
    expect(r.legacyScope).toBe('run');
  });

  test('a re-queued node (retry/reset) never shows the superseded stage record as this run\'s output (REVIEW FIX R1)', () => {
    const stale = legacy({ id: `${RUN}:draft_writer`, value: { v: 'previous attempt' } });
    const r = resolve({ status: 'queued', nodeOutputs: [], stageOutputs: [stale] });
    expect(r.source).toBe('empty');
    expect(r.emptyMessage).toContain('has not run yet');
  });

  test('newest-by-createdAt wins among multiple canonical artifacts, with a later-array-entry tie-break on equal createdAt', () => {
    const older = canonical({ id: 'a', createdAt: '2026-08-23T10:00:00.000Z', value: { v: 'older' } });
    const newer = canonical({ id: 'b', createdAt: '2026-08-23T12:00:00.000Z', value: { v: 'newer' } });
    const tie1 = canonical({ id: 'c', createdAt: '2026-08-23T12:00:00.000Z', value: { v: 'tie1' } });
    const tie2 = canonical({ id: 'd', createdAt: '2026-08-23T12:00:00.000Z', value: { v: 'tie2' } });

    expect(resolve({ nodeOutputs: [older, newer] }).value).toEqual({ v: 'newer' });
    // On an exact createdAt tie, the LATER entry in the returned array wins.
    expect(resolve({ nodeOutputs: [tie1, tie2] }).value).toEqual({ v: 'tie2' });
    expect(resolve({ nodeOutputs: [tie2, tie1] }).value).toEqual({ v: 'tie1' });
  });
});

test.describe('outputResolution — honest empty messages', () => {
  const statuses: NodeRunStatus[] = ['queued', 'running', 'paused', 'blocked', 'failed', 'cancelled', 'completed'];

  test('every non-completed, non-terminal state gets a message that says the node has not completed — never the old generic "no stage output recorded"', () => {
    for (const status of statuses) {
      const r = resolve({ status, nodeOutputs: [], stageOutputs: [] });
      expect(r.source).toBe('empty');
      expect(r.emptyMessage).toBeTruthy();
      expect(r.emptyMessage).not.toContain('No stage output recorded for this node in this run.');
    }
  });

  test('messages are state-specific — no two states share the same wording, and each names its own state honestly', () => {
    const messages = statuses.map((s) => emptyOutputMessage(s));
    expect(new Set(messages).size).toBe(messages.length);
    expect(emptyOutputMessage('running')).toMatch(/running/i);
    expect(emptyOutputMessage('queued')).toMatch(/not run yet/i);
    expect(emptyOutputMessage('paused')).toMatch(/paused/i);
    expect(emptyOutputMessage('blocked')).toMatch(/blocked/i);
  });

  test('a genuinely completed node with nothing recorded gets a precise missing-record message, not a "not finished yet" one', () => {
    expect(emptyOutputMessage('completed')).toMatch(/completed but recorded no output/i);
    expect(emptyOutputMessage('failed')).toMatch(/failed and recorded no output/i);
  });
});

test.describe('outputResolution — bounded large-value presentation', () => {
  test('a small value is never marked truncated, and prefix equals the full text', () => {
    const b = boundedOutputText({ small: 'value' });
    expect(b.truncated).toBe(false);
    expect(b.prefix).toBe(b.full);
  });

  test('a large value is capped for the initial render but the full value is always reachable, with an honest size', () => {
    const big = { blob: 'x'.repeat(200_000) };
    const b = boundedOutputText(big, 8000);
    expect(b.truncated).toBe(true);
    expect(b.prefix.length).toBe(8000);
    expect(b.full.length).toBeGreaterThan(200_000); // never discarded — the whole serialization is retained
    expect(b.fullLength).toBe(b.full.length);
    expect(b.full.startsWith(b.prefix)).toBe(true); // the prefix is a genuine prefix, not a summary
  });
});
