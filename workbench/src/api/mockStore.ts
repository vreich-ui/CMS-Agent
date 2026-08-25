// In-memory mutable layer over the raw-fixture set (workbench-verb-fixes).
// Loaded once per page load; mutating verbs (in fixture mode, see client.ts)
// act on this copy so later work packages have something honest to
// optimistically update against.
//
// Everything here holds and returns RAW live-shaped data (the same shapes
// api/adapters.ts's `to<Entity>()` functions accept) — never UI-shape
// ../types.ts objects. client.ts's MOCK_HANDLERS wrap these straight into
// the same one-level-deep envelope a live call would (`{ nodes: [...] }`,
// `{ runs: [...], page: {...} }`, …), and verbs.ts runs that through the
// exact adapter the Netlify transport uses. That symmetry — raw fixture in,
// same adapter, same UI shape out — is what makes the fixture-mode
// Playwright suite a real regression net for the live mapping, not a check
// against a parallel fiction. See fixtures/README.md.
//
// Everything here is synchronous — client.ts adds the artificial network
// delay, this module just owns the data.

import nodesJson from './fixtures/nodes.json';
import projectsJson from './fixtures/projects.json';
import runsJson from './fixtures/runs.json';
import runCostsJson from './fixtures/runCosts.json';
import toolsJson from './fixtures/tools.json';
import skillsJson from './fixtures/skills.json';
import observationsJson from './fixtures/observations.json';
import rubricsJson from './fixtures/rubrics.json';
import regressionReportsJson from './fixtures/regressionReports.json';
import datasetsJson from './fixtures/datasets.json';
import comparePairsJson from './fixtures/comparePairs.json';
import usageJson from './fixtures/usage.json';
import readinessJson from './fixtures/readiness.json';
import agentsJson from './fixtures/agents.json';
import { WORKFLOW_CATALOG } from './workflowCatalog';
import type {
  RawAgent,
  RawDataset,
  RawFinetuneReadiness,
  RawObservation,
  RawProject,
  RawRegressionReport,
  RawRubric,
  RawRun,
  RawRunCostLedger,
  RawSkill,
  RawToolDef,
  RawUsageSummary,
  RawWorkflowNode,
} from './adapters';
import type { ComparePair, Run, Workflow } from '../types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface RunFilter {
  workflowId?: string;
  projectId?: string;
  status?: string;
  limit?: number;
}

class MockStore {
  private workflows: Record<string, Workflow>;
  private nodes: RawWorkflowNode[];
  private projects: RawProject[];
  private runs: RawRun[];
  /** runId -> ledger, from fixtures/runCosts.json (a subset — see its own
   *  `_comment`) overlaid with any test-applied override (see updateRun()). */
  private costLedgers: Map<string, RawRunCostLedger>;
  private costOverrides: Map<string, Partial<RawRunCostLedger>>;
  private tools: RawToolDef[];
  private skills: RawSkill[];
  private observations: RawObservation[];
  private rubrics: RawRubric[];
  private regressionReports: RawRegressionReport[];
  private datasets: RawDataset[];
  private comparePairs: ComparePair[];
  private usageOverall: RawUsageSummary;
  private usageByWorkflowId: Record<string, RawUsageSummary>;
  private readiness: RawFinetuneReadiness;
  private agents: RawAgent[];
  /** nodeId -> workflowId, built from each workflow's phases (mockup-config,
   *  not live — see workflowCatalog.ts). Used only to let the mock filter
   *  workspace_get_nodes / dataset stage listings by workflow the same way
   *  verbs.ts does client-side for the live transport. */
  private nodeWorkflow: Map<string, string>;

  constructor() {
    this.workflows = WORKFLOW_CATALOG;
    this.nodes = clone((nodesJson as unknown as { nodes: RawWorkflowNode[] }).nodes);
    this.projects = clone((projectsJson as unknown as { projects: RawProject[] }).projects);
    this.runs = clone((runsJson as unknown as { runs: RawRun[] }).runs);
    this.costLedgers = new Map(
      Object.entries(clone((runCostsJson as unknown as { byRunId: Record<string, RawRunCostLedger> }).byRunId)),
    );
    this.costOverrides = new Map();
    this.tools = clone((toolsJson as unknown as { tools: RawToolDef[] }).tools);
    this.skills = clone((skillsJson as unknown as { skills: RawSkill[] }).skills);
    this.observations = clone((observationsJson as unknown as { observations: RawObservation[] }).observations);
    this.rubrics = clone((rubricsJson as unknown as { rubrics: RawRubric[] }).rubrics);
    this.regressionReports = clone((regressionReportsJson as unknown as { reports: RawRegressionReport[] }).reports);
    this.datasets = clone((datasetsJson as unknown as { datasets: RawDataset[] }).datasets);
    this.comparePairs = clone(comparePairsJson as ComparePair[]);
    const usage = usageJson as { overall: RawUsageSummary; byWorkflowId: Record<string, RawUsageSummary> };
    this.usageOverall = clone(usage.overall);
    this.usageByWorkflowId = clone(usage.byWorkflowId);
    this.readiness = clone((readinessJson as unknown as { readiness: RawFinetuneReadiness }).readiness);
    this.agents = clone((agentsJson as unknown as { agents: RawAgent[] }).agents);

    this.nodeWorkflow = new Map();
    for (const wf of Object.values(this.workflows)) {
      for (const [, ids] of wf.phases) {
        for (const id of ids) this.nodeWorkflow.set(id, wf.id);
      }
    }
  }

