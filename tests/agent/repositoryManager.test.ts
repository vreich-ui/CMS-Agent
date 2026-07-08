import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import { MemoryArtifactRepository } from "../../src/agent/repository/memory/MemoryArtifactRepository.js";
import { MemoryExecutionRepository } from "../../src/agent/repository/memory/MemoryExecutionRepository.js";
import { MemoryLearningRepository } from "../../src/agent/repository/memory/MemoryLearningRepository.js";
import { MemoryUsageRepository } from "../../src/agent/repository/memory/MemoryUsageRepository.js";
import { MemoryWorkspaceRepository } from "../../src/agent/repository/memory/MemoryWorkspaceRepository.js";

describe("RepositoryManager", () => {
  it("returns memory repositories for the memory backend", () => {
    const manager = new RepositoryManager({ backend: "memory" });

    expect(manager.getWorkspaceRepository()).toBeInstanceOf(MemoryWorkspaceRepository);
    expect(manager.getExecutionRepository()).toBeInstanceOf(MemoryExecutionRepository);
    expect(manager.getArtifactRepository()).toBeInstanceOf(MemoryArtifactRepository);
    expect(manager.getLearningRepository()).toBeInstanceOf(MemoryLearningRepository);
    expect(manager.getUsageRepository()).toBeInstanceOf(MemoryUsageRepository);
  });

  it("keeps json and blobs configured backends mapped to memory repositories in this PR", () => {
    for (const backend of ["json", "blobs"] as const) {
      const manager = new RepositoryManager({ backend });

      expect(manager.getWorkspaceRepository()).toBeInstanceOf(MemoryWorkspaceRepository);
      expect(manager.getExecutionRepository()).toBeInstanceOf(MemoryExecutionRepository);
      expect(manager.getArtifactRepository()).toBeInstanceOf(MemoryArtifactRepository);
      expect(manager.getUsageRepository()).toBeInstanceOf(MemoryUsageRepository);
    }
  });
});
