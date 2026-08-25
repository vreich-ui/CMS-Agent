import { expect, test } from '@playwright/test';
import {
  assignedSkillsByNode,
  durationText,
  shortDate,
  toAgent,
  toDataset,
  toFinetuneReadiness,
  toModelConfig,
  toNode,
  toObservation,
  toProject,
  toRubric,
  toRun,
  toSkill,
  toToolDef,
  toUsageSummary,
  type RawAgent,
  type RawDataset,
  type RawFinetuneReadiness,
  type RawObservation,
  type RawProject,
  type RawRegressionReport,
  type RawRubric,
  type RawRun,
  type RawRunCostLedger,
  type RawSkill,
  type RawToolDef,
  type RawWorkflowNode,
} from '../src/api/adapters';

// Unit tests for api/adapters.ts — one per entity, each asserting a raw
// live-shaped input (the same shape captured verbatim in api/fixtures/*.json)
// maps to the UI shape ../types.ts and the rest of the app expect. These run
// as plain Node assertions (no `page` fixture, no browser) via the same
// Playwright test runner the rest of tests/ already uses — no new
// dependency. See fixtures/README.md for how each raw shape was verified
// against a live call.

test.describe('adapters', () => {
  test('toNode — workspace_get_node(s)', () => {
    const raw: RawWorkflowNode = {
      id: 'draft_writer',
      name: 'Full Draft Writer',
      kind: 'agent',
      description: 'Writes the full draft.',
      prompt: 'Objective: write the draft.',
      allowedTools: ['object_get', 'object_patch'],
      assignedSkills: ['editorial_craft'],
      requiredInputs: ['brief.v1'],
      produces: ['draft.v1'],
      riskLevel: 'write',
      dependsOn: ['brief_architect', 'contract_intelligence'],
      status: 'active',
      updatedAt: '2026-08-10T12:00:00.000Z',
      modelConfig: { maxTurns: 6, toolCallLimit: 4, timeout: 90000, budgetUsd: 0.5, maxOutputTokens: 4000 },
    };
    const node = toNode(raw);
    expect(node.id).toBe('draft_writer');
    expect(node.risk).toBe('write'); // riskLevel -> risk
    expect(node.tools).toEqual(['object_get', 'object_patch']); // allowedTools -> tools
    expect(node.skills).toEqual(['editorial_craft']); // assignedSkills -> skills
    expect(node.desc).toBe('Writes the full draft.'); // description -> desc
    expect(node.fan).toBe(2); // dependsOn.length -> fan
    expect(node.model?.timeout).toBe('90s'); // ms -> "Ns"
    expect(node.model?.retryCount).toBe(0); // live never carries one -> default
    expect(node.produces).toEqual(['draft.v1']);
    expect(node.status).toBe('active');
  });

  test('toRun — workflow_list_runs / workflow_get_run, composed with workflow_get_run_cost', () => {
    const raw: RawRun = {
      runId: 'run_test_1',
      requestId: 'req_test_1',
      workflowId: 'publishing_conductor',
      projectId: 'dr-lurie',
      status: 'blocked',
      currentNodeId: 'publish_executor',
      startedAt: '2026-08-23T13:33:30.815Z',
      updatedAt: '2026-08-23T16:26:24.573Z',
      nodes: [
        { nodeId: 'input_triage', status: 'completed' },
        { nodeId: 'publish_executor', status: 'blocked' },
      ],
      errors: [],
      dryRun: true,
      executionMode: 'openai',
    };
    const cost: RawRunCostLedger = { runId: 'run_test_1', totalCostUsdEstimate: 7.57, budget: { budgetUsd: 10 } };
    const run = toRun(raw, cost);
    expect(run.id).toBe('run_test_1'); // runId -> id
    expect(run.wf).toBe('publishing_conductor'); // workflowId -> wf
    expect(run.proj).toBe('dr-lurie'); // projectId -> proj
    expect(run.cur).toBe('publish_executor'); // currentNodeId -> cur
    expect(run.cost).toBe(7.57); // from the cost ledger, not the run row
    expect(run.budget).toBe(10);
    expect(run.done).toBe(1); // nodes with status:'completed'
    expect(run.err).toBe(0); // errors.length
    expect(run.dry).toBe(true);
    expect(run.exec).toBe('openai');
    expect(run.requestId).toBe('req_test_1');

    // No cost ledger supplied (e.g. the lookup failed) -> the type's own
    // "nothing spent" default, never a fabricated figure.
    const runNoCost = toRun(raw);
    expect(runNoCost.cost).toBe(0);
    expect(runNoCost.budget).toBeNull();

    // workflow_get_run's single-run object carries no currentNodeId at all
    // -> falls back to the first node not completed/skipped.
    const rawNoCurrent: RawRun = { ...raw, currentNodeId: undefined };
    expect(toRun(rawNoCurrent).cur).toBe('publish_executor');
  });

  test('toProject — project_list', () => {
    const raw: RawProject = {
      projectId: 'monetizer',
      name: 'Monetizer',
      toolPolicies: { a: 'allowed', b: 'allowed', c: 'needs_approval', d: 'blocked' },
      connection: { endpointConfigured: false, tokenConfigured: false },
    };
    const p = toProject(raw);
    expect(p.id).toBe('monetizer'); // projectId -> id
    expect(p.ok).toBe(false); // endpoint/token not both configured
    expect(p.pol).toEqual({ a: 2, n: 1, b: 1 }); // tallied from toolPolicies' values

    const configured = toProject({ ...raw, connection: { endpointConfigured: true, tokenConfigured: true } });
    expect(configured.ok).toBe(true);
  });

  test('toToolDef — tool_list', () => {
    const raw: RawToolDef = {
      toolId: 'workspace.get_node',
      name: 'workspace.get_node',
      description: 'Get one workspace node.',
      riskLevel: 'read',
      sideEffect: 'none',
      requiresApproval: false,
      category: 'workspace',
      enabled: true,
    };
    const t = toToolDef(raw);
    expect(t.id).toBe('workspace.get_node'); // toolId -> id
    expect(t.desc).toBe('Get one workspace node.'); // description -> desc
    expect(t.risk).toBe('read'); // riskLevel -> risk
    expect(t.category).toBe('workspace');
  });

  test('toSkill + assignedSkillsByNode — skill_list composed with node assignments', () => {
    const raw: RawSkill = { skillId: 'editorial_craft', version: '3', name: 'Editorial craft', status: 'active' };
    const nodes = [
      { id: 'draft_writer', skills: ['editorial_craft'] },
      { id: 'human_texture', skills: ['editorial_craft'] },
      { id: 'input_triage', skills: [] },
    ];
    const assigned = assignedSkillsByNode(nodes);
    const s = toSkill(raw, assigned.get('editorial_craft') ?? []);
    expect(s.id).toBe('editorial_craft'); // skillId -> id
    expect(s.assignedTo).toEqual(['draft_writer', 'human_texture']); // derived, not a live field
    expect(s.version).toBe('3');

    // Unassigned skill -> empty array, not omitted (so "unused" reads correctly).
    const unused = toSkill({ skillId: 'unused_skill', version: '1' }, assigned.get('unused_skill') ?? []);
    expect(unused.assignedTo).toEqual([]);
  });

  test('toObservation — learning_list_observations', () => {
    const raw: RawObservation = {
      id: 'learning_1',
      observation: 'The finding.',
      nodeId: 'draft_writer',
      runId: null,
      createdAt: '2026-07-22T12:37:23.029Z',
    };
    const o = toObservation(raw);
    expect(o.id).toBe('learning_1');
    expect(o.txt).toBe('The finding.'); // observation -> txt
    expect(o.node).toBe('draft_writer'); // nodeId -> node
    expect(o.run).toBeNull();
    expect(o.when).toBe('22 Jul'); // createdAt -> short date
  });

  test('toRubric — evaluation_list_rubrics composed with evaluation_list_regression_reports', () => {
    const raw: RawRubric = {
      nodeId: 'contract_intelligence',
      criteria: [
        { id: 'a', name: 'Contract fidelity', weight: 3 },
        { id: 'b', name: 'No invented rules', weight: 2 },
      ],
    };
    const report: RawRegressionReport = { nodeId: 'contract_intelligence', verdict: 'held', summary: { meanScore: 0.484 } };
    const r = toRubric(raw, report);
    expect(r.node).toBe('contract_intelligence'); // nodeId -> node
    expect(r.crit).toBe(2); // criteria.length -> crit
    expect(r.top).toBe('Contract fidelity'); // highest-weight criterion's name
    expect(r.score).toBe(0.484); // report.summary.meanScore -> score
    expect(r.verdict).toBe('held');

    // No report yet for this node -> null score/verdict, not a guess.
    const noReport = toRubric(raw);
    expect(noReport.score).toBeNull();
    expect(noReport.verdict).toBeNull();
  });

  test('toDataset — dataset_list', () => {
    const raw: RawDataset = {
      datasetId: 'ds_1',
      nodeId: 'contract_intelligence',
      name: 'contract_intelligence frozen replay',
      cases: [{ caseId: 'c1' }, { caseId: 'c2' }, { caseId: 'c3' }],
      createdAt: '2026-08-10T17:31:05.058Z',
    };
    const d = toDataset(raw);
    expect(d.id).toBe('ds_1'); // datasetId -> id
    expect(d.node).toBe('contract_intelligence'); // nodeId -> node
    expect(d.cases).toBe(3); // cases.length, not the raw case objects
    expect(d.note).toBe('contract_intelligence frozen replay'); // name -> note
  });

  test('toAgent — agent_list', () => {
    const raw: RawAgent = {
      id: 'agent_1',
      name: 'CMS Agent',
      role: 'publishing operator',
      modelConfig: { model: 'gpt-5' },
      promptState: 'live',
      skills: ['editorial_craft'],
      rev: 3,
      status: 'active',
    };
    const a = toAgent(raw);
    expect(a.model).toBe('gpt-5'); // modelConfig.model -> model
    expect(a.rev).toBe(3);
    expect(a.status).toBe('active');

    const noModel = toAgent({ ...raw, modelConfig: undefined });
    expect(noModel.model).toBe(''); // never a fabricated model name
  });

  test('toUsageSummary — usage_get_summary composed per-workflow', () => {
    const overall = { totalCostUsdEstimate: 71.2 };
    const perWorkflow = [
      { workflowId: 'publishing_conductor', summary: { totalCostUsdEstimate: 61.0 }, runCount: 31 },
      { workflowId: 'clone_conductor', summary: { totalCostUsdEstimate: 0.92 }, runCount: 6 },
    ];
    const u = toUsageSummary(overall, perWorkflow);
    expect(u.weekTotal).toBe(71.2); // actually all-time — see the adapter's own doc comment
    expect(u.runCount).toBe(37); // summed from every workflow's runCount
    expect(u.byWorkflow).toEqual([
      { wf: 'publishing_conductor', total: 61.0, avgPerRun: 61.0 / 31 },
      { wf: 'clone_conductor', total: 0.92, avgPerRun: 0.92 / 6 },
    ]);
  });

  test('toFinetuneReadiness — dataset_finetune_readiness', () => {
    const raw: RawFinetuneReadiness = {
      nodeId: 'contract_intelligence',
      approvedExamples: 1,
      preferencePairs: 0,
      thresholds: { minExamples: 500, minPreferencePairs: 200 },
      recommendation: 'accumulate',
      reason: 'Accumulating: 1/500 approved examples.',
    };
    const f = toFinetuneReadiness(raw);
    expect(f.approvedExamples).toBe(1);
    expect(f.approvedThreshold).toBe(500); // thresholds.minExamples -> approvedThreshold
    expect(f.pairThreshold).toBe(200);
    expect(f.recommendation).toBe('Accumulating: 1/500 approved examples.'); // reason, not the bare enum

    const noReason = toFinetuneReadiness({ ...raw, reason: undefined });
    expect(noReason.recommendation).toBe('accumulate'); // falls back to the bare enum
  });

  test('shared helpers — shortDate / durationText', () => {
    expect(shortDate('2026-08-23T13:33:30.815Z')).toBe('23 Aug');
    expect(shortDate(null)).toBe('—');
    expect(durationText('2026-08-23T13:00:00.000Z', '2026-08-23T13:00:47.000Z')).toBe('47s');
    expect(durationText('2026-08-23T13:00:00.000Z', '2026-08-23T13:01:32.000Z')).toBe('1m 32s');
    expect(durationText('2026-08-23T13:00:00.000Z', '2026-08-23T15:06:00.000Z')).toBe('2h 6m');
    expect(durationText(null, null)).toBe('—');
  });

  test('toModelConfig — ms timeout becomes "Ns"; live never carries retryCount', () => {
    const m = toModelConfig({ maxTurns: 3, toolCallLimit: 2, timeout: 90000, budgetUsd: 0.1, maxOutputTokens: 2000 });
    expect(m.timeout).toBe('90s');
    expect(m.retryCount).toBe(0);
  });
});
