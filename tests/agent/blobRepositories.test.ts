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