  // --- workflow catalog (config, not live — see workflowCatalog.ts) --------

  getWorkflows(): Workflow[] {
    return Object.values(this.workflows);
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows[id];
  }

  getWorkflowIdForNode(nodeId: string): string | undefined {
    return this.nodeWorkflow.get(nodeId);
  }

  // --- workspace / nodes ---------------------------------------------------

  getNodes(workflowId?: string): RawWorkflowNode[] {
    if (!workflowId) return this.nodes;
    return this.nodes.filter((n) => this.nodeWorkflow.get(n.id) === workflowId);
  }

  getNode(nodeId: string): RawWorkflowNode | undefined {
    return this.nodes.find((n) => n.id === nodeId);
  }

  updateNode(nodeId: string, patch: Partial<RawWorkflowNode>): RawWorkflowNode | undefined {
    const idx = this.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) return undefined;
    this.nodes[idx] = { ...this.nodes[idx], ...patch, id: this.nodes[idx].id };
    return this.nodes[idx];
  }

  // --- projects / registry --------------------------------------------------

  getProjects(): RawProject[] {
    return this.projects;
  }

  getProject(id: string): RawProject | undefined {
    return this.projects.find((p) => p.projectId === id);
  }

  getTools(): RawToolDef[] {
    return this.tools;
  }

  getTool(id: string): RawToolDef | undefined {
    return this.tools.find((t) => t.toolId === id);
  }

  getSkills(): RawSkill[] {
    return this.skills;
  }

  getSkill(id: string): RawSkill | undefined {
    return this.skills.find((s) => s.skillId === id);
  }

  updateSkill(id: string, patch: Partial<RawSkill>): RawSkill | undefined {
    const idx = this.skills.findIndex((s) => s.skillId === id);
    if (idx === -1) return undefined;
    this.skills[idx] = { ...this.skills[idx], ...patch, skillId: this.skills[idx].skillId };
    return this.skills[idx];
  }

  assignSkill(nodeId: string, skillId: string): RawSkill | undefined {
    const skill = this.getSkill(skillId);
    if (!skill) return undefined;
    const node = this.getNode(nodeId);
    if (node && !node.assignedSkills.includes(skillId)) {
      this.updateNode(nodeId, { assignedSkills: [...node.assignedSkills, skillId] });
    }
    return skill;
  }

  unassignSkill(nodeId: string, skillId: string): RawSkill | undefined {
    const skill = this.getSkill(skillId);
    if (!skill) return undefined;
    const node = this.getNode(nodeId);
    if (node) {
      this.updateNode(nodeId, { assignedSkills: node.assignedSkills.filter((s) => s !== skillId) });
    }
    return skill;
  }

  /** skillId -> node ids that assign it — the live source for Skill.assignedTo. */
  assignedToFor(skillId: string): string[] {
    return this.nodes.filter((n) => n.assignedSkills.includes(skillId)).map((n) => n.id);
  }

  getAgents(): RawAgent[] {
    return this.agents;
  }

  getAgent(id: string): RawAgent | undefined {
    return this.agents.find((a) => a.id === id);
  }

  // --- runs ------------------------------------------------------------------

  getRuns(filter: RunFilter = {}): RawRun[] {
    let out = this.runs;
    if (filter.workflowId) out = out.filter((r) => r.workflowId === filter.workflowId);
    if (filter.projectId) out = out.filter((r) => r.projectId === filter.projectId);
    if (filter.status) out = out.filter((r) => r.status === filter.status);
    if (filter.limit) out = out.slice(0, filter.limit);
    return out;
  }

  getRun(id: string): RawRun | undefined {
    return this.runs.find((r) => r.runId === id);
  }

  /** Raw-field patch, used by the mutating-verb mock handlers. */
  updateRunRaw(id: string, patch: Partial<RawRun>): RawRun | undefined {
    const idx = this.runs.findIndex((r) => r.runId === id);
    if (idx === -1) return undefined;
    this.runs[idx] = { ...this.runs[idx], ...patch, runId: this.runs[idx].runId };
    return this.runs[idx];
  }

  /**
   * UI-shape (`Partial<Run>`) compat entry point — `runcontrol.spec.ts`
   * calls this directly (`mockStore.updateRun(id, {cost, budget})`) to
   * synthesize an over-budget scenario. `cost`/`budget` have no home on the
   * raw run row itself (see toRun()'s doc comment — they only ever come
   * from a separate cost-ledger lookup), so those two keys go into
   * `costOverrides` instead of the row; every other key here has a direct
   * raw-field equivalent.
   */
  updateRun(id: string, patch: Partial<Run>): RawRun | undefined {
    const rawPatch: Partial<RawRun> = {};
    if (patch.status !== undefined) rawPatch.status = patch.status;
    if (patch.cur !== undefined) rawPatch.currentNodeId = patch.cur;
    if (patch.dry !== undefined) rawPatch.dryRun = patch.dry;
    if (patch.requestId !== undefined) rawPatch.requestId = patch.requestId;
    if (patch.cost !== undefined || patch.budget !== undefined) {
      const existing = this.costOverrides.get(id) ?? {};
      this.costOverrides.set(id, {
        ...existing,
        runId: id,
        totalCostUsdEstimate: patch.cost ?? existing.totalCostUsdEstimate ?? 0,
        budget: patch.budget !== undefined ? { budgetUsd: patch.budget } : existing.budget,
      });
    }
    return Object.keys(rawPatch).length ? this.updateRunRaw(id, rawPatch) : this.getRun(id);
  }

  /** Adds a brand-new run (used by workflow_start_dry_run in mock mode). */
  addRun(run: RawRun): RawRun {
    this.runs = [run, ...this.runs];
    return run;
  }

  getCostLedger(runId: string): RawRunCostLedger | undefined {
    const base = this.costLedgers.get(runId);
    const override = this.costOverrides.get(runId);
    if (!base && !override) return undefined;
    return { runId, totalCostUsdEstimate: 0, ...base, ...override };
  }

  // --- learning / evaluation / datasets --------------------------------------

  getObservations(nodeId?: string): RawObservation[] {
    if (!nodeId) return this.observations;
    return this.observations.filter((o) => o.nodeId === nodeId);
  }

  addObservation(obs: RawObservation): RawObservation {
    this.observations = [obs, ...this.observations];
    return obs;
  }

  archiveObservation(id: string): RawObservation | undefined {
    const obs = this.observations.find((o) => o.id === id);
    if (!obs) return undefined;
    this.observations = this.observations.filter((o) => o.id !== id);
    return obs;
  }

  getRubrics(): RawRubric[] {
    return this.rubrics;
  }

  getRubric(nodeId: string): RawRubric | undefined {
    return this.rubrics.find((r) => r.nodeId === nodeId);
  }

  updateRubric(nodeId: string, patch: Partial<RawRubric>): RawRubric | undefined {
    const idx = this.rubrics.findIndex((r) => r.nodeId === nodeId);
    if (idx === -1) return undefined;
    this.rubrics[idx] = { ...this.rubrics[idx], ...patch, nodeId: this.rubrics[idx].nodeId };
    return this.rubrics[idx];
  }

  getRegressionReports(nodeId?: string): RawRegressionReport[] {
    if (!nodeId) return this.regressionReports;
    return this.regressionReports.filter((r) => r.nodeId === nodeId);
  }

  getDatasets(): RawDataset[] {
    return this.datasets;
  }

  getDataset(id: string): RawDataset | undefined {
    return this.datasets.find((d) => d.datasetId === id);
  }

  addDataset(ds: RawDataset): RawDataset {
    this.datasets = [ds, ...this.datasets];
    return ds;
  }

  getComparePairs(): ComparePair[] {
    return this.comparePairs;
  }

  getUsageOverall(): RawUsageSummary {
    return this.usageOverall;
  }

  getUsageByWorkflow(workflowId: string): RawUsageSummary | undefined {
    return this.usageByWorkflowId[workflowId];
  }

  getReadiness(): RawFinetuneReadiness {
    return this.readiness;
  }

  /** Compare (A/B) verdicts nudge finetune readiness — Phase 5 wires the UI. */
  recordPreferencePair(): RawFinetuneReadiness {
    this.readiness = { ...this.readiness, preferencePairs: this.readiness.preferencePairs + 1 };
    return this.readiness;
  }
}

export const mockStore = new MockStore();
