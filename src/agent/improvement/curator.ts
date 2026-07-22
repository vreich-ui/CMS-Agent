// LLM-driven playbook curation (docs/platform/DIRECTION.md Phase 7). The ACE playbook (playbook.ts) is
// updated by small deltas; deriving those deltas from evidence is the Curator's job. Historically
// playbook.curate was HEURISTIC (worst rubric criterion → one pitfall lesson). This adds a Reflector→
// Curator LLM pass (mode "openai") that reads the node's evaluation evidence and current playbook and
// proposes a richer delta — adds (strategy/pitfall/constraint) plus retirements of stale/harmful items
// — while keeping the deterministic heuristic as the default "mock" mode (no model spend, used by tests
// and dry runs). Both paths funnel through applyPlaybookDelta, so dedup, counters, and the item/char
// budget are enforced identically.
import { getNodeRunner } from "../execution/runnerRegistry.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
import { analyzeNode, type OptimizerDeps, type NodeAnalysis } from "./optimizer.js";
import { applyPlaybookDelta, renderPlaybookForPrompt } from "./playbook.js";
import { makeImprovementId, type NodePlaybook, type PlaybookDelta, type PlaybookItemKind } from "./improvementTypes.js";

const now = () => new Date().toISOString();
const PLAYBOOK_ITEM_KINDS: PlaybookItemKind[] = ["strategy", "pitfall", "constraint"];

// Deterministic heuristic (the original playbook.curate behavior): the weakest rubric criterion becomes
// a pitfall lesson. Returns null when there is no criterion-level evidence yet.
export function heuristicCurationDelta(analysis: NodeAnalysis): PlaybookDelta | null {
  const worst = analysis.worstCriteria[0];
  if (!worst) return null;
  return { add: [{ text: `Recent evaluations score weakest on "${worst.criterionId}" (mean ${worst.meanScore}/${worst.maxScore}); address it explicitly before completing.`, kind: "pitfall", provenance: { source: "reflector", evalIds: analysis.evidence.evalIds.slice(0, 5) } }] };
}

type CuratorOutput = { add?: Array<{ text?: unknown; kind?: unknown }>; retire?: unknown[]; rationale?: unknown };

// Map a Curator LLM output to a validated PlaybookDelta: only well-formed adds (non-empty text, known
// kind) and string retire ids survive, and every add carries reflector provenance with the cited evals.
// Pure — unit-tested without a model.
export function curatorDeltaFromOutput(output: CuratorOutput, evalIds: string[]): PlaybookDelta {
  const add = (Array.isArray(output.add) ? output.add : [])
    .map((item) => ({ text: typeof item?.text === "string" ? item.text.trim() : "", kind: item?.kind }))
    .filter((item): item is { text: string; kind: PlaybookItemKind } => item.text.length > 0 && PLAYBOOK_ITEM_KINDS.includes(item.kind as PlaybookItemKind))
    .map((item) => ({ text: item.text, kind: item.kind, provenance: { source: "reflector" as const, evalIds: evalIds.slice(0, 5) } }));
  const retire = (Array.isArray(output.retire) ? output.retire : []).filter((id): id is string => typeof id === "string" && id.length > 0);
  const delta: PlaybookDelta = {};
  if (add.length) delta.add = add;
  if (retire.length) delta.retire = retire;
  return delta;
}

const curatorOutputSchema = {
  type: "object",
  required: ["add"],
  additionalProperties: false,
  properties: {
    add: { type: "array", items: { type: "object", required: ["text", "kind"], additionalProperties: false, properties: { text: { type: "string" }, kind: { type: "string", enum: PLAYBOOK_ITEM_KINDS } } } },
    retire: { type: "array", items: { type: "string" } },
    rationale: { type: "string" }
  }
};

