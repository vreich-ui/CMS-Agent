import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import { BlobWorkspaceRepository } from "../../src/agent/repository/blobs/BlobWorkspaceRepository.js";
import { BlobExecutionRepository } from "../../src/agent/repository/blobs/BlobExecutionRepository.js";
import { BlobArtifactRepository } from "../../src/agent/repository/blobs/BlobArtifactRepository.js";
import { BlobLearningRepository } from "../../src/agent/repository/blobs/BlobLearningRepository.js";
import { BlobUsageRepository } from "../../src/agent/repository/blobs/BlobUsageRepository.js";

const blobData = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@netlify/blobs", () => ({
  getStore: vi.fn(() => ({
    get: vi.fn(async (key: string) => blobData.has(key) ? structuredClone(blobData.get(key)) : null),
    setJSON: vi.fn(async (key: string, value: unknown) => {
      blobData.set(key, structuredClone(value));
      return { modified: true, etag: `etag-${key}` };
    }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({
      blobs: [...blobData.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: `etag-${key}` })),
      directories: []
    }))
  }))
}));

describe("Blob repositories", () => {
  beforeEach(() => blobData.clear());

  it("RepositoryManager returns Blob-backed repositories for blobs backend", () => {
    const manager = new RepositoryManager({ backend: "blobs" });

    expect(manager.getWorkspaceRepository()).toBeInstanceOf(BlobWorkspaceRepository);
    expect(manager.getExecutionRepository()).toBeInstanceOf(BlobExecutionRepository);
    expect(manager.getArtifactRepository()).toBeInstanceOf(BlobArtifactRepository);
    expect(manager.getLearningRepository()).toBeInstanceOf(BlobLearningRepository);
    expect(manager.getUsageRepository()).toBeInstanceOf(BlobUsageRepository);
  });

  it("persists update_node_prompt changes across new repository instances", async () => {
    const first = new RepositoryManager({ backend: "blobs" }).getWorkspaceRepository();
    await first.updateNodePrompt("input_triage", "Persist this prompt in Netlify Blobs.");

    const second = new RepositoryManager({ backend: "blobs" }).getWorkspaceRepository();
    await expect(second.getNode("input_triage")).resolves.toMatchObject({
      id: "input_triage",
      prompt: "Persist this prompt in Netlify Blobs."
    });
    expect(blobData.has("workspace/current.json")).toBe(true);
  });
});

// C-1 (T-1) — the blob learning repository had no test, which is how a read that scanned a prefix
// nothing ever wrote to survived. These pin BOTH halves of the fix: observations come from the
// workspace document, and a conversation-turn ledger cannot be mistaken for one.
describe("BlobLearningRepository observations vs conversation-turn ledgers", () => {
  beforeEach(() => blobData.clear());

  const workspaceDouble = () => {
    const observations = [
      { id: "obs_real", observation: "a real observation", status: "active", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "obs_old", observation: "an archived observation", status: "archived", createdAt: "2026-08-01T00:00:00.000Z" }
    ];
    return { listObservations: async (options?: { includeArchived?: boolean }) => options?.includeArchived ? observations : observations.filter((o) => o.status !== "archived") } as never;
  };

  it("reads observations from the workspace document, not from a blob prefix", async () => {
    const repo = new BlobLearningRepository(workspaceDouble());
    expect((await repo.listObservations()).map((o) => o.id)).toEqual(["obs_real"]);
    expect((await repo.listObservations({ includeArchived: true })).map((o) => o.id)).toEqual(["obs_real", "obs_old"]);
  });

  it("keeps returning the real observations once conversation-turn ledgers exist", async () => {
    const repo = new BlobLearningRepository(workspaceDouble());
    await repo.recordConversationTurnSupersession({ projectId: "platform", conversationId: "chat_1", supersessionId: "sup_1", recordedAt: "2026-09-02T00:00:00.000Z" } as never);
    await repo.recordConversationTurnSupersession({ projectId: "platform", conversationId: "chat_2", supersessionId: "sup_2", recordedAt: "2026-09-02T00:00:01.000Z" } as never);

    // One ledger used to hide the real observations; two used to throw on the missing createdAt.
    expect((await repo.listObservations()).map((o) => o.id)).toEqual(["obs_real"]);
    expect((await repo.listConversationTurnSupersessions({ projectId: "platform", conversationId: "chat_1" })).map((s) => s.supersessionId)).toEqual(["sup_1"]);
  });

  it("stores ledgers outside the learning/ prefix entirely", async () => {
    const repo = new BlobLearningRepository(workspaceDouble());
    await repo.recordConversationTurnReference({ projectId: "platform", conversationId: "chat_1", referenceId: "ref_1", turnId: "turn_1", recordedAt: "2026-09-02T00:00:00.000Z" } as never);
    const keys = [...blobData.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith("conversation-turn-gc/")).toBe(true);
    expect(keys.some((key) => key.startsWith("learning/"))).toBe(false);
  });
});
