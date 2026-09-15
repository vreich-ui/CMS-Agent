/**
 * C2 (part 2) — WHICH of a node's assigned skills actually apply here.
 *
 * #358 pinned the set a node dispatched with and took `assignedSkills` as given. These pin the half
 * it left out: the candidates are narrowed by the scope vocabulary against the run's own situation,
 * a family admits exactly one member, and a tie is refused rather than decided by sort order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { resolveSkillsForNode } from "../../../src/agent/skills/skillResolver.js";
import { pinSkillSelection, runScopeContext, selectScopedSkills } from "../../../src/agent/skills/runSkillSelection.js";
import type { SkillDefinition } from "../../../src/agent/skills/skillTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { PolicyScope } from "../../../src/agent/scope/policyScope.js";

const skill = (skillId: string, over: Partial<SkillDefinition> = {}): SkillDefinition => ({
  skillId, name: skillId, description: skillId, version: "1.0.0", status: "active", instructions: `${skillId} instructions`,
  inputSchema: { type: "object" }, outputSchema: { type: "object" }, allowedTools: [], requiredArtifacts: [], producedArtifacts: [],
  examples: [{ name: "basic", input: {}, output: {} }], preconditions: [], completionCriteria: [], blockerCriteria: [],
  memoryPolicy: { namespaces: [skillId], read: true, write: false }, toolPolicy: { requestedTools: [], mutatingToolsRequireApproval: true },
  riskLevel: "read", metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over
});

const DR_LURIE = { site: "dr-lurie", task: "input_triage" };

describe("selectScopedSkills", () => {
  it("keeps an unscoped skill everywhere — the behaviour of every skill before scope existed", () => {
    const defined = [skill("editorial_craft")];
    expect(selectScopedSkills(["editorial_craft"], defined, DR_LURIE)).toEqual({ skillIds: ["editorial_craft"], dropped: [] });
    expect(selectScopedSkills(["editorial_craft"], defined, {}).skillIds).toEqual(["editorial_craft"]);
  });

  it("drops a skill scoped to another site, and says which scope it wanted", () => {
    const defined = [skill("fernwell_voice", { scope: { site: "fernwell" } })];
    const result = selectScopedSkills(["fernwell_voice"], defined, DR_LURIE);
    expect(result.skillIds).toEqual([]);
    expect(result.dropped).toEqual([{ skillId: "fernwell_voice", reason: "out_of_scope", detail: expect.stringContaining("site fernwell") }]);
  });

  it("resolves a DTC/foundation pair: the site-scoped member displaces the fleet one, on that site only", () => {
    const defined = [
      skill("organization_narrative_foundation", { family: "organization_narrative" }),
      skill("organization_narrative_dtc", { family: "organization_narrative", scope: { site: "dr-lurie" } })
    ];
    const candidates = ["organization_narrative_foundation", "organization_narrative_dtc"];

    const onDrLurie = selectScopedSkills(candidates, defined, DR_LURIE);
    expect(onDrLurie.skillIds).toEqual(["organization_narrative_dtc"]);
    expect(onDrLurie.dropped[0]).toMatchObject({ skillId: "organization_narrative_foundation", reason: "superseded" });

    // The same two skills, the same node, another tenant: the fleet member serves it untouched.
    const onFernwell = selectScopedSkills(candidates, defined, { site: "fernwell", task: "input_triage" });
    expect(onFernwell.skillIds).toEqual(["organization_narrative_foundation"]);
  });

  it("keeps BOTH members of an unresolvable family tie so the resolver can block on it", () => {
    // Two equally narrow members that both apply. Picking one by id order would let the alphabet
    // decide what the node runs; the vocabulary says a tie is a configuration error instead.
    const defined = [
      skill("narrative_a", { family: "organization_narrative", scope: { site: "dr-lurie" } }),
      skill("narrative_b", { family: "organization_narrative", scope: { task: "input_triage" } })
    ];
    const result = selectScopedSkills(["narrative_a", "narrative_b"], defined, DR_LURIE);
    expect(result.skillIds).toEqual(["narrative_a", "narrative_b"]);
    expect(result.dropped).toEqual([]);
  });

  it("never drops an id it has no definition for — that stays the resolver's 'not found' blocker", () => {
    const result = selectScopedSkills(["ghost_skill"], [], DR_LURIE);
    expect(result.skillIds).toEqual(["ghost_skill"]);
    expect(result.dropped).toEqual([]);
  });

  it("preserves the node's assignment order, which is the order instructions are concatenated in", () => {
    const defined = [skill("first"), skill("second"), skill("third")];
    expect(selectScopedSkills(["third", "first", "second"], defined, DR_LURIE).skillIds).toEqual(["third", "first", "second"]);
  });
});

describe("runScopeContext", () => {
  it("is site + task, plus the objective only when the run declared one", () => {
    expect(runScopeContext({ projectId: "dr-lurie" }, "draft_writer")).toEqual({ site: "dr-lurie", task: "draft_writer" });
    expect(runScopeContext({ projectId: "dr-lurie", objective: "q4_launch" }, "draft_writer")).toEqual({ site: "dr-lurie", task: "draft_writer", objective: "q4_launch" });
  });
});

describe("pinSkillSelection, scoped", () => {
  const CRAFT = "editorial_craft";
  const SEO = "seo_review";
  const node = (assigned: string[]) => ({ ...listWorkspaceNodes().find((n) => n.id === "input_triage")!, assignedSkills: assigned, allowedTools: [] });
  const run = (over: Partial<WorkflowExecutionRecord> = {}) =>
    ({ runId: "run_test", workflowId: "publishing_conductor", projectId: "dr-lurie", stageOutputs: {}, nodes: [], artifacts: [], errors: [], ...over }) as unknown as WorkflowExecutionRecord;

  beforeEach(async () => {
    vi.stubEnv("WORKSPACE_STORE", "memory");
    resetRepositoryManager();
  });
  afterEach(() => { resetRepositoryManager(); vi.unstubAllEnvs(); });

  it("pins only the skills whose scope applies, records the rest, and says the selection was scoped", async () => {
    const skills = repositoryManager.getSkillRepository();
    await skills.update(SEO, { scope: { site: "fernwell" } as PolicyScope });
    const record = run();

    const pinned = await pinSkillSelection(record, node([CRAFT, SEO]), skills);

    expect(pinned.skillIds).toEqual([CRAFT]);
    expect(pinned.source).toBe("scoped_selection");
    expect(pinned.context).toEqual({ site: "dr-lurie", task: "input_triage" });
    expect(pinned.dropped).toEqual([{ skillId: SEO, reason: "out_of_scope", detail: expect.stringContaining("site fernwell") }]);
    expect(pinned.degradedReason).toBeUndefined();
  });

  it("does NOT narrow on a read it could not make, and says the set is wider than the vocabulary would make it", async () => {
    // An unreadable store is not evidence that a skill is out of scope. Dropping a node's craft
    // skills on a transient failure is worse than dispatching with the wider set and saying so.
    const broken = { ...repositoryManager.getSkillRepository(), list: async () => { throw new Error("store unreachable"); } } as never;
    const record = run();

    const pinned = await pinSkillSelection(record, node([CRAFT, SEO]), broken);

    expect(pinned.skillIds).toEqual([CRAFT, SEO]);
    expect(pinned.source).toBe("node_assignment");
    expect(pinned.degradedReason).toContain("scope narrowing was not applied");
  });

  it("is still write-once: a second pin after a reassignment returns the first answer", async () => {
    const skills = repositoryManager.getSkillRepository();
    const record = run();
    const first = await pinSkillSelection(record, node([CRAFT]), skills);
    const second = await pinSkillSelection(record, node([CRAFT, SEO]), skills);
    expect(second).toBe(first);
    expect(second.skillIds).toEqual([CRAFT]);
  });
});

describe("resolveSkillsForNode, families", () => {
  beforeEach(async () => { vi.stubEnv("WORKSPACE_STORE", "memory"); resetRepositoryManager(); });
  afterEach(() => { resetRepositoryManager(); vi.unstubAllEnvs(); });

  it("blocks when two members of one family reach a dispatch, naming both and their scopes", async () => {
    const skills = repositoryManager.getSkillRepository();
    await skills.update("editorial_craft", { family: "voice" });
    await skills.update("seo_review", { family: "voice", scope: { site: "dr-lurie" } as PolicyScope });
    const node = { ...listWorkspaceNodes().find((n) => n.id === "input_triage")!, assignedSkills: ["editorial_craft", "seo_review"], allowedTools: [] };

    const policy = await resolveSkillsForNode(node, skills, { pinnedSkillIds: ["editorial_craft", "seo_review"] });
    const blocker = policy.conflicts.find((conflict) => conflict.severity === "blocker" && conflict.source === "voice");

    expect(blocker?.message).toContain("editorial_craft (the fleet)");
    expect(blocker?.message).toContain("seo_review (site dr-lurie)");
    expect(blocker?.message).toContain("skill_unassign");
  });

  it("does not block a family with one member", async () => {
    const skills = repositoryManager.getSkillRepository();
    await skills.update("editorial_craft", { family: "voice" });
    const node = { ...listWorkspaceNodes().find((n) => n.id === "input_triage")!, assignedSkills: ["editorial_craft"], allowedTools: [] };
    const policy = await resolveSkillsForNode(node, skills, { pinnedSkillIds: ["editorial_craft"] });
    expect(policy.conflicts.filter((conflict) => conflict.severity === "blocker")).toEqual([]);
  });
});

/**
 * C2 (part 2) — the run's own declaration of the third dimension. Operator-supplied, never derived,
 * and carried across a reset for the same reason `requestId` is: a reset retries the same request,
 * under the same goal.
 */
describe("run.objective", () => {
  it("is stored when the caller names one, absent when not, and survives a reset", async () => {
    const { RepositoryManager } = await import("../../../src/agent/repository/RepositoryManager.js");
    const { resetRun, startDryRun } = await import("../../../src/agent/workspace/executor.js");
    const store = new RepositoryManager().getExecutionRepository();

    const named = await startDryRun({ executionMode: "mock", projectId: "project-objective", input: "x", objective: "q4_launch" }, store);
    const unnamed = await startDryRun({ executionMode: "mock", projectId: "project-objective", input: "x" }, store);

    expect(named.objective).toBe("q4_launch");
    expect(unnamed.objective).toBeUndefined();
    expect((await resetRun(named.runId, store)).objective).toBe("q4_launch");
  });
});
