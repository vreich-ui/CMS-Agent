import { expect, test } from '@playwright/test';

test('CMS-Agent W1 schema boundary uses complete candidates, supported preconditions, envelope readback, and no double wrapper', async ({ page }) => {
  const payloads: unknown[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'log' || !message.text().startsWith('[api mock] workspace_update_node_input_schema')) return;
    void message.args()[1]?.jsonValue().then((value) => payloads.push(value));
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const verbs = await import('/src/api/verbs.ts');
    const confirm = await import('/src/api/confirmAction.ts');
    confirm.resetConfirmHandler();
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
    const prepared = await verbs.workspacePrepareNodeEdit('topic_opportunity');
    const validation = await verbs.workspaceValidateNode({ node: verbs.candidateWithSchema(prepared, 'input', schema) });
    const saved = await verbs.workspaceSaveSchemaWithReadback({ nodeId: 'topic_opportunity', kind: 'input', schema, prepared });
    const readback = await verbs.nodeGetInputSchema({ nodeId: 'topic_opportunity' });
    return { prepared, validation, saved, readback };
  });
  expect(result.prepared.node.id).toBe('topic_opportunity');
  expect(result.prepared.precondition.expectedWorkspaceVersion).toEqual(expect.any(Number));
  expect(result.validation).toEqual({ valid: true, errors: [] });
  expect(result.saved.state).toBe('confirmed');
  expect(result.readback).toEqual({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] });
  await expect.poll(() => payloads.length).toBe(1);
  expect(payloads[0]).toMatchObject({
    id: 'topic_opportunity',
    schema: { type: 'object', properties: { title: { type: 'string' } } },
    expectedWorkspaceVersion: expect.any(Number),
  });
  expect(payloads[0]).not.toHaveProperty('nodeId');
  expect((payloads[0] as { schema: unknown }).schema).not.toHaveProperty('schema');
});

test('CMS-Agent W1 reports invalid candidates, conflicts, backend refusals, and readback uncertainty distinctly', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const verbs = await import('/src/api/verbs.ts');
    const confirm = await import('/src/api/confirmAction.ts');
    confirm.resetConfirmHandler();
    const prepared = await verbs.workspacePrepareNodeEdit('topic_opportunity');
    const refused = await verbs.workspaceValidateNode({
      node: verbs.candidateWithSchema(prepared, 'input', { type: 'object', __backendRefusal: true }),
    });
    let conflict = '';
    try {
      await verbs.workspaceUpdateNodeInputSchema({
        nodeId: 'topic_opportunity', schema: { type: 'object' }, expectedWorkspaceVersion: (prepared.precondition.expectedWorkspaceVersion ?? 0) + 99,
      });
    } catch (error) {
      conflict = error instanceof Error ? error.message : String(error);
    }
    const uncertain = await verbs.workspaceSaveSchemaWithReadback({
      nodeId: 'topic_opportunity', kind: 'input', schema: { type: 'object', __readbackFailure: true }, prepared,
    });
    return { refused, conflict, uncertain };
  });
  expect(result.refused).toEqual({ valid: false, errors: ['The backend refused this candidate schema.'] });
  expect(result.conflict).toContain('workspace_version_conflict');
  expect(result.uncertain).toMatchObject({ state: 'uncertain' });
});

test('CMS-Agent W1 keeps model grants separate from deterministic engine verbs', async ({ page }) => {
  await page.goto('/');
  const effective = await page.evaluate(async () => {
    const verbs = await import('/src/api/verbs.ts');
    return verbs.nodeGetEffectiveTools({ nodeId: 'publish_payload' });
  });
  expect(effective.capability?.executionKind).toBe('deterministic');
  expect(effective.engine).toEqual(['project_call_tool']);
  expect(effective.tools.map((tool) => tool.id)).not.toContain('project_call_tool');
});

test('CMS-Agent W1 unwraps the effective skill-policy envelope instead of treating it as a skill list', async ({ page }) => {
  await page.goto('/');
  const policy = await page.evaluate(async () => {
    const verbs = await import('/src/api/verbs.ts');
    return verbs.nodeGetEffectiveSkills({ nodeId: 'draft_writer' });
  });
  expect(policy.nodeId).toBe('draft_writer');
  expect(policy.skillIds).toContain('editorial_craft');
  expect(policy.conflicts).toEqual([]);
});

test('CMS-Agent W1 prompt calls first observation a session baseline', async ({ page }) => {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Workbench' }).click();
  await page.locator('.rail .nrow', { hasText: 'draft_writer' }).click();
  await page.locator('.tabs button', { hasText: 'Prompt' }).click();
  await page.getByRole('button', { name: 'Diff vs session baseline' }).click();
  await expect(page.getByText(/session baseline = the prompt first observed this session/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide diff' })).toBeVisible();
});
