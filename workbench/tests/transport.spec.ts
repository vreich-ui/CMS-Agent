import { expect, test, type Page } from '@playwright/test';

// W0 acceptance — the Cloud Run transport sends ONE POST per verb, and no call is
// allowed to hang forever.
//
// The transport under test is selected by a build-time env flag (VITE_MCP_TRANSPORT),
// and this suite's single shared dev server runs in fixture mode, so `callVerb` can
// never reach the Cloud Run path here. The tests therefore drive it through
// client.ts's `__test_cloudRun` seam — the same test-only-export pattern
// tests/auth.spec.ts already uses against LoginGate — pointed at a SAME-ORIGIN stub
// path so there is no cross-origin preflight to fake.

const STUB = '/__test_mcp';

type ClientModule = {
  setCloudRunToken: (token: string) => void;
  CALL_TIMEOUT_MS: number;
  __test_cloudRun: {
    call: <T>(verb: string, args?: object) => Promise<T>;
    setEndpoint: (url: string) => void;
    setTimeoutMs: (ms: number) => void;
    reset: () => void;
  };
};

async function armTransport(page: Page, timeoutMs?: number): Promise<void> {
  await page.evaluate(
    async ({ stub, ms }) => {
      const mod = (await import('/src/api/client.ts')) as unknown as ClientModule;
      mod.setCloudRunToken('test-bearer-token');
      mod.__test_cloudRun.setEndpoint(stub);
      if (ms !== undefined) mod.__test_cloudRun.setTimeoutMs(ms);
    },
    { stub: STUB, ms: timeoutMs },
  );
}

test('three verbs fired in one tick produce three separate POSTs, each carrying one request', async ({ page }) => {
  const bodies: unknown[] = [];

  await page.route(`**${STUB}`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? 'null');
    bodies.push(body);
    // Echo the request's own id back, exactly as the real endpoint does.
    const id = (body as { id?: number } | null)?.id ?? 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: { ok: true, data: { echoed: id } } } }),
    });
  });

  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();
  await armTransport(page);

  // One tick, three verbs — the exact shape the old batcher collapsed into a single
  // POST gated on its slowest member.
  const results = await page.evaluate(async () => {
    const mod = (await import('/src/api/client.ts')) as unknown as ClientModule;
    return Promise.all([
      mod.__test_cloudRun.call<{ echoed: number }>('project_list'),
      mod.__test_cloudRun.call<{ echoed: number }>('workspace_get_nodes'),
      mod.__test_cloudRun.call<{ echoed: number }>('workflow_list_runs', { limit: 20 }),
    ]);
  });

  expect(bodies).toHaveLength(3);
  // Not an array-shaped batch: one JSON-RPC request object per POST.
  for (const body of bodies) {
    expect(Array.isArray(body)).toBe(false);
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call' });
  }
  expect(bodies.map((b) => (b as { params: { name: string } }).params.name).sort()).toEqual([
    'project_list',
    'workflow_list_runs',
    'workspace_get_nodes',
  ]);
  // Each call resolved with ITS OWN answer, correlated by id — not the batch's.
  expect(results).toHaveLength(3);
  expect(new Set(results.map((r) => r.echoed)).size).toBe(3);
});

test('a response that never arrives rejects as a network_error timeout instead of hanging', async ({ page }) => {
  // The live ceiling is 25 s (CALL_TIMEOUT_MS, asserted below). Waiting that out in a
  // test would cost 25 s of wall clock to prove a branch that is identical at any
  // duration, so the clock is shortened through the test seam and the constant is
  // pinned separately — together those are the whole contract.
  await page.route(`**${STUB}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await expect(page.locator('.topbar')).toBeVisible();
  await armTransport(page, 400);

  const failure = await page.evaluate(async () => {
    const mod = (await import('/src/api/client.ts')) as unknown as ClientModule;
    const startedAt = performance.now();
    try {
      await mod.__test_cloudRun.call('constellation_get_attention');
      return { settled: 'resolved' as const, elapsedMs: performance.now() - startedAt };
    } catch (err) {
      const e = err as { code?: string; verb?: string; message?: string };
      return {
        settled: 'rejected' as const,
        elapsedMs: performance.now() - startedAt,
        code: e.code,
        verb: e.verb,
        message: e.message,
      };
    }
  });

  expect(failure.settled).toBe('rejected');
  expect(failure.code).toBe('network_error');
  expect(failure.verb).toBe('constellation_get_attention');
  expect(failure.message).toContain('timed out after');
  // It rejected on OUR clock, nowhere near the 5 s the stub would have taken.
  expect(failure.elapsedMs).toBeLessThan(3_000);

  const ceiling = await page.evaluate(async () => {
    const mod = (await import('/src/api/client.ts')) as unknown as ClientModule;
    mod.__test_cloudRun.reset();
    return mod.CALL_TIMEOUT_MS;
  });
  expect(ceiling).toBe(25_000);
});
