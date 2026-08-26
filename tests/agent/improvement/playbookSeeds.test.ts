import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { playbookSeeds } from "../../../src/agent/improvement/playbookSeeds.js";

describe("T15.17: Judgment node playbook seeds", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  const judgmentNodes = ["block_classifier", "gap_adjudicator", "layout_analyst", "recipe_designer", "theme_reconciler", "fit_adjudicator"];

  it("all six judgment nodes have playbook seeds defined", () => {
    for (const nodeId of judgmentNodes) {
      expect(playbookSeeds.has(nodeId), `${nodeId} should have a seed`).toBe(true);
      const seed = playbookSeeds.get(nodeId)!;
      expect(seed.add, `${nodeId} seed should have add items`).toBeDefined();
      expect(seed.add!.length, `${nodeId} seed should have at least one item`).toBeGreaterThan(0);
    }
  });

  it("playbook.get returns non-null for all six judgment nodes on first access (lazy seeding)", async () => {
    const improvementRepo = repositoryManager.getImprovementRepository();
    for (const nodeId of judgmentNodes) {
      const playbook = await improvementRepo.getPlaybook(nodeId);
      expect(playbook, `${nodeId} playbook should be seeded on first access`).toBeDefined();
      expect(playbook!.nodeId).toBe(nodeId);
      expect(playbook!.items.length, `${nodeId} playbook should have seeded items`).toBeGreaterThan(0);
    }
  });

  it("seeded playbooks are persisted across separate accesses", async () => {
    const improvementRepo = repositoryManager.getImprovementRepository();
    const pb1 = await improvementRepo.getPlaybook("block_classifier");
    const itemCount1 = pb1!.items.length;
    const pb2 = await improvementRepo.getPlaybook("block_classifier");
    const itemCount2 = pb2!.items.length;
    expect(itemCount2).toBe(itemCount1);
    expect(pb2!.items[0]!.text).toEqual(pb1!.items[0]!.text);
  });
});
