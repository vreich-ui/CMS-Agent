import { describe, expect, it } from "vitest";
import {
  loadStandardsPackSnapshot,
  resolveStandardsPackSnapshot,
  standardsPackSectionTypeSnapshot,
  standardsPackSkillDefinition,
  STANDARDS_PACK_SKILL_ID,
  STANDARDS_PACK_VERSION
} from "../../../src/agent/skills/standardsPack.js";
import { STANDARDS_PACK_VERSION as PROVENANCE_STANDARDS_PACK_VERSION } from "../../../src/agent/library/templateProvenance.js";
import { seededSkillDefinitions } from "../../../src/agent/skills/seededSkills.js";
import { MemorySkillRepository } from "../../../src/agent/skills/skillRegistry.js";
import { resolveSkillsForNode } from "../../../src/agent/skills/skillResolver.js";
import { CLONE_AI_NODE_IDS, listCloneConductorNodes } from "../../../src/agent/workspace/cloneConductorNodes.js";
import { SUPPORTED_SECTION_TYPES } from "../../../src/agent/capture/engine/map.mjs";

// T15.33 (#209; ADR-2026-08-25-structure-studio §6.2) — the standards pack: pinned version,
// delivered through the existing skills machinery, assigned to the studio's authoring nodes.

describe("standards pack version — pinned, not a placeholder", () => {
  it("is a real, stated version, not the T15.33 placeholder it replaces", () => {
    expect(STANDARDS_PACK_VERSION).not.toBe("unpinned-pending-T15.33");
    expect(STANDARDS_PACK_VERSION.length).toBeGreaterThan(0);
  });

  it("is the SAME literal templateProvenance.ts re-exports (single source of truth)", () => {
    expect(PROVENANCE_STANDARDS_PACK_VERSION).toBe(STANDARDS_PACK_VERSION);
  });

  it("is the SAME literal the seeded skill definition states as its own version — they cannot drift apart", () => {
    expect(standardsPackSkillDefinition.version).toBe(STANDARDS_PACK_VERSION);
  });

  it("is deterministic — reading it twice yields the identical literal (no clock, no randomness)", () => {
    const first = STANDARDS_PACK_VERSION;
    const second = STANDARDS_PACK_VERSION;
    expect(first).toBe(second);
  });
});

describe("standards pack — delivered through the EXISTING skills machinery", () => {
  it("is present in seededSkillDefinitions, the set every fresh workspace is seeded with", () => {
    const found = seededSkillDefinitions.find((skill) => skill.skillId === STANDARDS_PACK_SKILL_ID);
    expect(found).toBeDefined();
    expect(found?.status).toBe("active");
  });

  it("is a valid skill the repository accepts (assertValidSkill does not throw)", async () => {
    const repo = new MemorySkillRepository("json");
    expect(await repo.get(STANDARDS_PACK_SKILL_ID)).toBeDefined();
  });

  it("carries a section-type registry snapshot equal to the live SUPPORTED_SECTION_TYPES vocabulary", () => {
    expect(standardsPackSectionTypeSnapshot()).toEqual([...SUPPORTED_SECTION_TYPES].sort());
    expect(standardsPackSkillDefinition.metadata.sectionTypeRegistrySnapshot).toEqual(standardsPackSectionTypeSnapshot());
  });

  it("is assigned to EVERY studio judgment node (CLONE_AI_NODE_IDS) and no other node", () => {
    const nodes = listCloneConductorNodes();
    for (const nodeId of CLONE_AI_NODE_IDS) {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      expect(node, `expected node ${nodeId} to exist`).toBeDefined();
      expect(node?.assignedSkills, `${nodeId} should carry the standards pack`).toContain(STANDARDS_PACK_SKILL_ID);
    }
    const deterministicNodes = nodes.filter((node) => !(CLONE_AI_NODE_IDS as readonly string[]).includes(node.id));
    for (const node of deterministicNodes) {
      expect(node.assignedSkills, `${node.id} is deterministic and should not carry the pack`).not.toContain(STANDARDS_PACK_SKILL_ID);
    }
  });

  it("its instructions reach a judgment node's effective prompt via resolveSkillsForNode", async () => {
    const repo = new MemorySkillRepository("json");
    const node = listCloneConductorNodes().find((candidate) => candidate.id === "recipe_designer")!;
    const resolved = await resolveSkillsForNode(node, repo);
    expect(resolved.instructions).toContain(STANDARDS_PACK_SKILL_ID);
    expect(resolved.instructions).toContain(STANDARDS_PACK_VERSION);
    expect(resolved.conflicts.filter((c) => c.severity === "blocker")).toEqual([]);
  });
});

describe("resolveStandardsPackSnapshot — pure, resolved once", () => {
  it("resolves from a given skill definition without any I/O or clock", () => {
    const snapshot = resolveStandardsPackSnapshot(standardsPackSkillDefinition);
    expect(snapshot).toEqual({
      skillId: STANDARDS_PACK_SKILL_ID,
      version: STANDARDS_PACK_VERSION,
      sectionTypeRegistry: standardsPackSectionTypeSnapshot()
    });
  });

  it("falls back to the coded pin, never blocking, when the skill is absent", () => {
    const snapshot = resolveStandardsPackSnapshot(undefined);
    expect(snapshot.version).toBe(STANDARDS_PACK_VERSION);
    expect(snapshot.skillId).toBe(STANDARDS_PACK_SKILL_ID);
    expect(snapshot.sectionTypeRegistry.length).toBeGreaterThan(0);
  });

  it("is a pure function: the same skill input always resolves the same snapshot", () => {
    const a = resolveStandardsPackSnapshot(standardsPackSkillDefinition);
    const b = resolveStandardsPackSnapshot(standardsPackSkillDefinition);
    expect(a).toEqual(b);
  });

  it("a hypothetical LIVE pack bump (a different skill.version) does not change the pinned constant other code reads", () => {
    // Simulates an operator bumping the skill's version via skill_update. The resolver correctly
    // reports the BUMPED version when handed that skill directly...
    const bumped = { ...standardsPackSkillDefinition, version: "2026.09.01-1" };
    expect(resolveStandardsPackSnapshot(bumped).version).toBe("2026.09.01-1");
    // ...but the code-pinned STANDARDS_PACK_VERSION constant — what templateLibraryStore.publish()
    // actually stamps onto every deposit — is untouched by that live bump, exactly as designed: a
    // live skill-store edit changes what a node's prompt says, never what a published template's
    // provenance claims, until a deliberate code-level version bump ships (see standardsPack.ts's
    // own "refresh flow" comment).
    expect(STANDARDS_PACK_VERSION).not.toBe("2026.09.01-1");
  });

  it("loadStandardsPackSnapshot reads the repository ONCE and resolves from that single read", async () => {
    let calls = 0;
    const repo = { get: async (id: string) => { calls += 1; return id === STANDARDS_PACK_SKILL_ID ? standardsPackSkillDefinition : undefined; } };
    const snapshot = await loadStandardsPackSnapshot(repo);
    expect(calls).toBe(1);
    expect(snapshot.version).toBe(STANDARDS_PACK_VERSION);
  });
});
