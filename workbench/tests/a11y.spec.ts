import { expect, test } from '@playwright/test';

// Regression coverage for the WP-R gate's accessibility fixes
// (A11Y-REVIEW.md) — focused on the findings most likely to silently
// regress because nothing else in the suite asserts on ARIA/DOM-state
// attributes rather than visible text or class names.

test.describe('a11y — toasts (C1)', () => {
  test('#toasts is a polite live region, and stays one once a toast fires', async ({ page }) => {
    await page.goto('/');
    const toasts = page.locator('#toasts');
    await expect(toasts).toHaveAttribute('role', 'status');
    await expect(toasts).toHaveAttribute('aria-live', 'polite');

    // Fire a real toast (theme toggle is a trivial, always-available action)
    // and confirm the live region still carries the announcement.
    await page.locator('#themebtn').click();
    await expect(toasts).toHaveAttribute('role', 'status');
    await expect(toasts).toHaveAttribute('aria-live', 'polite');
  });
});

test.describe('a11y — command palette (C2/C3)', () => {
  test('input is a combobox wired to the listbox; aria-activedescendant tracks the highlighted option', async ({ page }) => {
    await page.goto('/');
    // App must be mounted (and CommandPalette's own global keydown listener
    // attached) before the shortcut can do anything — on a cold dev-server
    // first load this can lose the race if fired immediately after goto().
    await expect(page.locator('.rail')).toBeVisible();
    await page.keyboard.press('Control+k');
    const input = page.locator('#palinput');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toHaveAttribute('aria-controls', 'palres');

    await page.locator('.palette .res').waitFor();
    await expect(page.locator('#palres')).toHaveAttribute('role', 'listbox');

    await page.keyboard.type('cap');
    const rows = page.locator('#palres button');
    await expect(rows.first()).toHaveAttribute('role', 'option');
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', await rows.first().getAttribute('id'));

    // Real DOM focus never leaves the input — that's the speed model —
    // but the highlighted row now changes via aria-activedescendant.
    await expect(input).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', await rows.nth(1).getAttribute('id'));
    await expect(input).toBeFocused();

    await page.keyboard.press('Escape');
  });

  test('the palette input has a real focus ring, not outline:none with nothing replacing it', async ({ page }) => {
    await page.goto('/');
    // U7 — real bug, not a stale assertion: found by running the full
    // suite (this test isn't in the U7 brief's named-10). Confirmed via
    // `git stash` that it fails identically on the pre-U7 baseline, so
    // it's pre-existing, not a U7 regression. Same cold-start race the
    // sibling test three lines up already names and guards against
    // ("App must be mounted... before the shortcut can do anything — on a
    // cold dev-server first load this can lose the race if fired
    // immediately after goto()") — this test just never had the guard.
    await expect(page.locator('.rail')).toBeVisible();
    // Control+K is a keyboard interaction, so the auto-focus that follows
    // (CommandPalette.tsx's requestAnimationFrame focus() call) qualifies
    // for :focus-visible in Chromium's heuristic.
    await page.keyboard.press('Control+k');
    const input = page.locator('#palinput');
    await expect(input).toBeFocused();
    const boxShadow = await input.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).not.toBe('none');
    expect(boxShadow).toContain('inset');
  });
});

test.describe('a11y — overlay inert (C4) and RegistryPicker focus trap (C5)', () => {
  test('background becomes inert while the start-run modal is open, and clears once it closes', async ({ page }) => {
    await page.goto('/');
    const background = page.locator('div:has(> .topbar)').first();
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(background.evaluate((el) => el.hasAttribute('inert'))).resolves.toBe(false);

    await page.locator('#mode-build').click();
    await page.locator('.dock button', { hasText: '▸ Start run…' }).click();
    await expect(page.locator('.modal', { hasText: 'Start run' })).toBeVisible();
    await expect(background.evaluate((el) => el.hasAttribute('inert'))).resolves.toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('.scrim.open')).toHaveCount(0);
    await expect(background.evaluate((el) => el.hasAttribute('inert'))).resolves.toBe(false);
  });

  test('RegistryPicker traps Tab, restores focus to its trigger on close, and inerts the background while open', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav.main button', { hasText: 'Workbench' }).click();
    await page.locator('.rail .nrow', { hasText: 'draft_writer' }).click();
    await page.locator('.tabs button', { hasText: 'Tools' }).click();

    const trigger = page.locator('.editnote button', { hasText: '+ add from registry' });
    await trigger.click();

    const dialog = page.locator('.modal[aria-label="Add a tool from the registry"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#registry-picker-filter')).toBeFocused();

    // Background is inert while this (portaled) overlay is open.
    const background = page.locator('div:has(> .topbar)').first();
    await expect(background.evaluate((el) => el.hasAttribute('inert'))).resolves.toBe(true);

    // Tab from the last focusable element wraps back to the first — proof
    // of an actual trap, not just "Tab still works".
    const focusable = dialog.locator('button:not(:disabled), input:not(:disabled)');
    const count = await focusable.count();
    expect(count).toBeGreaterThan(1);
    await focusable.nth(count - 1).focus();
    await page.keyboard.press('Tab');
    await expect(focusable.first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // RegistryPicker's own restore-focus is deferred a frame past its
    // cleanup (see Shared.tsx's comment) specifically so `inert` clears
    // first — assert that ordering held, not just the end state.
    await expect(trigger).toBeFocused();
    await expect(background.evaluate((el) => el.hasAttribute('inert'))).resolves.toBe(false);
  });
});
