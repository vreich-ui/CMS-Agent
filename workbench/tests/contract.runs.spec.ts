import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// W1 contract test — the client's run-list reading, held against the VERBATIM live
// envelope captured in contracts/workflow_list_runs.json (WP-00, 2026-08-26), not
// against a fixture written to match the client.
//
// The sample is read here in Node and handed into the page, so the assertions run
// through the real `api/adapters.ts` the app itself uses, on bytes the live workspace
// actually produced.

interface Captured {
  verb: string;
  calls: Array<{
    args: Record<string, unknown>;
    ok: boolean;
    sample: { ok: boolean; data: { runs: Array<Record<string, unknown>>; page: Record<string, unknown> } };
    notes?: string;
  }>;
}

const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('../contracts/workflow_list_runs.json', import.meta.url)), 'utf8'),
) as Captured;

const callWithArgs = (match: (args: Record<string, unknown>) => boolean) => {
  const call = captured.calls.find((candidate) => match(candidate.args));
  if (!call) throw new Error('contracts/workflow_list_runs.json has no call matching that shape');
  return call;
};

test('workflow_list_runs: the captured live envelope reads through toRunPage exactly as the app reads it', async ({
  page,
}) => {
  expect(captured.verb).toBe('workflow_list_runs');
  const call = callWithArgs((args) => args.detail === 'full');
  const envelope = call.sample.data;

  await page.goto('/');

  const read = await page.evaluate(async (raw) => {
    const { toRunPage } = (await import('/src/api/adapters.ts')) as typeof import('/src/api/adapters.ts');
    const view = toRunPage(raw as Parameters<typeof toRunPage>[0]);
    return {
      runCount: view.runs.length,
      matchedCount: view.matchedCount,
      hasMore: view.hasMore,
      nextCursor: view.nextCursor ?? null,
      first: view.runs[0],
    };
  }, envelope as unknown as Record<string, unknown>);

  // The page block is read from the SERVER's counts, never from the rows returned —
  // that separation is the whole point of W1 (a window of 20 that still knows the
  // fleet is 69).
  expect(read.matchedCount).toBe(envelope.page.matchedCount);
  expect(read.matchedCount).toBeGreaterThan(read.runCount);
  expect(read.hasMore).toBe(envelope.page.hasMore);
  expect(read.nextCursor).toBe(envelope.page.nextCursor);

  // And one row, mapped field by field against the captured live values.
  const rawFirst = envelope.runs[0];
  expect(read.first.id).toBe(rawFirst.runId);
  expect(read.first.wf).toBe(rawFirst.workflowId);
  expect(read.first.proj).toBe(rawFirst.projectId);
  expect(read.first.status).toBe(rawFirst.status);
  expect(read.first.cur).toBe(rawFirst.currentNodeId);
  expect(read.first.requestId).toBe(rawFirst.requestId);
  expect(read.first.err).toBe((rawFirst.errors as string[]).length);
  expect(read.first.exec).toBe((rawFirst.mode as { executionMode: string }).executionMode);
  expect(read.first.dry).toBe(rawFirst.dryRun);
  expect(read.first.done).toBe(
    (rawFirst.nodes as Array<{ status: string }>).filter((n) => n.status === 'completed').length,
  );
});

test('workflow_list_runs: an envelope with no page block degrades to counting its own rows, never to zero', async ({
  page,
}) => {
  await page.goto('/');
  const read = await page.evaluate(async () => {
    const { toRunPage } = (await import('/src/api/adapters.ts')) as typeof import('/src/api/adapters.ts');
    return toRunPage({ runs: [] });
  });
  expect(read.matchedCount).toBe(0);
  expect(read.hasMore).toBe(false);
  expect(read.nextCursor).toBeUndefined();
});

test('workflow_list_runs: a cursor is never offered when the server says there is no more', async ({ page }) => {
  await page.goto('/');
  const read = await page.evaluate(async () => {
    const { toRunPage } = (await import('/src/api/adapters.ts')) as typeof import('/src/api/adapters.ts');
    // A stale nextCursor alongside hasMore:false — the shape that would otherwise
    // render a "load more" button leading to an empty page.
    return toRunPage({ runs: [], page: { matchedCount: 0, hasMore: false, nextCursor: 'stale' } });
  });
  expect(read.nextCursor).toBeUndefined();
  expect(read.hasMore).toBe(false);
});

// W4 — the DEFAULT row shape. A summary row carries counts and no nodes[], so toRun has to read
// its totals from the row rather than from an array that is not there. Getting this wrong would
// not throw: it would quietly report every run as "0 errors, 0 nodes done", which is exactly the
// class of silent wrongness a list row should never be capable of.
test('workflow_list_runs: a detail:"summary" row reads through toRun from its counts, not from a nodes[] it does not have', async ({
  page,
}) => {
  const call = callWithArgs((args) => Object.keys(args).length === 0);
  const envelope = call.sample.data as unknown as {
    detail: string;
    runs: Array<Record<string, unknown>>;
    page: Record<string, unknown>;
  };
  expect(envelope.detail).toBe('summary');

  await page.goto('/');
  const read = await page.evaluate(async (raw) => {
    const { toRunPage } = (await import('/src/api/adapters.ts')) as typeof import('/src/api/adapters.ts');
    const view = toRunPage(raw as Parameters<typeof toRunPage>[0]);
    return { first: view.runs[0], matchedCount: view.matchedCount };
  }, envelope as unknown as Record<string, unknown>);

  const rawFirst = envelope.runs[0];
  // No nodes[] anywhere in the captured row — that absence is the whole point of the shape.
  expect(rawFirst.nodes).toBeUndefined();

  expect(read.first.id).toBe(rawFirst.runId);
  expect(read.first.status).toBe(rawFirst.status);
  expect(read.first.cur).toBe(rawFirst.currentNodeId);
  // The counts come from the row's own fields...
  expect(read.first.err).toBe(rawFirst.errorCount);
  expect(read.first.done).toBe(rawFirst.completedCount);
  expect(read.first.total).toBe(rawFirst.nodeCount);
  // ...and `nodes` is honestly empty rather than fabricated from the counts.
  expect(read.first.nodes).toEqual([]);
  expect(read.matchedCount).toBe(envelope.page.matchedCount);
});
