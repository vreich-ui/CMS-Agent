import { describe, expect, it } from "vitest";
import { MemorySkillRepository } from "../../../src/agent/skills/skillRegistry.js";
import { seededSkillDefinitions } from "../../../src/agent/skills/seededSkills.js";
import { STANDARDS_PACK_SKILL_ID } from "../../../src/agent/skills/standardsPack.js";
import { resolveSkillsForNode } from "../../../src/agent/skills/skillResolver.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const node = (patch: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id: "n1", name: "Node", kind: "test", description: "", prompt: "Node prompt",
  inputSchema: { type: "object" }, outputSchema: { type: "object" }, allowedTools: [],
  assignedSkills: [], requiredInputs: [], produces: [], riskLevel: "read", dependsOn: [],
  status: "active", position: { x: 0, y: 0 }, updatedAt: new Date().toISOString(),
  ...patch
});

// F1 — a live skill store populated before structure_studio_standards_pack shipped never gets it
// (BlobSkillRepository.load() only seeds a COMPLETELY EMPTY store), so all five structure-studio
// nodes hard-fail with invalid_node_configuration via skillResolver.ts's blocker. ensureSkillSeeds()
// is the additive top-up that fixes it without ever touching an operator's edited skill rows.
describe("ensureSkillSeeds — additive top-up (F1)", () => {
  it("tops up only the missing canonical skill, leaves an operator-edited row untouched field-for-field, and is a no-op on a second call", async () => {
    // Separate backend bucket from the remedy test below, so the two tests' destructive edits
    // (delete/update) never interfere with each other within this file.
    const repo = new MemorySkillRepository("memory");

    // A store populated before the standards pack shipped: delete it to model that gap.
    await repo.delete(STANDARDS_PACK_SKILL_ID);
    expect(await repo.get(STANDARDS_PACK_SKILL_ID)).toBeUndefined();

    // An operator's edit to some OTHER seeded skill: changed instructions, bumped version, disabled.
    const otherSeed = seededSkillDefinitions.find((s) => s.skillId !== STANDARDS_PACK_SKILL_ID)!;
    await repo.update(otherSeed.skillId, { instructions: "OPERATOR EDITED INSTRUCTIONS", version: "9.9.9", status: "deprecated" });

    const versionBeforeTopup = await repo.getSkillVersion();
    const topped = await repo.ensureSkillSeeds();

    // The missing pack is restored, matching the canonical definition.
    const canonical = seededSkillDefinitions.find((s) => s.skillId === STANDARDS_PACK_SKILL_ID)!;
    expect(topped.some((s) => s.skillId === STANDARDS_PACK_SKILL_ID)).toBe(true);
    const restored = await repo.get(STANDARDS_PACK_SKILL_ID);
    expect(restored).toMatchObject({ skillId: canonical.skillId, version: canonical.version, instructions: canonical.instructions, status: canonical.status });

    // The operator-edited row is unchanged, field-for-field.
    const edited = await repo.get(otherSeed.skillId);
    expect(edited).toMatchObject({ skillId: otherSeed.skillId, instructions: "OPERATOR EDITED INSTRUCTIONS", version: "9.9.9", status: "deprecated" });

    const versionAfterTopup = await repo.getSkillVersion();
    expect(versionAfterTopup).toBeGreaterThan(versionBeforeTopup);

    // Idempotent: nothing missing now, so a second call performs NO mutation — the skill version
    // counter must not move.
    const secondResult = await repo.ensureSkillSeeds();
    expect(await repo.getSkillVersion()).toBe(versionAfterTopup);
    expect(secondResult.find((s) => s.skillId === otherSeed.skillId)).toMatchObject({ instructions: "OPERATOR EDITED INSTRUCTIONS", version: "9.9.9", status: "deprecated" });
  });
});

describe("resolveSkillsForNode — blocked stage names the canonical-seed remedy (F1)", () => {
  it("names the additive top-up for a structure-studio node against a store missing the pack, then resolves cleanly after ensureSkillSeeds()", async () => {
    const repo = new MemorySkillRepository("json");
    await repo.delete(STANDARDS_PACK_SKILL_ID);

    const studioNode = node({ id: "layout_analyst", assignedSkills: [STANDARDS_PACK_SKILL_ID] });
    const blocked = await resolveSkillsForNode(studioNode, repo);
    const blocker = blocked.conflicts.find((c) => c.severity === "blocker" && c.source === STANDARDS_PACK_SKILL_ID);
    expect(blocker).toBeDefined();
    // Names the remedy, not just the fact: a canonical seed, and the additive restore path.
    expect(blocker!.message).toContain("canonical seed");
    expect(blocker!.message).toMatch(/skill_list|skill_resolve_for_node/);

    await repo.ensureSkillSeeds();
    const resolved = await resolveSkillsForNode(studioNode, repo);
    expect(resolved.conflicts.filter((c) => c.severity === "blocker")).toEqual([]);
    const canonical = seededSkillDefinitions.find((s) => s.skillId === STANDARDS_PACK_SKILL_ID)!;
    expect(resolved.instructions).toContain(canonical.instructions);
  });

  it("names an unknown (non-canonical) missing skill differently — no additive remedy exists for it", async () => {
    const repo = new MemorySkillRepository("json");
    const blocked = await resolveSkillsForNode(node({ assignedSkills: ["totally_made_up_skill_id"] }), repo);
    const blocker = blocked.conflicts.find((c) => c.severity === "blocker" && c.source === "totally_made_up_skill_id");
    expect(blocker).toBeDefined();
    // Distinguishes itself from the canonical-remedy case by saying this id is NOT a canonical
    // seed (so no additive top-up can fix it) and naming the create/unassign remedy instead.
    expect(blocker!.message).toContain("not a canonical seed");
    expect(blocker!.message).not.toMatch(/skill_list|skill_resolve_for_node/);
    expect(blocker!.message).toMatch(/skill_create|skill_unassign/);
  });
});
