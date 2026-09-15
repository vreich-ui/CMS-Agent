import { expect, test } from '@playwright/test';

// Regression guard — THE RAIL ASKS THE SERVER NOTHING PER ROW.
//
// This defect shipped twice, and both times it survived review because the FIXTURE plane disagreed
// with the live one. `node_list_outputs` returns the run's artifacts typed by the node's own
// `produces[0]` — verified live on 2026-09-15 against run_1789486803011_iz521v, which came back
// `type: "document_render.execute.v1"`. Only `mockStore` ever synthesized an `'operator_override'`
// row, so in fixtures the query looked like it worked and in production it could only ever answer
// "no" — once per completed node, 25 on a publishing run, on every paint.
//
// Source-pinned, deliberately, and the same way tests/verbargs.spec.ts pins `changes_get`: the
// fixture transport never issues a network request for a mock verb, so there is no POST to count.
// What can be pinned is that the rail's row component holds no query at all — which is the actual
// property, and a stronger one than counting a request that a future refactor could move rather than
// remove.

const railSource = (page: import('@playwright/test').Page) =>
  page.evaluate(() => fetch('/src/screens/Workbench/Rail.tsx').then((r) => r.text()));

test('the rail row issues no per-node request — the run record is the only source', async ({ page }) => {
  await page.goto('/');
  const source = await railSource(page);

  const rowStart = source.indexOf('function RailRow');
  expect(rowStart).toBeGreaterThan(-1);
  // The row component's own body, up to the next top-level declaration.
  const nextTopLevel = source.indexOf('\nexport function', rowStart);
  const rowBody = source.slice(rowStart, nextTopLevel === -1 ? undefined : nextTopLevel);

  // No query of any kind inside the row: not node_list_outputs, not a narrowed successor.
  expect(rowBody).not.toContain('useQuery');
  expect(rowBody).not.toContain('nodeListOutputs');
  // And the verb is not even imported any more, so it cannot creep back in silently elsewhere.
  expect(source).not.toContain('nodeListOutputs');
});

test('the supplied-output markers still render, from the run record alone', async ({ page }) => {
  await page.goto('/');
  const source = await railSource(page);
  // `provenance` is the run-record signal (overrideStatus.ts's suppliedOutputMarker). Both markers
  // must be derived from it and from nothing else — absence of provenance means the node produced
  // its own output, which is the NORMAL case and never a reason to go asking.
  // Vite serves the TRANSFORMED module, not the on-disk TSX, so quote style is not ours to
  // predict — the same caveat tests/verbargs.spec.ts records for its own source-pinned assertion.
  expect(source).toMatch(/hasOverride\s*=\s*provenance\s*===\s*['"]operator_override['"]/);
  expect(source).toMatch(/defaulted\s*=\s*provenance\s*===\s*['"]default_output['"]/);
  // (Deliberately no assertion on `needsLegacyCheck` being absent: the explanatory comment in
  // Rail.tsx names the dead guard on purpose, and the served module keeps comments. The property
  // that matters — no query in the row — is pinned by the test above.)
});
