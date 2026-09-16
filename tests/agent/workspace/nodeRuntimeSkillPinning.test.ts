// C2/C3 gap close (nodeRuntime.ts) — node.execute (executeNode) is, for #369's five specialist
// nodes, the ONLY dispatch path (their conductor route does not exist yet). Before this, it always
// resolved a node's LIVE assignedSkills, never a run's pinned selection — the same gap the
// workflow dispatch path (executor.ts) closed for the conductor path in #358/#361. These tests
// exercise executeNode/prepareNodeExecution directly, the way node.execute/node.prepare_execution
// call them, rather than the lower-level pinSkillSelection unit already covered by
// tests/agent/skills/runSkillSelection.test.ts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { executeNode, prepareNodeExecution } from "../../../src/agent/workspace/nodeRuntime.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import { RUN_SKILL_SELECTION_CONTRACT, type RunSkillSelection } from "../../../src/agent/skills/runSkillSelection.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

const NODE_ID = "pin_probe";
const CRAFT = "pin_probe_craft";
const SEO = "pin_probe_seo";
// Scoped to a real, named tenant this test never claims to be dispatching for — must never reach
// a dispatch that cannot say which tenant it is on.
const SITE_SCOPED = "pin_probe_site_scoped";
// Scoped to "workspace" — the EXACT literal nodeRuntime.ts's synthetic run uses as `projectId`
// (see nodeRuntime.ts's visual_standard_materializer guard). This exists to catch the specific
// mistake of treating that placeholder as a real site: if executeNode ever built its scope context
// with `runScopeContext(run, node.id)` instead of the honest `{ task: node.id }`, this skill would
// wrongly survive because the placeholder would "match" its own scope.
const WORKSPACE_PLACEHOLDER_SCOPED = "pin_probe_workspace_scoped";
// Scoped to this exact node — the one dimension (`task`) that IS honestly known on this path, so
// this must survive narrowing (proves the fix isn't dropping everything out of over-caution).
const TASK_SCOPED = "pin_probe_task_scoped";

const BASE_NODE: WorkspaceNode = {
  id: NODE_ID, name: "Pin Probe", kind: "test", description: "unit-test-only node",
  prompt: "probe", inputSchema: {}, requiredInputs: [], allowedTools: [], produces: ["probe.v1"],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 }, updatedAt: "2026-01-01T00:00:00.000Z",
  outputSchema: { type: "object" }, modelConfig: {}
} as unknown as WorkspaceNode;

const createNode = (assignedSkills: string[]) =>
  repositoryManager.getWorkspaceRepository().createNode({ ...BASE_NODE, assignedSkills } as WorkspaceNode, { actor: "test" });

const seedSelection = (over: Partial<RunSkillSelection> = {}): RunSkillSelection => ({
  contract: RUN_SKILL_SELECTION_CONTRACT,
  skillIds: [],
  versions: {},
  selectedAt: "2026-01-01T00:00:00.000Z",
  source: "node_assignment",
  ...over
});

const seedRun = (runId: string, skillSelection: Record<string, RunSkillSelection>) =>
  repositoryManager.getExecutionRepository().createRun({
    runId, workflowId: "independent_node", projectId: "workspace", status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true,
    executionMode: "mock", skillSelection
  } as unknown as WorkflowExecutionRecord);

const executePinProbe = async (over: { runId?: string } = {}) =>
  executeNode({ nodeId: NODE_ID, input: {}, executionMode: "mock", ...over }) as Promise<{ execution: WorkflowExecutionRecord }>;

const makeSkill = (skillId: string, patch: Partial<import("../../../src/agent/skills/skillTypes.js").SkillDefinition> = {}) => ({
  skillId, name: skillId, description: "unit-test-only skill", version: "1.0.0", status: "active" as const,
  instructions: `${skillId} instructions`, inputSchema: { type: "object" }, outputSchema: { type: "object" },
  allowedTools: [], requiredArtifacts: [], producedArtifacts: [], examples: [{ name: "basic", input: {}, output: {} }], preconditions: [],
  completionCriteria: [], blockerCriteria: [], memoryPolicy: { namespaces: [], read: false, write: false },
  toolPolicy: { requestedTools: [], mutatingToolsRequireApproval: false }, riskLevel: "read" as const,
  metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...patch
});

