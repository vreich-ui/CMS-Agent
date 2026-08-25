// Shared contract for the Conductor Workbench. Every work package depends on
// these names — do not rename without coordinating across all WPs.

export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'skipped';

export type Risk = 'read' | 'write' | 'publish';

export type ScreenId = 'library' | 'bench' | 'runs' | 'learning' | 'registry';

export type BenchMode = 'build' | 'run';

export type NodeTab =
  | 'thisrun'
  | 'prompt'
  | 'tools'
  | 'skills'
  | 'schemas'
  | 'model'
  | 'deps'
  | 'history'
  | 'learn';

export type RunTab = 'live' | 'history' | 'grid';

export type RegTab = 'projects' | 'keys' | 'tools' | 'skills' | 'agents' | 'usage';

export type LearnTab = 'fly' | 'obs' | 'pb' | 'cmp' | 'eval' | 'opt' | 'ds';

export type ThemePref = 'auto' | 'light' | 'dark';

export interface Workflow {
  id: string;
  name: string;
  fn: string;
  icon: string;
  short: string;
  desc: string;
  phases: Array<[string, string[]]>;
  planned?: boolean;
}

export interface ModelConfig {
  maxTurns: number;
  toolCallLimit: number;
  timeout: string;
  budgetUsd: number;
  maxOutputTokens: number;
  retryCount: number;
}

export interface WorkflowNode {
  id: string;
  name: string;
  kind: string;
  risk: Risk;
  fan: number;
  tools: string[];
  skills: string[];
  desc: string;
  model?: ModelConfig;
  prompt?: string;
}

export interface ToolPolicyCounts {
  a: number;
  n: number;
  b: number;
}

export interface Project {
  id: string;
  name: string;
  ok: boolean;
  disabled?: boolean;
  pol: ToolPolicyCounts;
  endpoint?: string | null;
  endpointEnvVar?: string;
  tokenEnvVar?: string;
  tokenSource?: string;
  endpointSource?: string;
}

export interface Run {
  id: string;
  wf: string;
  proj: string;
  status: RunStatus;
  cur: string | null;
  started: string;
  dur: string;
  cost: number;
  budget: number | null;
  exec: 'openai' | 'mock';
  dry: boolean;
  err: number;
  done: number;
  stall?: boolean;
}

export interface ToolDef {
  id: string;
  risk: Risk;
  sideEffect: string;
  desc: string;
}

export interface Observation {
  id: string;
  when: string;
  node: string | null;
  run: string | null;
  txt: string;
}

export interface Rubric {
  node: string;
  crit: number;
  top: string;
  score: number | null;
  verdict: string | null;
}

export interface Dataset {
  id: string;
  node: string;
  cases: number;
  when: string;
  note: string;
}

export interface ComparePair {
  kind: 'text' | 'template' | 'image';
  node: string;
  brief: string;
  champ: 'A' | 'B';
  a: string;
  b: string;
}

// --- Added by WP-03 (data layer). Shapes below mirror the fixtures captured
// in api/fixtures/*.json — see fixtures/README.md for live-vs-mockup provenance.

export interface Skill {
  id: string;
  version: string;
  assignedTo: string[];
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  model: string;
  promptState: string;
  skills: string[];
  rev: number;
}

export interface WorkflowUsage {
  wf: string;
  total: number;
  avgPerRun: number;
}

export interface UsageSummary {
  weekTotal: number;
  runCount: number;
  byWorkflow: WorkflowUsage[];
}

export interface FinetuneReadiness {
  approvedExamples: number;
  approvedThreshold: number;
  preferencePairs: number;
  pairThreshold: number;
  recommendation: string;
}

// --- Added by WP-23 (gate panel) for the readiness-evidence viewer. Not a
// fixture in api/fixtures/*.json — see api/client.ts's workflow_publish_readiness
// mock handler for how each check is derived from the run record actually
// captured there (error count, progress, budget), which is the only data
// this fixture set carries. `pass: null` marks a check the live verb would
// answer but this fixture-derived approximation cannot (HANDOFF §7.9/§7.10 —
// never fabricate a pass).

export interface PublishReadinessCheck {
  id: string;
  label: string;
  pass: boolean | null;
  detail: string;
}

export interface PublishReadiness {
  runId: string;
  nodeId: string | null;
  checks: PublishReadinessCheck[];
  overallGo: boolean;
  /** Always 'derived' in fixture mode — see the doc comment above. */
  source: 'derived';
}
