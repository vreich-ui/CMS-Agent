/**
 * C2 — the skill set a run actually used.
 *
 * Before this, every dispatch and every inspection read `node.assignedSkills`, one global mutable
 * list. So a `skill.assign` mid-run silently changed policy between two nodes of the same run, two
 * runs could not want different skills for one node without racing each other, and asking what a
 * finished run used returned what the node would use TODAY. These pin the replacement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({ config: undefined as any }));
vi.mock("@openai/agents", () => ({
  OpenAIProvider: class { async getModel() { return { async getResponse() { return { usage: {}, output: [] }; }, async *getStreamedResponse() {} }; } },
  Agent: class { constructor(config: unknown) { captures.config = config; } },
  run: async () => ({ finalOutput: { artifact: "content_source.v1", summary: "offline", trafficSource: "organic_search", awarenessStage: "problem_aware" }, rawResponses: [], lastResponseId: "offline" }),
  tool: (definition: unknown) => definition,
  OpenAIChatCompletionsModel: class {}
}));

import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { resolveSkillsForNode } from "../../../src/agent/skills/skillResolver.js";
import { OpenAINodeRunner } from "../../../src/agent/execution/runners/OpenAINodeRunner.js";
import { mergeNodeAdvance } from "../../../src/agent/workspace/nodeAdvanceSave.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import {
  RUN_SKILL_SELECTION_CONTRACT,
  mergeSkillSelections,
  pinSkillSelection,
  selectedSkillsFor,
  type RunSkillSelection
} from "../../../src/agent/skills/runSkillSelection.js";

const CRAFT = "editorial_craft";
const SEO = "seo_review";
const CRAFT_MARK = "CMS_AGENT_TEST_CRAFT_SENTINEL";
const SEO_MARK = "CMS_AGENT_TEST_SEO_SENTINEL";

const baseNode = (assigned: string[]) => ({ ...listWorkspaceNodes().find((n) => n.id === "input_triage")!, assignedSkills: assigned, allowedTools: [] });
const emptyRun = (over: Partial<WorkflowExecutionRecord> = {}) =>
  ({ runId: "run_test", workflowId: "publishing_conductor", projectId: "cms-agent-test", stageOutputs: {}, nodes: [], artifacts: [], errors: [], ...over }) as unknown as WorkflowExecutionRecord;

const selection = (over: Partial<RunSkillSelection> = {}): RunSkillSelection =>
  ({ contract: RUN_SKILL_SELECTION_CONTRACT, skillIds: [CRAFT], versions: { [CRAFT]: "1.0.0" }, selectedAt: "2026-09-15T10:00:00.000Z", source: "node_assignment", ...over });

beforeEach(async () => {
  vi.stubEnv("WORKSPACE_STORE", "memory");
  vi.stubEnv("OPENAI_API_KEY", "offline-fake-key");
  resetRepositoryManager();
  captures.config = undefined;
  const skills = repositoryManager.getSkillRepository();
  await skills.update(CRAFT, { instructions: CRAFT_MARK, status: "active", outputSchema: { type: "object" } });
  await skills.update(SEO, { instructions: SEO_MARK, status: "active", outputSchema: { type: "object" } });
});
afterEach(() => { vi.restoreAllMocks(); resetRepositoryManager(); vi.unstubAllEnvs(); });

describe("pinSkillSelection", () => {
  it("records the ids and the versions they carried at dispatch", async () => {
    const run = emptyRun();
    const pinned = await pinSkillSelection(run, baseNode([CRAFT, SEO]), repositoryManager.getSkillRepository());
    expect(pinned.skillIds).toEqual([CRAFT, SEO]);
    expect(Object.keys(pinned.versions).sort()).toEqual([CRAFT, SEO].sort());
    expect(selectedSkillsFor(run, "input_triage")).toBe(pinned);
  });

  it("is write-once: a reassignment after the pin cannot change what the node dispatched with", async () => {
    const run = emptyRun();
    const first = await pinSkillSelection(run, baseNode([CRAFT]), repositoryManager.getSkillRepository());
    // The operator reassigns the node. A retry, a reclaim after a stale claim, or a second driver
    // arriving at the same node must all still see the first answer.
    const second = await pinSkillSelection(run, baseNode([SEO]), repositoryManager.getSkillRepository());
    expect(second).toBe(first);
    expect(second.skillIds).toEqual([CRAFT]);
  });

  it("pins the ids even when the version read fails, rather than leaving the dispatch unpinned", async () => {
    const run = emptyRun();
    const broken = { list: async () => { throw new Error("store unreachable"); } } as never;
    const pinned = await pinSkillSelection(run, baseNode([CRAFT]), broken);
    // The ids are what stop the race; the versions are only what explain it afterwards. A missing
    // version is an absent key, never a guessed one.
    expect(pinned.skillIds).toEqual([CRAFT]);
    expect(pinned.versions).toEqual({});
  });

  it("pins an empty set as an empty set, which is a real answer and not 'unpinned'", async () => {
    const run = emptyRun();
    const pinned = await pinSkillSelection(run, baseNode([]), repositoryManager.getSkillRepository());
    expect(pinned.skillIds).toEqual([]);
    expect(selectedSkillsFor(run, "input_triage")).toBeDefined();
  });
});

describe("the pinned selection survives a save conflict", () => {
  it("mergeSkillSelections unions, and the stored entry wins a key both hold", () => {
    const stored = { a: selection({ selectedAt: "2026-09-15T09:00:00.000Z" }) };
    const advanced = { a: selection({ selectedAt: "2026-09-15T11:00:00.000Z" }), b: selection({ skillIds: [SEO] }) };
    const merged = mergeSkillSelections(stored, advanced)!;
    // Write-once means the stored entry is the one its dispatch used; a second computation of the
    // same decision must never overwrite it.
    expect(merged.a.selectedAt).toBe("2026-09-15T09:00:00.000Z");
    expect(merged.b.skillIds).toEqual([SEO]);
    expect(mergeSkillSelections(undefined, undefined)).toBeUndefined();
  });

  it("mergeNodeAdvance carries it — the defect #353 fixed for defaultedNodeIds, one field over", () => {
    const stored = emptyRun({ nodes: [], skillSelection: { alpha: selection() } });
    const advanced = emptyRun({ nodes: [], skillSelection: { beta: selection({ skillIds: [SEO] }) } });
    const merged = mergeNodeAdvance(stored, advanced, []);
    // A run whose nodes ran under a recorded policy, with no record of the policy, is what dropping
    // this field on a CAS conflict would produce.
    expect(Object.keys(merged.skillSelection ?? {}).sort()).toEqual(["alpha", "beta"]);
    // An ordinary run's record is unchanged: the key is omitted entirely when neither side has one.
    expect(mergeNodeAdvance(emptyRun(), emptyRun(), [])).not.toHaveProperty("skillSelection");
  });
});

describe("resolveSkillsForNode against a pin", () => {
  it("resolves the pinned ids, not the node's live assignment", async () => {
    const node = baseNode([SEO]);
    const policy = await resolveSkillsForNode(node, repositoryManager.getSkillRepository(), { pinnedSkillIds: [CRAFT] });
    expect(policy.skillIds).toEqual([CRAFT]);
    expect(policy.instructions).toContain(CRAFT_MARK);
    expect(policy.instructions).not.toContain(SEO_MARK);
  });

  it("treats an empty pinned array as 'this node dispatched with no skills', not as 'no pin'", async () => {
    const node = baseNode([CRAFT, SEO]);
    const policy = await resolveSkillsForNode(node, repositoryManager.getSkillRepository(), { pinnedSkillIds: [] });
    expect(policy.skillIds).toEqual([]);
    expect(policy.instructions).not.toContain(CRAFT_MARK);
  });

  it("names a skill that has been edited since the run pinned it, instead of presenting it as what ran", async () => {
    const node = baseNode([CRAFT]);
    const policy = await resolveSkillsForNode(node, repositoryManager.getSkillRepository(), {
      pinnedSkillIds: [CRAFT],
      pinnedVersions: { [CRAFT]: "0.0.1-before-the-edit" }
    });
    const drift = policy.conflicts.find((conflict) => conflict.source === CRAFT && conflict.message.includes("changed since"));
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe("warning");
    // Both versions are named: a reader has to be able to go and look at the difference.
    expect(drift!.message).toContain("0.0.1-before-the-edit");
    expect(drift!.message).toContain("the store now holds");
  });

  it("reports a pinned skill that no longer exists as a blocker naming the id", async () => {
    const node = baseNode([CRAFT]);
    const policy = await resolveSkillsForNode(node, repositoryManager.getSkillRepository(), { pinnedSkillIds: ["skill_that_was_deleted"] });
    expect(policy.conflicts.some((conflict) => conflict.severity === "blocker" && conflict.message.includes("skill_that_was_deleted"))).toBe(true);
  });
});

describe("the race, through the runner that actually dispatches", () => {
  it("dispatches with the skills the run pinned, after the node's assignment has been changed underneath it", async () => {
    // The node as it stood when the run claimed it.
    const atDispatch = baseNode([CRAFT]);
    const run = emptyRun();
    await pinSkillSelection(run, atDispatch, repositoryManager.getSkillRepository());

    // An operator now reassigns the node — the `skill.assign` that used to decide what this
    // in-flight run ran with.
    const reassigned = baseNode([SEO]);

    await new OpenAINodeRunner().run(
      { node: reassigned as never, input: {} },
      { run, executionRepository: {} as never }
    );

    expect(captures.config).toBeDefined();
    expect(captures.config.instructions).toContain(CRAFT_MARK);
    expect(captures.config.instructions).not.toContain(SEO_MARK);
  });

  it("falls back to the live assignment for a run that carries no pin, so nothing that worked before changes", async () => {
    const node = baseNode([SEO]);
    await new OpenAINodeRunner().run(
      { node: node as never, input: {} },
      { run: emptyRun(), executionRepository: {} as never }
    );
    expect(captures.config.instructions).toContain(SEO_MARK);
  });
});
