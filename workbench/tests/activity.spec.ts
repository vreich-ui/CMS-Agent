import { expect, test, type Page } from '@playwright/test';
import changesFixture from '../src/api/fixtures/changes.json' with { type: 'json' };

// U4 — the learning activity feed. Fixture mode (VITE_MOCK default), same
// pattern as tests/learning.spec.ts and tests/diff.spec.ts: real fixture
// ids, no hardcoded stand-ins.

const LAST_VISIT_KEY = 'cw-rail-lastvisit';

type FixtureEvent = {
  eventId: string;
  target?: { id: string };
  actor?: { kind: string; label?: string };
  reason?: string;
  createdAt: string;
};
const EVENTS = (changesFixture as { events: FixtureEvent[] }).events;
const HUMAN_EVENT = EVENTS.find((e) => e.actor?.kind === 'human')!;
const AGENT_EVENT = EVENTS.find((e) => e.eventId === 'evt_1786467679822_ybk8py')!; // Claude (oauth) prompt edit
const OPTIMIZER_EVENT = EVENTS.find((e) => e.actor?.label?.includes('Optimizer promotion'))!;
const PLAYBOOK_EVENT = EVENTS.find((e) => e.actor?.label === 'Playbook curation')!;
const SYSTEM_EVENT = EVENTS.find((e) => e.actor?.kind === 'system')!;

async function gotoLearning(page: Page) {
  await page.goto('/');
  await page.locator('nav.main button[data-s="learning"]').click();
  await expect(page.locator('.pagehead h1')).toHaveText('Learning');
}

async function openActivityTab(page: Page) {
  await page.locator('#lrntabs button[data-t="act"]').click();
  await expect(page.locator('#lrntabs button[data-t="act"]')).toHaveClass(/on/);
  await expect(page.locator('.act-strip')).toBeVisible();
}

