import { expect, test, type Page } from '@playwright/test';

// WP-31..34 smoke: node editing with live/pinned truth-telling, save →
// History, effective-prompt injection marking, schema validate-before-save
// refusals, tool-risk visibility before granting, and restore. Against
// fixture data (VITE_MOCK default, VITE_READ_ONLY=0 in .env.development).
// Mirrors tests/runcontrol.spec.ts's confirm-dialog pattern.

const confirmDialog = (page: Page) => page.locator('.scrim.open .modal').filter({ has: page.locator('#confirmdialog-title') });

async function expectConfirmVerb(page: Page, verb: string) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.sub')).toHaveText(verb);
  return dialog;
}

async function openWorkbenchNode(page: Page, nodeName: string) {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Workbench' }).click();
  await page.locator('.rail .nrow', { hasText: nodeName }).click();
}

test.describe('live vs pinned truth-telling', () => {
  test('every owned tab marks its fields live; Dependencies stays pinned', async ({ page }) => {
    await openWorkbenchNode(page, 'draft_writer');

    await page.locator('.tabs button', { hasText: 'Prompt' }).click();
    await expect(page.locator('.center .pin.live').first()).toHaveText(/live/);

    await page.locator('.tabs button', { hasText: 'Tools' }).click();
    await expect(page.locator('.center .pin.live').first()).toHaveText('live');

    await page.locator('.tabs button', { hasText: 'Skills' }).click();
    await expect(page.locator('.center .pin.live').first()).toHaveText('live');

    await page.locator('.tabs button', { hasText: 'Schemas' }).click();
    await expect(page.locator('.center .pin.live')).toHaveCount(2); // input + output cards

    await page.locator('.tabs button', { hasText: 'Model & limits' }).click();
    await expect(page.locator('.center .pin.live').first()).toHaveText('live');

    // Dependencies is out of this WP's scope — still pinned, names the re-seed path.
    await page.locator('.tabs button', { hasText: 'Dependencies' }).click();
    await expect(page.locator('.center .pin.pinned')).toHaveText('pinned to seed');
    await expect(page.locator('.center')).toContainText('npm run nodes:update');
  });
});

