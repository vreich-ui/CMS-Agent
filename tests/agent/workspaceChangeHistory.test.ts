import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import { MemoryChangeRepository } from "../../src/agent/repository/memory/MemoryChangeRepository.js";
import { WorkspaceStateStore, createDefaultWorkspaceDocument, workspaceDocumentSchema } from "../../src/agent/mcp/workspace/store.js";
import { listWorkspaceNodes } from "../../src/agent/workspace/nodes.js";

const setup = () => {
  const manager = new RepositoryManager({ backend: "memory" });
  return { workspace: manager.getWorkspaceRepository(), changes: manager.getChangeRepository() };
};

const latestEvent = async (changes: ReturnType<typeof setup>["changes"]) => (await changes.listEvents({ limit: 1 })).events[0];

describe("workspace change history", () => {
  it("records an immutable, attributed change event and revision for a prompt update", async () => {
    const { workspace, changes } = setup();
    const before = await workspace.getNode("input_triage");
    await workspace.updateNodePrompt("input_triage", "Updated triage prompt.", {
      actor: { kind: "human", id: "vreich@kugelbrands.com" },
      source: "ui",
      reason: "clarify intake questions",
      correlation: { requestId: "req_test_1" }
    });

    const event = await latestEvent(changes);
    expect(event.type).toBe("node.prompt_updated");
    expect(event.operation).toBe("update");
    expect(event.target).toEqual({ type: "node", id: "input_triage" });
    expect(event.actor).toEqual({ kind: "human", id: "vreich@kugelbrands.com" });
    expect(event.source).toBe("ui");
    expect(event.reason).toBe("clarify intake questions");
    expect(event.correlation).toEqual({ requestId: "req_test_1" });
    expect(event.riskLevel).toBe(before?.riskLevel);
    expect((event.before as { prompt: string }).prompt).toBe(before?.prompt);
    expect((event.after as { prompt: string }).prompt).toBe("Updated triage prompt.");
    expect(event.parentRevisionId).toBeUndefined();
    expect(event.resultingRevisionId).toBeDefined();

    const revision = await changes.getRevision(event.resultingRevisionId!);
    expect(revision?.workspaceVersion).toBe(event.workspaceVersion);
    expect(revision?.nodes.find((node) => node.id === "input_triage")?.prompt).toBe("Updated triage prompt.");
    expect(await workspace.getCurrentRevisionId()).toBe(event.resultingRevisionId);
  });

  it("chains revisions through parentRevisionId", async () => {
    const { workspace, changes } = setup();
    await workspace.updateNodePrompt("input_triage", "First.", { actor: "agent-a" });
    const first = await latestEvent(changes);
    await workspace.updateNodePrompt("input_triage", "Second.", { actor: "agent-a" });
    const second = await latestEvent(changes);
    expect(second.parentRevisionId).toBe(first.resultingRevisionId);
    expect(second.resultingRevisionId).not.toBe(first.resultingRevisionId);
  });

  it("accepts a matching baseRevisionId and rejects a stale one with a typed conflict", async () => {
    const { workspace } = setup();
    await workspace.updateNodePrompt("input_triage", "First.", {});
    const base = await workspace.getCurrentRevisionId();
    await workspace.updateNodePrompt("input_triage", "Second.", { baseRevisionId: base });
    await expect(workspace.updateNodePrompt("input_triage", "Third.", { baseRevisionId: base }))
      .rejects.toThrow(/^revision_conflict: expected /);
  });

  it("keeps the legacy expectedWorkspaceVersion conflict working alongside", async () => {
    const { workspace } = setup();
    await workspace.updateNodePrompt("input_triage", "First.", { expectedWorkspaceVersion: 0 });
    await expect(workspace.updateNodePrompt("input_triage", "Second.", { expectedWorkspaceVersion: 0 }))
      .rejects.toThrow(/^workspace_version_conflict: expected 0/);
  });

  it("records events without revisions for non-structural mutations", async () => {
    const { workspace, changes } = setup();
    await workspace.updateNodePrompt("input_triage", "Structural.", {});
    const structural = await latestEvent(changes);
    await workspace.saveStageOutput("input_triage", { artifact: "content_source.v1" });
    const recordEvent = await latestEvent(changes);
    expect(recordEvent.type).toBe("stage.output_saved");
    expect(recordEvent.operation).toBe("record");
    expect(recordEvent.actor).toEqual({ kind: "system" });
    expect(recordEvent.source).toBe("system");
    expect(recordEvent.resultingRevisionId).toBe(structural.resultingRevisionId);
    expect((await changes.listRevisions()).length).toBe(1);
  });

  it("excludes sensitive values from before/after snapshots and revisions while keeping prompts", async () => {
    const { workspace, changes } = setup();
    await workspace.updateNode("input_triage", { metadata: { apiKey: "raw-key-123", nested: { authorization: "Bearer raw" }, safe: "keep-me" } }, { actor: "agent-a" });
    const event = await latestEvent(changes);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("raw-key-123");
    expect(serialized).not.toContain("Bearer raw");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("keep-me");
    const revision = await changes.getRevision(event.resultingRevisionId!);
    expect(JSON.stringify(revision)).not.toContain("raw-key-123");
    expect(revision?.nodes.find((node) => node.id === "input_triage")?.prompt).toBeTruthy();
  });

  it("maps legacy string actors and falls back reason to summary", async () => {
    const { workspace, changes } = setup();
    await workspace.updateNodePrompt("input_triage", "Legacy actor.", { actor: "workflow-agent", summary: "legacy summary" });
    const event = await latestEvent(changes);
    expect(event.actor).toEqual({ kind: "agent", label: "workflow-agent" });
    expect(event.reason).toBe("legacy summary");
  });

  it("parses documents persisted before change history existed (migration defaults)", () => {
    const legacy = {
      schemaVersion: 1,
      workspaceVersion: 7,
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{ id: "n1", name: "N1", prompt: "p", updatedAt: "2026-01-01T00:00:00.000Z" }],
      stageOutputs: [],
      learningObservations: []
    };
    const parsed = workspaceDocumentSchema.parse(legacy);
    expect(parsed.relationships).toEqual([]);
    expect(parsed.versions).toEqual([]);
    expect(parsed.currentRevisionId).toBeUndefined();
  });

  it("merges legacy versions[] with new revisions in getVersions and stops growing versions[]", async () => {
    const legacyDocument = createDefaultWorkspaceDocument();
    legacyDocument.workspaceVersion = 3;
    legacyDocument.versions = [{ workspaceVersion: 3, createdAt: "2026-01-01T00:00:00.000Z", summary: "legacy snapshot", nodes: structuredClone(legacyDocument.nodes) }];
    const store = new WorkspaceStateStore(legacyDocument);
    store.attachChangeSink(new MemoryChangeRepository());

    await store.updateNodePrompt("input_triage", "After migration.", {});
    const versions = await store.getVersions();
    expect(versions.map((snapshot) => snapshot.workspaceVersion)).toEqual([3, 4]);
    expect(versions[0].summary).toBe("legacy snapshot");
    expect((await store.exportWorkspace()).versions).toHaveLength(1);
  });

  it("restores a deleted node as a new forward mutation without rewriting history", async () => {
    const { workspace, changes } = setup();
    const custom = { ...listWorkspaceNodes()[0], id: "custom_restore", name: "Custom", prompt: "original prompt", dependsOn: [], requiredInputs: [], produces: [], updatedAt: "2026-01-01T00:00:00.000Z" };
    await workspace.createNode(custom, { actor: "agent-a" });
    const createdRevisionId = await workspace.getCurrentRevisionId();
    await workspace.deleteNode("custom_restore", { actor: "agent-a" });
    const eventsBeforeRestore = (await changes.listEvents({ limit: 200 })).events.length;

    const revision = await changes.getRevision(createdRevisionId!);
    const snapshot = revision!.nodes.find((node) => node.id === "custom_restore")!;
    await workspace.createNode({ ...snapshot }, { actor: { kind: "human", id: "vreich@kugelbrands.com" }, reason: "restore custom node" }, "node.restored");

    const restoreEvent = await latestEvent(changes);
    expect(restoreEvent.operation).toBe("restore");
    expect(restoreEvent.type).toBe("node.restored");
    expect((await workspace.getNode("custom_restore"))?.prompt).toBe("original prompt");
    // History is append-only: exactly one new event, all prior revisions still readable.
    expect((await changes.listEvents({ limit: 200 })).events.length).toBe(eventsBeforeRestore + 1);
    expect(await changes.getRevision(createdRevisionId!)).toBeDefined();
  });
});
