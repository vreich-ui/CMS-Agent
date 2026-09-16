import { test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Not part of the acceptance suite — see playwright.screenshots.config.ts. This walks every surface
// the workbench-v2 waves added and writes a PNG per surface into workbench/docs/screenshots/, so
// the PR can show what changed rather than only assert it. It runs against the FIXTURE plane, so
// the content is fixture content; what it demonstrates is the surface, not the data.

const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });

const RUN_WITH_ARTIFACTS = 'run_1787492010814_kxdbeb';

async function bindRun(page: Page, runId: string, nodeId: string) {
  await page.evaluate(async ({ runId, nodeId }) => {
    const verbs = (await import('/src/api/verbs.ts')) as { workflowGetRun: (a: object) => Promise<{ workflowId?: string } | null> };
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } } };
    const run = await verbs.workflowGetRun({ runId });
    mod.useStore.getState().bindRun(runId, run?.workflowId ?? 'publishing_conductor', nodeId);
  }, { runId, nodeId });
}

const setScreen = (page: Page, screen: string) =>
  page.evaluate(async (screen) => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { setScreen: (s: string) => void } } };
    mod.useStore.getState().setScreen(screen);
  }, screen);

/** Registry and Runs both keep their own sub-tab in the store; landing on the screen lands on its
 *  DEFAULT sub-tab, which is not the one these waves added. */
const setSubTab = (page: Page, setter: 'setReg' | 'setRunTab', value: string) =>
  page.evaluate(async ({ setter, value }) => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => Record<string, (v: string) => void> } };
    mod.useStore.getState()[setter](value);
  }, { setter, value });

const selectNode = (page: Page, nodeId: string) =>
  page.evaluate(async (nodeId) => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { setScreen: (s: string) => void; setNode: (n: string) => void } } };
    const s = mod.useStore.getState();
    s.setScreen('bench');
    s.setNode(nodeId);
  }, nodeId);

test('capture every surface these waves added', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await page.locator('.rail .nrow').first().waitFor();
  await shot(page, '01-first-paint');

  // W3 — the deck shows every workflow the server registers, including ones this build has no
  // hand-written config for.
  await setScreen(page, 'library');
  await page.locator('.card, .wfcard').first().waitFor();
  await shot(page, '02-library-deck');

  // W4 — I/O on a model node: inputs, output, tool calls.
  await bindRun(page, RUN_WITH_ARTIFACTS, 'draft_writer');
  await setScreen(page, 'bench');
  await page.locator('#node-tab-io').click();
  await page.locator('#io-inputs').waitFor();
  await shot(page, '03-io-tab-model-node');

  // W4 — the Algorithm panel: the only explanation a deterministic node has.
  await selectNode(page, 'publish_payload');
  await page.locator('#node-tab-io').click();
  await page.locator('#io-algorithm').waitFor();
  await shot(page, '04-io-tab-algorithm');

  // W6 — Save as default, on a value this run produced.
  await bindRun(page, RUN_WITH_ARTIFACTS, 'draft_writer');
  await page.locator('#node-tab-io').click();
  await page.locator('#io-save-as-default').waitFor();
  await page.locator('#io-save-as-default').scrollIntoViewIfNeeded();
  await shot(page, '05-save-as-default');

  // W6 — Replay against run, with a result and its schema check.
  await page.locator('#node-tab-prompt').click();
  await page.locator('#replay-panel').waitFor();
  await page.locator('#replay-run').click();
  await page.locator('.modal button', { hasText: 'Confirm' }).click();
  await page.locator('#replay-result').waitFor();
  // Wait for the schema check to settle — otherwise the shot catches "Checking the replayed output
  // against this node's schema…" over a button still reading "Replaying…".
  await page.locator('#replay-result').getByText(/satisfies this node|does not satisfy|Schema check could not/).waitFor();
  await page.locator('#replay-panel').scrollIntoViewIfNeeded();
  await shot(page, '06-replay-against-run');

  // W5 — the Client Manager page. No silent catch on these selectors: an unmet one meant the shot
  // captured the Registry's DEFAULT tab and filed it as the Client Manager, which is exactly what
  // the first run of this script produced.
  await setScreen(page, 'registry');
  await setSubTab(page, 'setReg', 'agents');
  await page.locator('#client-manager-prompt').waitFor({ timeout: 30_000 });
  await shot(page, '07-client-manager');

  // W5 — Runs → Scores.
  await setScreen(page, 'runs');
  await setSubTab(page, 'setRunTab', 'scores');
  await page.locator('#scores-table, #scores-none').first().waitFor({ timeout: 30_000 });
  await shot(page, '08-run-scores');

  // W4 — the dock's run timeline.
  await bindRun(page, RUN_WITH_ARTIFACTS, 'draft_writer');
  await setScreen(page, 'bench');
  await page.locator('#run-timeline').scrollIntoViewIfNeeded();
  await shot(page, '09-run-timeline');
});