test.describe('WP-31 prompt editing', () => {
  test('editing and saving a prompt adds a History entry; diff and effective preview render', async ({ page }) => {
    await openWorkbenchNode(page, 'draft_writer');
    await page.locator('.tabs button', { hasText: 'Prompt' }).click();

    const editor = page.locator('[aria-label="stored prompt"]');
    const original = (await editor.textContent()) ?? '';
    expect(original).toContain('Objective:');

    const saveBtn = page.locator('.editnote button', { hasText: 'Save' });
    await expect(saveBtn).toBeDisabled(); // nothing dirty yet

    // Click in and append a single-line suffix by real keystrokes (not
    // .fill(), which restructures a multi-line contenteditable's DOM on
    // insert and would make the later exact-text round-trip checks flaky).
    // design-review fix — this string round-trips into shots/edit-prompt.png
    // and shots/history-diff.png, so it must read as plausible prompt copy
    // rather than test-authoring residue (a prior version literally named
    // this spec file inside the appended text).
    const appended = ' Tightened schema-adherence clause: name any field you cannot fill rather than omitting it.';
    const edited = `${original}${appended}`;
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(appended);
    await expect(page.locator('.center .pin', { hasText: 'unsaved draft' })).toBeVisible();
    await expect(saveBtn).toBeEnabled();
    await page.screenshot({ path: 'shots/edit-prompt.png' });

    await saveBtn.click();
    await expectConfirmVerb(page, 'workspace_update_node_prompt');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workspace_update_node_prompt');
    await expect(page.locator('.center .pin', { hasText: 'unsaved draft' })).toHaveCount(0);
    await expect(editor).toHaveText(edited);

    // --- Diff vs canonical: canonical (pre-edit) vs the now-saved text ---
    await page.locator('.editnote button', { hasText: 'Diff vs canonical' }).click();
    await expect(page.locator('.diffline.add, .diffline.del').first()).toBeVisible();

    // --- Effective-prompt preview visibly distinguishes injected content ---
    await page.locator('.editnote button', { hasText: 'Preview effective' }).click();
    const skillBlock = page.locator('.center', { hasText: 'skill injection · editorial_craft' });
    await expect(skillBlock).toBeVisible();
    const skillLabel = page.locator('.lbl', { hasText: 'skill injection · editorial_craft' });
    // Distinct styling (accent color, not the plain prompt text's default), not just distinct wording.
    await expect(skillLabel).toHaveAttribute('style', /color:\s*var\(--acc\)/);
    await expect(page.locator('.center .lbl', { hasText: 'playbook lessons' })).toBeVisible();

    // --- History: the save is recorded, with a working diff ---
    await page.locator('.tabs button', { hasText: 'History' }).click();
    const row = page.locator('.histrow', { hasText: 'prompt edited' });
    await expect(row).toBeVisible();
    await row.locator('button', { hasText: 'diff' }).click();
    await expect(page.locator('.diffline.add').first()).toBeVisible();
    await page.screenshot({ path: 'shots/history-diff.png' });

    // --- Restore round-trips the value back into the Prompt editor ---
    await row.locator('button', { hasText: 'restore' }).click();
    await expectConfirmVerb(page, 'changes_restore');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('changes_restore');
    await expect(page.locator('.tabs button.on')).toHaveText('Prompt');
    await expect(page.locator('[aria-label="stored prompt"]')).toHaveText(original);
    await expect(page.locator('.center .pin', { hasText: 'unsaved draft' })).toBeVisible(); // restored, not yet re-saved
  });

  test('switching node preserves an unsaved prompt draft instead of discarding it', async ({ page }) => {
    await openWorkbenchNode(page, 'draft_writer');
    await page.locator('.tabs button', { hasText: 'Prompt' }).click();
    const editor = page.locator('[aria-label="stored prompt"]');
    const original = (await editor.textContent()) ?? '';
    const draftText = 'A draft that must survive a node switch.';
    await editor.fill(draftText);
    await expect(page.locator('.center .pin', { hasText: 'unsaved draft' })).toBeVisible();

    // Switch to another node and back — the draft must still be there.
    await page.locator('.rail .nrow', { hasText: 'topic_opportunity' }).click();
    await expect(page.locator('.nhead h2')).not.toHaveText('Full Draft Writer');
    await page.locator('.rail .nrow', { hasText: 'draft_writer' }).click();
    await page.locator('.tabs button', { hasText: 'Prompt' }).click();
    await expect(editor).toHaveText(draftText);
    await expect(page.locator('.center .pin', { hasText: 'unsaved draft' })).toBeVisible();

    // Clean up: discard so this draft doesn't leak into later tests via the module-level cache.
    await page.locator('.editnote button', { hasText: 'Discard draft' }).click();
    await expect(editor).toHaveText(original);
  });
});

test.describe('WP-33 schema validation', () => {
  test('malformed JSON and a schema-invalid-but-parseable document are both refused with a legible, path-specific reason', async ({ page }) => {
    await openWorkbenchNode(page, 'topic_opportunity');
    await page.locator('.tabs button', { hasText: 'Schemas' }).click();

    const outputCard = page.locator('.card').filter({ has: page.locator('.lbl', { hasText: 'output schema' }) });
    const editor = outputCard.locator('textarea.schemabox');
    const saveBtn = outputCard.locator('button', { hasText: 'Validate & save' });

    // --- malformed JSON: a parse error with line/column, no confirm dialog fires ---
    await editor.fill('{ "type": "object", }');
    await saveBtn.click();
    await expect(outputCard).toContainText('Malformed JSON');
    await expect(outputCard).toContainText(/line \d+, column \d+/);
    await expect(confirmDialog(page)).toHaveCount(0);
    await page.screenshot({ path: 'shots/edit-schema-error.png' });

    // --- parseable but schema-invalid: required is a string, not an array ---
    await editor.fill('{ "type": "object", "properties": { "title": { "type": "string" } }, "required": "title" }');
    await saveBtn.click();
    await expect(outputCard).toContainText('$.required');
    await expect(outputCard).toContainText('must be an array');
    await expect(confirmDialog(page)).toHaveCount(0);

    // --- a bad type name, also caught and named at its own path ---
    await editor.fill('{ "type": "objekt" }');
    await saveBtn.click();
    await expect(outputCard).toContainText('$.type');
    await expect(confirmDialog(page)).toHaveCount(0);

    // --- now a valid schema: validates, and actually saves ---
    await editor.fill('{ "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] }');
    await saveBtn.click();
    await expectConfirmVerb(page, 'workspace_update_node_output_schema');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workspace_update_node_output_schema');
    await expect(outputCard.locator('.valnote')).toBeVisible();
    await expect(outputCard).toContainText('edited this session');
  });
});

