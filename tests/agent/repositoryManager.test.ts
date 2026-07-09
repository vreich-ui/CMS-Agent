import { describe, expect, expectTypeOf, it } from "vitest";
import type { RecordEnvelope } from "../../src/agent/repository/RecordEnvelope.js";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import type { RepositoryContext } from "../../src/agent/repository/RepositoryContext.js";
import { MemoryArtifactRepository } from "../../src/agent/repository/memory/MemoryArtifactRepository.js";
import { MemoryExecutionRepository } from "../../src/agent/repository/memory/MemoryExecutionRepository.js";
import { MemoryLearningRepository } from "../../src/agent/repository/memory/MemoryLearningRepository.js";
import { MemoryUsageRepository } from "../../src/agent/repository/memory/MemoryUsageRepository.js";
import { MemoryWorkspaceRepository } from "../../src/agent/repository/memory/MemoryWorkspaceRepository.js";

describe("RepositoryManager", () => {
  it("defaults repository context to the memory backend", () => {
    const manager = new RepositoryManager();

    expect(manager.getContext()).toEqual({ backend: "memory" });
  });

  it("keeps optional repository context fields available for future scoping", () => {
    const context: RepositoryContext = { backend: "memory", workspaceId: "workspace-a", projectId: "project-a", runId: "run-a" };
    const manager = new RepositoryManager(context);

    expect(manager.getContext()).toEqual(context);
  });

  it("returns memory repositories for the memory backend", () => {
    const manager = new RepositoryManager({ backend: "memory" });

    expect(manager.getWorkspaceRepository()).toBeInstanceOf(MemoryWorkspaceRepository);
    expect(manager.getExecutionRepository()).toBeInstanceOf(MemoryExecutionRepository);
    expect(manager.getArtifactRepository()).toBeInstanceOf(MemoryArtifactRepository);
    expect(manager.getLearningRepository()).toBeInstanceOf(MemoryLearningRepository);
    expect(manager.getUsageRepository()).toBeInstanceOf(MemoryUsageRepository);
  });

  it("keeps json configured backend mapped to memory repositories as a placeholder", () => {
    const manager = new RepositoryManager({ backend: "json" });

    expect(manager.getWorkspaceRepository()).toBeInstanceOf(MemoryWorkspaceRepository);
    expect(manager.getExecutionRepository()).toBeInstanceOf(MemoryExecutionRepository);
    expect(manager.getArtifactRepository()).toBeInstanceOf(MemoryArtifactRepository);
    expect(manager.getUsageRepository()).toBeInstanceOf(MemoryUsageRepository);
  });

  it("returns healthy memory repository health for every repository", async () => {
    const manager = new RepositoryManager({ backend: "memory" });

    await expect(manager.getRepositoryHealth()).resolves.toEqual({
      backend: "memory",
      storageHealth: "healthy",
      workspaceVersion: 0,
      workspace: { backend: "memory", readable: true, writable: true, version: "memory.v1" },
      execution: { backend: "memory", readable: true, writable: true, version: "memory.v1" },
      artifact: { backend: "memory", readable: true, writable: true, version: "memory.v1" },
      learning: { backend: "memory", readable: true, writable: true, version: "memory.v1" },
      usage: { backend: "memory", readable: true, writable: true, version: "memory.v1" }
    });
  });

  it("repository health methods report expected safe metadata", async () => {
    const manager = new RepositoryManager({ backend: "memory" });

    for (const repository of [
      manager.getWorkspaceRepository(),
      manager.getExecutionRepository(),
      manager.getArtifactRepository(),
      manager.getLearningRepository(),
      manager.getUsageRepository()
    ]) {
      await expect(repository.health()).resolves.toEqual({ backend: "memory", readable: true, writable: true, version: "memory.v1" });
    }
  });

  it("RecordEnvelope preserves generic data typing", () => {
    type WorkflowRunRecord = { runId: string; dryRun: true };
    const envelope: RecordEnvelope<WorkflowRunRecord> = {
      id: "workflow-run-1",
      record_type: "workflow_run",
      schema_version: "workflow_run.v1",
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
      data: { runId: "run-a", dryRun: true }
    };

    expect(envelope.data.runId).toBe("run-a");
    expectTypeOf(envelope.data).toEqualTypeOf<WorkflowRunRecord>();
  });
});
