import { expect, test, type Page } from '@playwright/test';
import { autoMergeText, computeProseDiff, diffArray, splitLines, tokenizeWords } from '../src/components/diff/textDiff';
import { deepEqual, diffFields, classifyValueDiff } from '../src/components/diff/structuredDiff';
import changesFixture from '../src/api/fixtures/changes.json' with { type: 'json' };

// U2 — the diff & merge studio. Two halves, same pattern tests/adapters.spec.ts
// already established for this repo:
//   1. plain Node assertions against the pure diff engine (textDiff.ts /
//      structuredDiff.ts) — no `page`, no browser.
//   2. real Playwright coverage of the studio itself against fixture data
//      (VITE_MOCK default, VITE_READ_ONLY=0 in .env.development), reusing
//      the real fixture event draft_writer's prompt_updated change carries
//      (api/fixtures/changes.json) rather than any hardcoded stand-in.

const DRAFT_WRITER_PROMPT_EVENT = (changesFixture as { events: Array<Record<string, unknown>> }).events.find(
  (e) => e.target && (e.target as { id?: string }).id === 'draft_writer' && e.type === 'node.prompt_updated',
) as { parentRevisionId: string; resultingRevisionId: string };

// =============================== pure engine ==================================

test.describe('textDiff (pure)', () => {
  test('diffArray: equal/add/remove over a simple array', () => {
    const ops = diffArray(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(ops).toEqual([
      { type: 'equal', value: 'a' },
      { type: 'remove', value: 'b' },
      { type: 'add', value: 'x' },
      { type: 'equal', value: 'c' },
    ]);
  });

  test('diffArray: pure addition and pure removal', () => {
    expect(diffArray(['a'], ['a', 'b'])).toEqual([
      { type: 'equal', value: 'a' },
      { type: 'add', value: 'b' },
    ]);
    expect(diffArray(['a', 'b'], ['a'])).toEqual([
      { type: 'equal', value: 'a' },
      { type: 'remove', value: 'b' },
    ]);
  });

  test('splitLines / tokenizeWords round-trip', () => {
    expect(splitLines('one\ntwo\nthree')).toEqual(['one', 'two', 'three']);
    const tokens = tokenizeWords('brief.v0 in the');
    expect(tokens.join('')).toBe('brief.v0 in the'); // whitespace kept as its own token
    expect(tokens[0]).toBe('brief.v0'); // one token, not split on the dot
  });

  test('computeProseDiff: a single changed word inside an otherwise identical line is a "modify", not two struck-through paragraphs', () => {
    const before = 'Line one unchanged.\nWrite the draft from brief.v0 in the voice.\nLine three unchanged.';
    const after = 'Line one unchanged.\nWrite the draft from article_brief.v1 in the voice.\nLine three unchanged.';
    const lines = computeProseDiff(before, after);
    expect(lines.filter((l) => l.type === 'equal')).toHaveLength(2);
    const modified = lines.filter((l) => l.type === 'modify');
    expect(modified).toHaveLength(1);
    // Word-level: only the one token changed, not the whole line as a unit.
    const words = modified[0].words ?? [];
    expect(words.some((w) => w.type === 'remove' && w.value === 'brief.v0')).toBe(true);
    expect(words.some((w) => w.type === 'add' && w.value === 'article_brief.v1')).toBe(true);
    expect(words.filter((w) => w.type === 'equal').length).toBeGreaterThan(0);
  });

  test('computeProseDiff: identical texts produce only equal lines', () => {
    const lines = computeProseDiff('same\ntext', 'same\ntext');
    expect(lines.every((l) => l.type === 'equal')).toBe(true);
  });

  test('autoMergeText: unchanged lines pass through, B-only additions are kept, A-only lines are dropped, and a genuinely conflicting line gets git-style markers', () => {
    // Anchored with unique shared lines on both sides of each change so the
    // line-level LCS can't cross-pair an unrelated remove with an unrelated
    // add — "only in A" and "only in B" each sit in their own hunk,
    // isolating the one line both sides actually edited differently.
    const a = 'shared1\nonly in A\nshared2\nboth changed this\nshared3\n';
    const b = 'shared1\nshared2\nboth changed this differently\nshared3\nonly in B\n';
    const { text, conflicts } = autoMergeText(a, b, 'A', 'B');
    expect(text).toContain('shared1');
    expect(text).toContain('shared2');
    expect(text).toContain('shared3');
    expect(text).not.toContain('only in A');
    expect(text).toContain('only in B');
    expect(text).toContain('<<<<<<< A');
    expect(text).toContain('both changed this\n');
    expect(text).toContain('=======');
    expect(text).toContain('both changed this differently');
    expect(text).toContain('>>>>>>> B');
    expect(conflicts).toBe(1);
  });

  test('autoMergeText: two identical texts merge with zero conflicts', () => {
    const { text, conflicts } = autoMergeText('same text', 'same text');
    expect(conflicts).toBe(0);
    expect(text).toBe('same text');
  });
});

test.describe('structuredDiff (pure)', () => {
  test('deepEqual ignores key order but not content', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, { x: 1 }], [1, { x: 1 }])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  test('classifyValueDiff: primitive arrays diff as added/removed members, never re-printed whole', () => {
    const row = classifyValueDiff('allowedTools', ['a', 'b', 'c'], ['a', 'c', 'd']);
    expect(row.kind).toBe('array');
    expect(row.arrayRemoved).toEqual(['b']);
    expect(row.arrayAdded).toEqual(['d']);
  });

  test('classifyValueDiff: scalars diff as before/after', () => {
    const row = classifyValueDiff('riskLevel', 'read', 'write');
    expect(row.kind).toBe('scalar');
    expect(row.before).toBe('read');
    expect(row.after).toBe('write');
  });

  test('classifyValueDiff: a deep object falls back to pretty-printed line/word diff, not a raw dump', () => {
    const row = classifyValueDiff('modelConfig', { maxTurns: 3, timeout: 1000 }, { maxTurns: 4, timeout: 1000 });
    expect(row.kind).toBe('json');
    expect(row.jsonLines).toBeDefined();
    // At least one line actually differs (maxTurns), and at least one is
    // unchanged (timeout) — proof this isn't a whole-object dump.
    expect(row.jsonLines!.some((l) => l.type !== 'equal')).toBe(true);
    expect(row.jsonLines!.some((l) => l.type === 'equal')).toBe(true);
  });

  test('diffFields: unchanged fields collapse to names only; the prompt field is excluded (handled as prose elsewhere)', () => {
    const before = { prompt: 'a', riskLevel: 'read', name: 'Same', allowedTools: ['x'] };
    const after = { prompt: 'b', riskLevel: 'write', name: 'Same', allowedTools: ['x'] };
    const { changed, unchanged } = diffFields(before, after, { exclude: ['prompt'] });
    expect(changed.map((r) => r.key)).toEqual(['riskLevel']);
    expect(unchanged).toContain('name');
    expect(unchanged).toContain('allowedTools');
    expect(changed.some((r) => r.key === 'prompt')).toBe(false);
  });
});