test.describe('WP-32 tools & skills', () => {
  test('adding a publish/write-risk tool shows its risk and side-effect before the grant is confirmed', async ({ page }) => {
    await openWorkbenchNode(page, 'draft_writer');
    await page.locator('.tabs button', { hasText: 'Tools' }).click();
    await expect(page.locator('.toolrow', { hasText: 'clone.mint' })).toHaveCount(0);

    await page.locator('.editnote button', { hasText: '+ add from registry' }).click();
    await page.locator('#registry-picker-filter').fill('clone.mint');
    const row = page.locator('.modal .toolrow').filter({ has: page.locator('.tn', { hasText: 'clone.mint' }) });
    await expect(row).toBeVisible();
    // Risk + side-effect + "needs approval" are all visible in this row —
    // before the add button is even clicked, let alone confirmed.
    await expect(row.locator('.risk.write')).toHaveText('write');
    await expect(row).toContainText('external_write');
    await expect(row).toContainText('needs approval');

    await row.locator('button', { hasText: 'add' }).click();
    await expectConfirmVerb(page, 'workspace_update_node_tools');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workspace_update_node_tools');

    const grantedRow = page.locator('.center .toolrow', { hasText: 'clone.mint' });
    await expect(grantedRow).toBeVisible();
    await expect(grantedRow.locator('.risk.write')).toHaveText('write');
    await expect(grantedRow).toContainText('needs approval');
  });

  test('skills picker surfaces the zero-assignment skills up front and unassign/assign round-trips', async ({ page }) => {
    await openWorkbenchNode(page, 'draft_writer');
    await page.locator('.tabs button', { hasText: 'Skills' }).click();
    await expect(page.locator('.center .toolrow', { hasText: 'editorial_craft' })).toBeVisible();

    await page.locator('.editnote button', { hasText: '+ assign from registry' }).click();
    const firstRow = page.locator('.modal .toolrow').first();
    await expect(firstRow).toContainText('unused'); // unused skills sorted first
    await expect(firstRow.locator('.chip', { hasText: 'unused' })).toBeVisible();
    const firstId = (await firstRow.locator('.tn').textContent()) ?? '';
    await firstRow.locator('button', { hasText: 'add' }).click();
    await expectConfirmVerb(page, 'workspace_update_node_skills');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workspace_update_node_skills');
    await expect(page.locator('.center .toolrow', { hasText: firstId })).toBeVisible();

    // Unassign it back out again.
    const assignedRow = page.locator('.center .toolrow', { hasText: firstId });
    await assignedRow.locator('button', { hasText: 'unassign' }).click();
    await expectConfirmVerb(page, 'workspace_update_node_skills');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('.center .toolrow', { hasText: firstId })).toHaveCount(0);
  });
});

test.describe('WP-33 model & limits', () => {
  test('a zero budget and a negative timeout are refused client-side, with a stated reason, before any round-trip', async ({ page }) => {
    await openWorkbenchNode(page, 'draft_writer');
    await page.locator('.tabs button', { hasText: 'Model & limits' }).click();
    await page.locator('.editnote button', { hasText: 'Edit' }).click();

    await page.locator('#model-budgetUsd').fill('0');
    await page.locator('#model-timeoutSeconds').fill('-5');
    await page.locator('.editnote button', { hasText: 'Save' }).click();

    await expect(page.locator('#model-budgetUsd-err')).toContainText('greater than 0');
    await expect(page.locator('#model-timeoutSeconds-err')).toContainText('greater than 0');
    await expect(confirmDialog(page)).toHaveCount(0);

    // Fix them and save for real.
    await page.locator('#model-budgetUsd').fill('0.75');
    await page.locator('#model-timeoutSeconds').fill('120');
    await page.locator('.editnote button', { hasText: 'Save' }).click();
    await expectConfirmVerb(page, 'workspace_update_node_model_config');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workspace_update_node_model_config');
    await expect(page.locator('.center .kv .num').first()).toHaveText('0.75');
  });
});