const syntheticCuratorNode = (prompt: string): WorkspaceNode => ({
  id: "improvement_curator", name: "Playbook curator", kind: "improvement",
  description: "Synthetic ACE curator node; never persisted in the workspace graph.",
  prompt, schema: curatorOutputSchema as Record<string, unknown>, inputSchema: { type: "object", additionalProperties: true }, outputSchema: curatorOutputSchema as Record<string, unknown>,
  allowedTools: [], requiredInputs: [], produces: ["playbook_delta.v1"], riskLevel: "read", dependsOn: [], status: "active",
  position: { x: 0, y: 0 }, updatedAt: now(), assignedSkills: [],
  modelConfig: { model: process.env.IMPROVEMENT_CURATOR_MODEL ?? process.env.IMPROVEMENT_REFLECTOR_MODEL ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5" },
  metadata: { synthetic: true }
} as unknown as WorkspaceNode);

// Run the Curator LLM over the analysis + current playbook and return a validated PlaybookDelta.
async function llmCurationDelta(analysis: NodeAnalysis, existing: NodePlaybook | undefined, deps: OptimizerDeps): Promise<PlaybookDelta> {
  const timestamp = now();
  const run: WorkflowExecutionRecord = { runId: makeImprovementId("curate"), workflowId: "improvement_curator", projectId: "workspace", status: "running", startedAt: timestamp, updatedAt: timestamp, nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai" } as WorkflowExecutionRecord;
  const prompt = [
    "You are a Curator maintaining an ACE playbook (curated, budgeted bullet lessons) for one agent node.",
    "Given the node's evaluation evidence and its current playbook, propose a DELTA:",
    "- add concise, actionable, NON-duplicate lessons, each tagged strategy | pitfall | constraint;",
    "- retire (by itemId) any current lesson that is stale, redundant, or contradicted by the evidence.",
    "Prefer a few high-signal lessons over many. Return only JSON matching the schema."
  ].join("\n");
  const currentItems = (existing?.items ?? []).filter((item) => item.status === "active").map((item) => ({ itemId: item.itemId, text: item.text, kind: item.kind, helpfulCount: item.helpfulCount, harmfulCount: item.harmfulCount }));
  const result = await getNodeRunner("openai").run(
    { node: syntheticCuratorNode(prompt), input: { input: { analysis, currentPlaybook: { rendered: existing ? renderPlaybookForPrompt(existing) : "", items: currentItems } } } },
    { run, executionRepository: deps.executionRepository }
  );
  if (!result.ok) throw new Error(`curation_failed: ${result.code}: ${result.message}`);
  return curatorDeltaFromOutput(result.output as CuratorOutput, analysis.evidence.evalIds);
}

export type CurationResult = { playbook: NodePlaybook | null; curated: boolean; mode: "mock" | "openai"; reason?: string; delta?: PlaybookDelta };

// Curate a node's playbook from its evaluation evidence. mock = deterministic heuristic (default,
// no model); openai = Reflector→Curator LLM pass. Applies the derived delta through applyPlaybookDelta
// (dedup + budget enforced) and persists it. A no-evidence node (or an empty LLM delta) is a no-op.
export async function curatePlaybook(params: { nodeId: string; mode: "mock" | "openai" }, deps: OptimizerDeps): Promise<CurationResult> {
  const analysis = await analyzeNode({ nodeId: params.nodeId }, deps);
  const existing = await deps.improvementRepository.getPlaybook(params.nodeId);
  const delta = params.mode === "openai" ? await llmCurationDelta(analysis, existing, deps) : heuristicCurationDelta(analysis);
  if (!delta || (!delta.add?.length && !delta.retire?.length && !delta.markHelpful?.length && !delta.markHarmful?.length)) {
    return { playbook: existing ?? null, curated: false, mode: params.mode, reason: params.mode === "openai" ? "Curator proposed no actionable delta." : "No criterion-level evaluation evidence yet." };
  }
  const playbook = await deps.improvementRepository.savePlaybook(applyPlaybookDelta(existing, params.nodeId, delta, now()));
  return { playbook, curated: true, mode: params.mode, delta };
}
