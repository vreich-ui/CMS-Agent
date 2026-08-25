// In-memory mutable layer over the WP-02 fixtures. Loaded once per page load;
// mutating verbs (in fixture mode, see client.ts) act on this copy so later
// work packages have something honest to optimistically update against.
//
// Everything here is synchronous — client.ts adds the artificial network
// delay, this module just owns the data.

import workflowsJson from './fixtures/workflows.json';
import nodesJson from './fixtures/nodes.json';
import projectsJson from './fixtures/projects.json';
import runsJson from './fixtures/runs.json';
import toolsJson from './fixtures/tools.json';
import skillsJson from './fixtures/skills.json';
import observationsJson from './fixtures/observations.json';
import rubricsJson from './fixtures/rubrics.json';
import datasetsJson from './fixtures/datasets.json';
import comparePairsJson from './fixtures/comparePairs.json';
import usageJson from './fixtures/usage.json';
import readinessJson from './fixtures/readiness.json';
import agentsJson from './fixtures/agents.json';

import type {
  Agent,
  ComparePair,
  Dataset,
  FinetuneReadiness,
  ModelConfig,
  Observation,
  Project,
  Risk,
  Rubric,
  Run,
  RunStatus,
  Skill,
  ToolDef,
  UsageSummary,
  Workflow,
  WorkflowNode,
} from '../types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// The fixture JSON's shape is not quite `WorkflowNode`/`ModelConfig` at the
// type level, in two ways that are real (not just TS tuple-inference noise):
//   1. `model.timeout` is a raw millisecond number live, while ModelConfig
//      (fixed by the mockup's shape — see spec/mockup.html) expects a string
//      like "90s", and live models carry no `retryCount` at all.
//   2. `fit_adjudicator` (the one node absent from `workspace_get_node` live —
//      see fixtures/README.md) has `kind`/`risk`/`fan` all `null`, not the
//      non-null values WorkflowNode requires.
// Both are normalized here at load time rather than by loosening the shared
// type contract.

interface RawModelConfig {
  maxTurns: number;
  toolCallLimit: number;
  timeout: number | string;
  budgetUsd: number;
  maxOutputTokens: number;
  retryCount?: number;
}

interface RawWorkflowNode {
  id: string;
  name: string;
  kind: string | null;
  risk: string | null;
  fan: number | null;
  tools: string[];
  skills: string[];
  desc: string;
  model?: RawModelConfig;
  prompt?: string;
}

function normalizeModel(raw: RawModelConfig | undefined): ModelConfig | undefined {
  if (!raw) return undefined;
  return {
    maxTurns: raw.maxTurns,
    toolCallLimit: raw.toolCallLimit,
    timeout: typeof raw.timeout === 'number' ? `${Math.round(raw.timeout / 1000)}s` : raw.timeout,
    budgetUsd: raw.budgetUsd,
    maxOutputTokens: raw.maxOutputTokens,
    retryCount: raw.retryCount ?? 0,
  };
}

/** `risk: null` (fit_adjudicator only) defaults to the safest value, not the loosest. */
function normalizeNode(raw: RawWorkflowNode): WorkflowNode {
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind ?? 'unknown',
    risk: (raw.risk as Risk | null) ?? 'read',
    fan: raw.fan ?? 0,
    tools: raw.tools,
    skills: raw.skills,
    desc: raw.desc,
    model: normalizeModel(raw.model),
    prompt: raw.prompt,
  };
}

export interface RunFilter {
  workflowId?: string;
  projectId?: string;
  status?: RunStatus;
  limit?: number;
}

class MockStore {
  private workflows: Record<string, Workflow>;
  private nodes: Record<string, WorkflowNode>;
  private projects: Project[];
  private runs: Run[];
  private tools: ToolDef[];
  private skills: Skill[];
  private observations: Observation[];
  private rubrics: Rubric[];
  private datasets: Dataset[];
  private comparePairs: ComparePair[];
  private usage: UsageSummary;
  private readiness: FinetuneReadiness;
  private agents: Agent[];
  /** nodeId -> workflowId, built from each workflow's phases. */
  private nodeWorkflow: Map<string, string>;

  constructor() {
    this.workflows = clone(workflowsJson as unknown as Record<string, Workflow>);
    const rawNodes = nodesJson as unknown as Record<string, RawWorkflowNode>;
    this.nodes = Object.fromEntries(Object.entries(rawNodes).map(([id, n]) => [id, normalizeNode(n)]));
    this.projects = clone(projectsJson as Project[]);
    this.runs = clone(runsJson as Run[]);
    this.tools = clone(toolsJson as ToolDef[]);
    this.skills = clone(skillsJson as Skill[]);
    this.observations = clone(observationsJson as Observation[]);
    this.rubrics = clone(rubricsJson as Rubric[]);
    this.datasets = clone(datasetsJson as Dataset[]);
    this.comparePairs = clone(comparePairsJson as ComparePair[]);
    this.usage = clone(usageJson as UsageSummary);
    this.readiness = clone(readinessJson as FinetuneReadiness);
    this.agents = clone(agentsJson as Agent[]);

    this.nodeWorkflow = new Map();
    for (const wf of Object.values(this.workflows)) {
      for (const [, ids] of wf.phases) {
        for (const id of ids) this.nodeWorkflow.set(id, wf.id);
      }
    }
  }