// MemorySkillRepository keeps its document in a MODULE-STATIC map keyed by backend (see
// skillRegistry.ts), unlike the workspace/execution repositories' per-instance state — so it
// survives resetRepositoryManager() within this file and only needs seeding once, additively.
const ensureSkill = async (skillId: string, patch: Partial<import("../../../src/agent/skills/skillTypes.js").SkillDefinition> = {}) => {
  const skills = repositoryManager.getSkillRepository();
  if (await skills.get(skillId)) return;
  await skills.create(makeSkill(skillId, patch));
};

describe("executeNode — closes the node_execute skill-resolution gap", () => {
  beforeAll(async () => {
    await ensureSkill(CRAFT);
    await ensureSkill(SEO);
    await ensureSkill(SITE_SCOPED, { scope: { site: "some-real-tenant" } });
    await ensureSkill(WORKSPACE_PLACEHOLDER_SCOPED, { scope: { site: "workspace" } });
    await ensureSkill(TASK_SCOPED, { scope: { task: NODE_ID } });
  });

  beforeEach(() => {
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
  });

  it("resolves a run's already-pinned selection, not the node's live assignment", async () => {
    await createNode([CRAFT, SEO]);
    await seedRun("run_preexisting_pin", { [NODE_ID]: seedSelection({ skillIds: [CRAFT] }) });

    const result = await executePinProbe({ runId: "run_preexisting_pin" });
    expect(result.execution.skillSelection?.[NODE_ID]?.skillIds).toEqual([CRAFT]);
  });

  it("a live assignment change after the pin does not change what a later dispatch under the same runId resolves", async () => {
    await createNode([CRAFT]);
    const first = await executePinProbe({ runId: "run_stable_pin" });
    expect(first.execution.skillSelection?.[NODE_ID]?.skillIds).toEqual([CRAFT]);

    await repositoryManager.getWorkspaceRepository().updateNode(NODE_ID, { assignedSkills: [SEO] }, { actor: "test" });

    const second = await executePinProbe({ runId: "run_stable_pin" });
    expect(second.execution.skillSelection?.[NODE_ID]?.skillIds).toEqual([CRAFT]);
  });

  it("an empty pinned selection resolves to no skills, not the live assignment", async () => {
    await createNode([CRAFT, SEO]);
    await seedRun("run_empty_pin", { [NODE_ID]: seedSelection({ skillIds: [] }) });

    const result = await executePinProbe({ runId: "run_empty_pin" });
    expect(result.execution.skillSelection?.[NODE_ID]?.skillIds).toEqual([]);
  });

  it("never resolves a skill absent from assignedSkills, even one that exists in the skill repository", async () => {
    await createNode([CRAFT]);
    const result = await executePinProbe();
    const pinned = result.execution.skillSelection?.[NODE_ID];
    expect(pinned?.skillIds).toEqual([CRAFT]);
    expect(pinned?.skillIds).not.toContain(SEO);
  });

  it("degrades honestly: a skill scoped to a real, different tenant never reaches a dispatch that cannot name its tenant", async () => {
    await createNode([CRAFT, SITE_SCOPED]);
    const result = await executePinProbe();
    const pinned = result.execution.skillSelection?.[NODE_ID];
    expect(pinned?.skillIds).toEqual([CRAFT]);
    expect(pinned?.dropped).toContainEqual(expect.objectContaining({ skillId: SITE_SCOPED, reason: "out_of_scope" }));
  });

  it("never invents a site from the synthetic run's 'workspace' placeholder projectId", async () => {
    // If nodeRuntime.ts ever went back to `runScopeContext(run, node.id)` (which reads `site` off
    // `run.projectId`) instead of the honest `{ task: node.id }`, this skill — scoped to the exact
    // string that placeholder run carries — would wrongly survive, because "workspace" would
    // appear to match its own scope. It must not.
    await createNode([CRAFT, WORKSPACE_PLACEHOLDER_SCOPED]);
    const result = await executePinProbe();
    const pinned = result.execution.skillSelection?.[NODE_ID];
    expect(pinned?.skillIds).toEqual([CRAFT]);
    expect(pinned?.dropped).toContainEqual(expect.objectContaining({ skillId: WORKSPACE_PLACEHOLDER_SCOPED, reason: "out_of_scope" }));
  });

  it("a skill scoped to this node's own task id still applies — the fix narrows, it does not blank everything out", async () => {
    await createNode([CRAFT, TASK_SCOPED]);
    const result = await executePinProbe();
    const pinned = result.execution.skillSelection?.[NODE_ID];
    expect(pinned?.skillIds?.sort()).toEqual([CRAFT, TASK_SCOPED].sort());
  });

  it("prepareNodeExecution narrows by scope but never pins", async () => {
    await createNode([CRAFT, SITE_SCOPED, WORKSPACE_PLACEHOLDER_SCOPED, TASK_SCOPED]);

    // NARROWS: site-scoped members are dropped, the same way an actual dispatch drops them — a
    // preview that still showed all four would disagree with what executeNode resolves for this
    // exact assignment (see the "preview and dispatch agree" test below). This is what would fail
    // if the scope narrowing above were removed.
    const first = await prepareNodeExecution({ nodeId: NODE_ID, input: {} }) as { resolvedSkills: { skillIds: string[] } };
    expect(first.resolvedSkills.skillIds.sort()).toEqual([CRAFT, TASK_SCOPED].sort());

    // NEVER PINS: prepareNodeExecution has no run and no write path (its default `repos` carries
    // no executionRepository at all — see its signature), so nothing here may behave as though a
    // first call claimed an answer for later ones. Reassigning the node and calling again must
    // show the NEW narrowed set, not a memoized/pinned old one — this is what would fail if
    // prepareNodeExecution started behaving as if it pinned (e.g. caching scopeNarrowedSkillIds's
    // result across calls instead of recomputing it from the current assignment).
    await repositoryManager.getWorkspaceRepository().updateNode(NODE_ID, { assignedSkills: [SEO] }, { actor: "test" });
    const second = await prepareNodeExecution({ nodeId: NODE_ID, input: {} }) as { resolvedSkills: { skillIds: string[] } };
    expect(second.resolvedSkills.skillIds).toEqual([SEO]);
  });

  it("preview and dispatch agree once both narrow by the same scope-differentiated assignment", async () => {
    // The defect this closes, in one assertion: before this, prepareNodeExecution showed the full
    // live assignment while executeNode (once pinned) narrowed it — a caller could preview
    // reference_content_writer, see three skills, dispatch, and get one. Same node, same
    // assignment, one fresh dispatch (no runId, so nothing pre-pinned to diverge from): preview and
    // dispatch must resolve to the identical set.
    await createNode([CRAFT, SITE_SCOPED, WORKSPACE_PLACEHOLDER_SCOPED, TASK_SCOPED]);
    const prep = await prepareNodeExecution({ nodeId: NODE_ID, input: {} }) as { resolvedSkills: { skillIds: string[] } };
    const executed = await executePinProbe();
    const dispatched = executed.execution.skillSelection?.[NODE_ID]?.skillIds ?? [];
    expect(prep.resolvedSkills.skillIds.sort()).toEqual([...dispatched].sort());
  });
});