// =================================== studio (E2E) ================================

const confirmDialog = (page: Page) => page.locator('.scrim.open .modal').filter({ has: page.locator('#confirmdialog-title') });

async function openDraftWriterHistory(page: Page) {
  await page.goto('/');
  await page.locator('.rail .nrow', { hasText: 'draft_writer' }).click();
  await expect(page.locator('.nhead .id')).toHaveText('draft_writer');
  await page.locator('.tabs button', { hasText: 'History' }).click();
  await expect(page.locator('.card', { hasText: 'change history' })).toBeVisible();
}

test.describe('Diff & merge studio', () => {
  test('opens from a History row on the real parent → resulting revision pair, with word-level highlighting inside the changed line', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await openDraftWriterHistory(page);

    const promptRow = page.locator('.histrow', { hasText: 'prompt' }).first();
    await expect(promptRow).toBeVisible();
    await promptRow.locator('button', { hasText: 'diff & merge studio' }).click();

    await expect(page.locator('.modal h3')).toHaveText('Diff & merge studio');
    await expect(page.locator('.modal.ovl-work')).toBeVisible();
    // The comparison is addressed by the real revision ids — never a blank
    // or generic modal.
    await expect(page.locator('.modal .sub')).toContainText('draft_writer');
    await expect(page.locator('.modal')).toContainText('Handoff 2.2'); // the event's real `reason`
    await expect(page.locator('.modal')).toContainText('Claude (oauth)'); // the event's real actor label

    // Word-level highlighting: split layout is the default, so each side is
    // its own labelled, scrollable region (a11y).
    await expect(page.locator('[role="region"]')).toHaveCount(2);
    const removedWord = page.locator('.dsword.rm', { hasText: 'brief.v0' });
    const addedWord = page.locator('.dsword.add', { hasText: 'article_brief.v1' });
    await expect(removedWord).toBeVisible();
    await expect(addedWord).toBeVisible();
    // The rest of the (much longer) line is untouched — proof this is a
    // per-word highlight, not the whole paragraph struck through.
    await expect(page.locator('.dsword.rm', { hasText: 'Objective:' })).toHaveCount(0);

    // Nothing else changed in this event — the structured section says so
    // plainly instead of rendering an empty JSON wall.
    await expect(page.locator('.card', { hasText: 'other fields' })).toContainText('No other fields changed');

    // Inline (unified) toggle works and is a real aria-pressed control.
    const splitBtn = page.locator('.dscontrols button', { hasText: 'side by side' });
    const inlineBtn = page.locator('.dscontrols button', { hasText: 'inline' });
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true');
    await inlineBtn.click();
    await expect(inlineBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[role="region"]')).toHaveCount(0); // unified: one flow, not two panes
    await expect(page.locator('.dsword.rm', { hasText: 'brief.v0' })).toBeVisible();

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: 'shots/diff-studio.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await expect(page.locator('.modal h3')).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  test('editing the Result pane and saving writes a real new prompt via workspace_update_node_prompt', async ({ page }) => {
    await openDraftWriterHistory(page);
    await page.locator('.histrow', { hasText: 'prompt' }).first().locator('button', { hasText: 'diff & merge studio' }).click();
    await expect(page.locator('.modal h3')).toHaveText('Diff & merge studio');

    const marker = 'U2-TEST-MARKER-EDITED-PROMPT';
    const textarea = page.locator('#diffstudio-result');
    await expect(textarea).toBeVisible();
    await expect(page.locator('label[for="diffstudio-result"]')).toHaveText('result (editable)');
    await textarea.fill(marker);

    await page.locator('button', { hasText: 'Save as new revision' }).click();
    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.sub')).toHaveText('workspace_update_node_prompt');
    await dialog.locator('button', { hasText: 'Confirm' }).click();
    await expect(confirmDialog(page)).toHaveCount(0);

    await expect(page.locator('#toasts')).toContainText('workspace_update_node_prompt');
    // The studio closes on a successful save.
    await expect(page.locator('.modal h3', { hasText: 'Diff & merge studio' })).toHaveCount(0);

    // The edit actually persisted — Prompt tab reads it straight back.
    await page.locator('.tabs button', { hasText: 'Prompt' }).click();
    await expect(page.locator('.promptbox').first()).toContainText(marker);
  });

  test('Escape preserves the Result draft; reopening the same comparison restores it instead of re-seeding', async ({ page }) => {
    await openDraftWriterHistory(page);
    const openStudio = () => page.locator('.histrow', { hasText: 'prompt' }).first().locator('button', { hasText: 'diff & merge studio' }).click();

    await openStudio();
    const marker = 'U2-DRAFT-SURVIVES-ESCAPE';
    const textarea = page.locator('#diffstudio-result');
    await textarea.fill(marker);

    await page.keyboard.press('Escape');
    await expect(page.locator('.modal h3', { hasText: 'Diff & merge studio' })).toHaveCount(0);

    await openStudio();
    await expect(page.locator('#diffstudio-result')).toHaveValue(marker);
  });

  test('deep link ?modal=diff&m.mode=revisions&… opens the exact same comparison on a cold load', async ({ page }) => {
    const url = `/?modal=diff&m.mode=revisions&m.node=draft_writer&m.revA=${DRAFT_WRITER_PROMPT_EVENT.parentRevisionId}&m.revB=${DRAFT_WRITER_PROMPT_EVENT.resultingRevisionId}`;
    await page.goto(url);

    await expect(page.locator('.modal h3')).toHaveText('Diff & merge studio');
    await expect(page.locator('.modal .sub')).toContainText('draft_writer');
    await expect(page.locator('.dsword.rm', { hasText: 'brief.v0' })).toBeVisible();
    await expect(page.locator('.dsword.add', { hasText: 'article_brief.v1' })).toBeVisible();
  });

  test('a missing param produces a named empty state, never a blank modal or a crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/?modal=diff&m.mode=revisions&m.node=draft_writer');
    await expect(page.locator('.modal h3')).toHaveText('Diff & merge studio');
    await expect(page.locator('.card', { hasText: 'nothing to compare' })).toContainText('revA');
    await expect(page.locator('.card', { hasText: 'nothing to compare' })).toContainText('revB');

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
});
