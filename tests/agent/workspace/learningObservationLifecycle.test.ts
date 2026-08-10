import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// 2.8 (handoff 2026-08-10): lifecycle/archival for learning observations. Nothing is hard-deleted —
// archive is soft (status:"archived" + archivedAt/archivedReason), listObservations excludes archived
// records by default, and a one-off script (scripts/purgeAlignObservations.ts) applies the sunset
// directive against the "[ALIGN" coordination-board records via the same predicate-based repository
// method these tests exercise directly.

// Tools are (re)created inside beforeEach, AFTER resetRepositoryManager(): createWorkspaceTools
// captures the current learningRepository by reference, so a module-level `const tools` built once
// would keep pointing at the pre-reset repository instance and leak state across tests.
let tools: ReturnType<typeof createWorkspaceTools>;
const callTool = async (name: string, input: unknown) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return (await found.execute(input)) as { ok: true; data: any };
};

describe("learning observation lifecycle (2.8)", () => {
  beforeEach(() => {
    resetRepositoryManager();
    tools = createWorkspaceTools({});
  });

  it("learning.archive_observation soft-deletes by id: excluded by default, visible with includeArchived", async () => {
    const recorded = await callTool("learning.record_observation", { observation: "archive-me single" });
    const id = recorded.data.observation.id as string;

    const archived = await callTool("learning.archive_observation", { id, reason: "test archival" });
    expect(archived.data.observation.status).toBe("archived");
    expect(archived.data.observation.archivedAt).toBeTruthy();
    expect(archived.data.observation.archivedReason).toBe("test archival");
    // The record itself is untouched otherwise — it is not deleted.
    expect(archived.data.observation.observation).toBe("archive-me single");

    const defaultList = await callTool("learning.list_observations", {});
    expect(defaultList.data.observations.some((o: any) => o.id === id)).toBe(false);

    const fullList = await callTool("learning.list_observations", { includeArchived: true });
    expect(fullList.data.observations.some((o: any) => o.id === id)).toBe(true);
  });

  it("learning.archive_observations bulk-archives by text prefix, dry-run previews without writing", async () => {
    await callTool("learning.record_observation", { observation: "[ALIGN] coordination note one" });
    await callTool("learning.record_observation", { observation: "[ALIGN] coordination note two" });
    await callTool("learning.record_observation", { observation: "a real editorial learning" });

    const dryRun = await callTool("learning.archive_observations", { textPrefix: "[ALIGN", dryRun: true });
    expect(dryRun.data.dryRun).toBe(true);
    expect(dryRun.data.matched).toBe(2);
    expect(dryRun.data.archived).toBe(0);
    // Dry run wrote nothing — everything is still active.
    expect((await callTool("learning.list_observations", {})).data.observations).toHaveLength(3);

    const applied = await callTool("learning.archive_observations", { textPrefix: "[ALIGN", reason: "sunset directive" });
    expect(applied.data.archived).toBe(2);

    const remaining = await callTool("learning.list_observations", {});
    expect(remaining.data.observations).toHaveLength(1);
    expect(remaining.data.observations[0].observation).toBe("a real editorial learning");

    const everything = await callTool("learning.list_observations", { includeArchived: true });
    expect(everything.data.observations).toHaveLength(3);
    expect(everything.data.observations.filter((o: any) => o.status === "archived")).toHaveLength(2);
  });

  it("archiveObservationsByPredicate (the repository method the purge script calls) matches the script's use of a text-prefix predicate", async () => {
    const learningRepository = repositoryManager.getLearningRepository();
    await learningRepository.recordObservation("[ALIGN] board message", undefined, {});
    await learningRepository.recordObservation("not a coordination message", undefined, {});

    const result = await learningRepository.archiveObservationsByPredicate((observation) => observation.observation.startsWith("[ALIGN"), "purge test");
    expect(result.archived).toBe(1);

    const active = await learningRepository.listObservations();
    expect(active).toHaveLength(1);
    expect(active[0]!.observation).toBe("not a coordination message");
  });

  it("playbook.migrate_observations (2.7) skips archived observations via the same default", async () => {
    const nodeId = "lifecycle_migration_target";
    const recorded = await callTool("learning.record_observation", { observation: "should not migrate once archived", nodeId });
    await callTool("learning.archive_observation", { id: recorded.data.observation.id });

    const migrated = await callTool("playbook.migrate_observations", { dryRun: false });
    const playbook = await callTool("playbook.get", { nodeId });
    // Either no playbook was created for this node, or it does not contain the archived text.
    expect(JSON.stringify(playbook.data.playbook ?? {})).not.toContain("should not migrate once archived");
    expect(typeof migrated.data.migratedObservations).toBe("number");
  });
});