// C2/C3 — node.execute's missing candidateSkillIds parameter, closed. #365 built pinSkillSelection's
// `options.candidateSkillIds`; nothing on the MCP surface could ever supply it, because
// node.execute's (and node.prepare_execution's) schema had no field for it. These tests exercise
// the parameter end to end from executeNode/prepareNodeExecution — the same boundary node.execute
// and node.prepare_execution call through — not the already-covered pinSkillSelection unit itself.
describe("executeNode/prepareNodeExecution — candidateSkillIds (C2/C3)", () => {
  beforeEach(() => {
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
  });

  // The real three-family case named in the gap this closes: reference_content_writer is a
  // CANONICAL node (siteContentSpecialistNodes.ts, resolved via resolveNodeForExecution's
  // store-miss fallback — never seeded into the store here), assigned faq_help_process,
  // policy_explanation and evidence_story — three different jobs sharing one node, each its own
  // unscoped, fleet-neutral family (seededSkills.ts). A dispatch naming one of them as its
  // candidate must resolve only that one, not the other two.
  const REFERENCE_CONTENT_WRITER = "reference_content_writer";
  const referenceInput = { referenceKind: "faq", brief: { audience: "unit test" } };

  it("a dispatch naming one of reference_content_writer's three skills resolves only that one", async () => {
    const result = await executeNode({
      nodeId: REFERENCE_CONTENT_WRITER, input: referenceInput, executionMode: "mock",
      runId: "run_candidate_narrows_real_node", candidateSkillIds: ["policy_explanation"]
    }) as { execution: WorkflowExecutionRecord };
    const pinned = result.execution.skillSelection?.[REFERENCE_CONTENT_WRITER];
    expect(pinned?.skillIds).toEqual(["policy_explanation"]);
    expect(pinned?.source).toBe("recipe_candidates");
  });

  it("a named skill the node was never assigned is dropped, not granted", async () => {
    await createNode([CRAFT]);
    const result = await executeNode({ nodeId: NODE_ID, input: {}, executionMode: "mock", candidateSkillIds: [SEO] }) as { execution: WorkflowExecutionRecord };
    const pinned = result.execution.skillSelection?.[NODE_ID];
    expect(pinned?.skillIds).toEqual([]);
    expect(pinned?.dropped).toContainEqual(expect.objectContaining({ skillId: SEO, reason: "not_assigned" }));
  });

  it("[] resolves to no skills — presence, not length", async () => {
    await createNode([CRAFT, SEO]);
    const result = await executeNode({ nodeId: NODE_ID, input: {}, executionMode: "mock", candidateSkillIds: [] }) as { execution: WorkflowExecutionRecord };
    const pinned = result.execution.skillSelection?.[NODE_ID];
    expect(pinned?.skillIds).toEqual([]);
    expect(pinned?.candidateSkillIds).toEqual([]);
    expect(pinned?.source).toBe("recipe_candidates");
  });

  it("omitting the parameter behaves exactly as main does today", async () => {
    await createNode([CRAFT, SEO]);
    const result = await executeNode({ nodeId: NODE_ID, input: {}, executionMode: "mock" }) as { execution: WorkflowExecutionRecord };
    const pinned = result.execution.skillSelection?.[NODE_ID];
    expect(pinned?.skillIds.sort()).toEqual([CRAFT, SEO].sort());
    expect(pinned?.candidateSkillIds).toBeUndefined();
    expect(pinned?.source).not.toBe("recipe_candidates");
  });

  it("a reused runId with an existing pin ignores the candidate list", async () => {
    await createNode([CRAFT, SEO]);
    await seedRun("run_reused_ignores_candidates", { [NODE_ID]: seedSelection({ skillIds: [CRAFT] }) });
    const result = await executeNode({ nodeId: NODE_ID, input: {}, executionMode: "mock", runId: "run_reused_ignores_candidates", candidateSkillIds: [SEO] }) as { execution: WorkflowExecutionRecord };
    expect(result.execution.skillSelection?.[NODE_ID]?.skillIds).toEqual([CRAFT]);
  });

  it("prepareNodeExecution narrows by candidate the same way executeNode pins, so a preview never diverges from its dispatch", async () => {
    await createNode([CRAFT, SEO, TASK_SCOPED]);
    const prep = await prepareNodeExecution({ nodeId: NODE_ID, input: {}, candidateSkillIds: [CRAFT] }) as { resolvedSkills: { skillIds: string[] } };
    // NARROWS TO THE CANDIDATE, not the full (scope-narrowed) assignment: TASK_SCOPED would
    // otherwise survive scope narrowing (it is scoped to this exact node), so its absence here is
    // what would fail if prepareNodeExecution stopped applying candidateSkillIds and fell back to
    // scope narrowing alone.
    expect(prep.resolvedSkills.skillIds).toEqual([CRAFT]);

    const executed = await executeNode({ nodeId: NODE_ID, input: {}, executionMode: "mock", candidateSkillIds: [CRAFT] }) as { execution: WorkflowExecutionRecord };
    expect(executed.execution.skillSelection?.[NODE_ID]?.skillIds).toEqual(prep.resolvedSkills.skillIds);
  });

  it("prepareNodeExecution never grants a candidate the node was not assigned", async () => {
    await createNode([CRAFT]);
    const prep = await prepareNodeExecution({ nodeId: NODE_ID, input: {}, candidateSkillIds: [SEO] }) as { resolvedSkills: { skillIds: string[] } };
    expect(prep.resolvedSkills.skillIds).toEqual([]);
  });
});