  // --- workspace / nodes ---------------------------------------------------

  getWorkflows(): Workflow[] {
    return Object.values(this.workflows);
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows[id];
  }

  getWorkflowIdForNode(nodeId: string): string | undefined {
    return this.nodeWorkflow.get(nodeId);
  }

  getNodes(workflowId?: string): WorkflowNode[] {
    const all = Object.values(this.nodes);
    if (!workflowId) return all;
    return all.filter((n) => this.nodeWorkflow.get(n.id) === workflowId);
  }

  getNode(nodeId: string): WorkflowNode | undefined {
    return this.nodes[nodeId];
  }

  updateNode(nodeId: string, patch: Partial<WorkflowNode>): WorkflowNode | undefined {
    const existing = this.nodes[nodeId];
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, id: existing.id };
    this.nodes[nodeId] = updated;
    return updated;
  }

  // --- projects / registry --------------------------------------------------

  getProjects(): Project[] {
    return this.projects;
  }

  getProject(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  getTools(): ToolDef[] {
    return this.tools;
  }

  getTool(id: string): ToolDef | undefined {
    return this.tools.find((t) => t.id === id);
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  updateSkill(id: string, patch: Partial<Skill>): Skill | undefined {
    const idx = this.skills.findIndex((s) => s.id === id);
    if (idx === -1) return undefined;
    this.skills[idx] = { ...this.skills[idx], ...patch, id: this.skills[idx].id };
    return this.skills[idx];
  }

  assignSkill(nodeId: string, skillId: string): Skill | undefined {
    const skill = this.getSkill(skillId);
    if (!skill) return undefined;
    if (!skill.assignedTo.includes(nodeId)) skill.assignedTo = [...skill.assignedTo, nodeId];
    const node = this.getNode(nodeId);
    if (node && !node.skills.includes(skillId)) {
      this.updateNode(nodeId, { skills: [...node.skills, skillId] });
    }
    return skill;
  }

  unassignSkill(nodeId: string, skillId: string): Skill | undefined {
    const skill = this.getSkill(skillId);
    if (!skill) return undefined;
    skill.assignedTo = skill.assignedTo.filter((n) => n !== nodeId);
    const node = this.getNode(nodeId);
    if (node) {
      this.updateNode(nodeId, { skills: node.skills.filter((s) => s !== skillId) });
    }
    return skill;
  }

  getAgents(): Agent[] {
    return this.agents;
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.find((a) => a.id === id);
  }

  // --- runs ------------------------------------------------------------------

  getRuns(filter: RunFilter = {}): Run[] {
    let out = this.runs;
    if (filter.workflowId) out = out.filter((r) => r.wf === filter.workflowId);
    if (filter.projectId) out = out.filter((r) => r.proj === filter.projectId);
    if (filter.status) out = out.filter((r) => r.status === filter.status);
    if (filter.limit) out = out.slice(0, filter.limit);
    return out;
  }

  getRun(id: string): Run | undefined {
    return this.runs.find((r) => r.id === id);
  }

  updateRun(id: string, patch: Partial<Run>): Run | undefined {
    const idx = this.runs.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    this.runs[idx] = { ...this.runs[idx], ...patch, id: this.runs[idx].id };
    return this.runs[idx];
  }

  /** Adds a brand-new run (used by workflow_start_dry_run in mock mode). */
  addRun(run: Run): Run {
    this.runs = [run, ...this.runs];
    return run;
  }

  // --- learning / evaluation / datasets --------------------------------------

  getObservations(nodeId?: string): Observation[] {
    if (!nodeId) return this.observations;
    return this.observations.filter((o) => o.node === nodeId);
  }

  addObservation(obs: Observation): Observation {
    this.observations = [obs, ...this.observations];
    return obs;
  }

  archiveObservation(id: string): Observation | undefined {
    const obs = this.observations.find((o) => o.id === id);
    if (!obs) return undefined;
    this.observations = this.observations.filter((o) => o.id !== id);
    return obs;
  }

  getRubrics(): Rubric[] {
    return this.rubrics;
  }

  getRubric(nodeId: string): Rubric | undefined {
    return this.rubrics.find((r) => r.node === nodeId);
  }

  updateRubric(nodeId: string, patch: Partial<Rubric>): Rubric | undefined {
    const idx = this.rubrics.findIndex((r) => r.node === nodeId);
    if (idx === -1) return undefined;
    this.rubrics[idx] = { ...this.rubrics[idx], ...patch, node: this.rubrics[idx].node };
    return this.rubrics[idx];
  }

  getDatasets(): Dataset[] {
    return this.datasets;
  }

  getDataset(id: string): Dataset | undefined {
    return this.datasets.find((d) => d.id === id);
  }

  addDataset(ds: Dataset): Dataset {
    this.datasets = [ds, ...this.datasets];
    return ds;
  }

  getComparePairs(): ComparePair[] {
    return this.comparePairs;
  }

  getUsage(): UsageSummary {
    return this.usage;
  }

  getReadiness(): FinetuneReadiness {
    return this.readiness;
  }

  /** Compare (A/B) verdicts nudge finetune readiness — Phase 5 wires the UI. */
  recordPreferencePair(): FinetuneReadiness {
    this.readiness = { ...this.readiness, preferencePairs: this.readiness.preferencePairs + 1 };
    return this.readiness;
  }
}

export const mockStore = new MockStore();