test.describe('Learning → Activity', () => {
  test('lists all five fixture event kinds — actor, node, change kind, and reason each visible', async ({
    page,
  }) => {
    await gotoLearning(page);
    await openActivityTab(page);

    await expect(page.locator('.act-strip--items')).toBeVisible();
    const rows = page.locator('.actrow');
    await expect(rows).toHaveCount(5);

    // Human edit — Wolf, tools_updated.
    const humanRow = rows.filter({ hasText: HUMAN_EVENT.reason! });
    await expect(humanRow).toHaveCount(1);
    await expect(humanRow.locator('.actor-badge')).toContainText('human');
    await expect(humanRow.locator('.actor-badge')).toContainText('Wolf');
    await expect(humanRow.locator('.actrow-node')).toHaveText(HUMAN_EVENT.target!.id);

    // Agent edit — Claude (oauth), prompt_updated.
    const agentRow = rows.filter({ hasText: AGENT_EVENT.reason! });
    await expect(agentRow).toHaveCount(1);
    await expect(agentRow.locator('.actor-badge')).toContainText('agent');
    await expect(agentRow.locator('.actor-badge')).toContainText(AGENT_EVENT.actor!.label!);

    // Optimizer promotion — trial attribution and score delta ride in the
    // actor label / reason exactly as the live verb carries them.
    const optRow = rows.filter({ hasText: OPTIMIZER_EVENT.actor!.label! });
    await expect(optRow).toHaveCount(1);
    await expect(optRow.locator('.actor-badge')).toContainText('agent');
    await expect(optRow).toContainText(OPTIMIZER_EVENT.reason!);

    // Playbook delta.
    const pbRow = rows.filter({ hasText: PLAYBOOK_EVENT.actor!.label! });
    await expect(pbRow).toHaveCount(1);
    await expect(pbRow).toContainText('Playbook delta applied');
    await expect(pbRow).toContainText(PLAYBOOK_EVENT.reason!);

    // Model-ladder step — system actor.
    const sysRow = rows.filter({ hasText: SYSTEM_EVENT.actor!.label! });
    await expect(sysRow).toHaveCount(1);
    await expect(sysRow.locator('.actor-badge')).toContainText('system');
    await expect(sysRow).toContainText('Model config updated');

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: 'shots/activity-feed.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await expect(page.locator('.act-strip--items')).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  });

  test('an entry opens the diff & merge studio on its exact parent → resulting revision pair', async ({ page }) => {
    await gotoLearning(page);
    await openActivityTab(page);

    const pbRow = page.locator('.actrow', { hasText: 'Playbook curation' });
    await pbRow.locator('button', { hasText: 'diff & merge studio' }).click();

    await expect(page.locator('.modal h3')).toHaveText('Diff & merge studio');
    await expect(page.locator('.modal .sub')).toContainText('review_aggregator');
    await expect(page.locator('.modal')).toContainText('Playbook curation'); // actor label
    await expect(page.locator('.modal')).toContainText('aggregator was passing drafts'); // reason
  });

  test('the actor-kind filter narrows the list using the server-side actorKind argument', async ({ page }) => {
    await gotoLearning(page);
    await openActivityTab(page);

    await expect(page.locator('.actrow')).toHaveCount(5);

    await page.locator('select[aria-label="filter by actor kind"]').selectOption('human');
    await expect(page.locator('.actrow')).toHaveCount(1);
    await expect(page.locator('.actrow')).toContainText('Wolf');

    await page.locator('select[aria-label="filter by actor kind"]').selectOption('system');
    await expect(page.locator('.actrow')).toHaveCount(1);
    await expect(page.locator('.actrow')).toContainText('Model ladder');

    await page.locator('select[aria-label="filter by actor kind"]').selectOption('agent');
    await expect(page.locator('.actrow')).toHaveCount(3); // Claude (oauth), optimizer, playbook — all agent-kind

    await page.locator('select[aria-label="filter by actor kind"]').selectOption('');
    await expect(page.locator('.actrow')).toHaveCount(5);
  });

  test('a failed changes_list call renders a named error, never an empty-feed all-clear, and recovers on retry', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ACTIVITY_FORCE_FAILURE__?: string | null }).__ACTIVITY_FORCE_FAILURE__ =
        'changes_list: Anthropic Proxy: Invalid content from server';
    });
    await gotoLearning(page);
    await openActivityTab(page);

    const strip = page.locator('.act-strip');
    await expect(strip).toHaveClass(/act-strip--error/, { timeout: 10_000 });
    await expect(strip).toContainText('The activity feed could not load');
    await expect(strip).toContainText('changes_list: Anthropic Proxy');
    // The one wrong answer this feed can give.
    await expect(strip).not.toContainText('No changes match these filters');
    await expect(page.locator('.actrow')).toHaveCount(0);

    const retry = strip.locator('button', { hasText: 'Retry' });
    await expect(retry).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __ACTIVITY_FORCE_FAILURE__?: string | null }).__ACTIVITY_FORCE_FAILURE__ = null;
    });
    await retry.click();
    await expect(page.locator('.act-strip--error')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.act-strip--items')).toHaveCount(1);
    await expect(page.locator('.actrow')).toHaveCount(5);
  });

  test('"since your last visit" round-trips through localStorage and shares Rail\'s exact key', async ({ page }) => {
    // The app's default screen is the Workbench, so Rail.tsx (read-only for
    // this WP) has already mounted and marked a visit under this same key
    // by the time the page settles — reset to "never visited" AFTER that
    // mount so this test starts from a known state instead of racing it.
    await page.goto('/');
    await page.evaluate((key) => window.localStorage.setItem(key, '0'), LAST_VISIT_KEY);

    await page.locator('nav.main button[data-s="learning"]').click();
    await expect(page.locator('.pagehead h1')).toHaveText('Learning');

    // Never visited — every fixture event (all dated well before "now")
    // reads as new, and the Activity subtab carries a matching count badge
    // before it's ever opened.
    const badge = page.locator('#lrntabs button[data-t="act"] .act-tab-badge');
    await expect(badge).toHaveText('5');

    await openActivityTab(page);
    await expect(page.locator('.actrow.act-new')).toHaveCount(5);
    await expect(page.locator('.actrow.act-new .chip-learned').first()).toHaveText('new');

    // Opening the feed just wrote a fresh visit timestamp under the SAME
    // key Rail.tsx reads/writes — verify it actually round-tripped (a
    // numeric string, and strictly newer than the '0' seeded above), not
    // merely that the UI looks right this one render.
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), LAST_VISIT_KEY);
    expect(stored).not.toBeNull();
    expect(Number(stored)).toBeGreaterThan(0);

    // A fresh visit to the *Workbench* — Rail's own mount, not this feed's
    // — writes the same key again. Coming back to Learning afterward
    // proves the two surfaces really do share one clock: nothing here
    // looks new either, because Rail's own "I was just here" never
    // disagrees with this feed's.
    await page.locator('nav.main button[data-s="bench"]').click();
    await page.locator('nav.main button[data-s="learning"]').click();
    await expect(page.locator('#lrntabs button[data-t="act"] .act-tab-badge')).toHaveCount(0);
    await openActivityTab(page);
    await expect(page.locator('.actrow.act-new')).toHaveCount(0);
    await expect(page.locator('.actrow')).toHaveCount(5);
  });

  test('Flywheel’s recent-activity column shows the same feed and jumps to the full Activity subtab', async ({
    page,
  }) => {
    await gotoLearning(page);
    const card = page.locator('.card', { hasText: 'recent activity' });
    await expect(card).toBeVisible();
    await expect(card.locator('.actrow')).toHaveCount(5);

    await card.locator('button', { hasText: 'Open full activity feed' }).click();
    await expect(page.locator('#lrntabs button[data-t="act"]')).toHaveClass(/on/);
    await expect(page.locator('.act-strip--items')).toBeVisible();
  });
});
