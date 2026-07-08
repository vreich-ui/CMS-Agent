import { z } from "zod";
import type { RepositoryContext } from "./RepositoryContext.js";
import type { RepositoryHealth } from "./RepositoryHealth.js";
import type { ArtifactRepository } from "./interfaces/ArtifactRepository.js";
import type { ExecutionRepository } from "./interfaces/ExecutionRepository.js";
import type { LearningRepository } from "./interfaces/LearningRepository.js";
import type { UsageRepository } from "./interfaces/UsageRepository.js";
import type { WorkspaceRepository } from "./interfaces/WorkspaceRepository.js";
import { MemoryArtifactRepository } from "./memory/MemoryArtifactRepository.js";
import { MemoryExecutionRepository } from "./memory/MemoryExecutionRepository.js";
import { MemoryLearningRepository } from "./memory/MemoryLearningRepository.js";
import { MemoryUsageRepository } from "./memory/MemoryUsageRepository.js";
import { MemoryWorkspaceRepository } from "./memory/MemoryWorkspaceRepository.js";

export type RepositoryBackend = "memory" | "json" | "blobs";

export const repositoryConfigSchema = z.object({
  backend: z.enum(["memory", "json", "blobs"]).default("memory"),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  runId: z.string().min(1).optional()
}).strict();

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
export type RepositoryHealthSummary = {
  workspace: RepositoryHealth;
  execution: RepositoryHealth;
  artifact: RepositoryHealth;
  learning: RepositoryHealth;
  usage: RepositoryHealth;
};

const resolveContext = (context: Partial<RepositoryContext> = {}): RepositoryContext => repositoryConfigSchema.parse({ backend: context.backend ?? "memory", workspaceId: context.workspaceId, projectId: context.projectId, runId: context.runId });

export class RepositoryManager {
  private readonly context: RepositoryContext;
  private readonly workspaceRepository: WorkspaceRepository;
  private readonly executionRepository: ExecutionRepository;
  private readonly artifactRepository: ArtifactRepository;
  private readonly learningRepository: LearningRepository;
  private readonly usageRepository: UsageRepository;

  constructor(context: Partial<RepositoryContext> = {}) {
    this.context = resolveContext(context);
    this.workspaceRepository = new MemoryWorkspaceRepository(this.context.backend);
    this.executionRepository = new MemoryExecutionRepository(this.context.backend);
    this.artifactRepository = new MemoryArtifactRepository(this.executionRepository, this.context.backend);
    this.learningRepository = new MemoryLearningRepository(this.workspaceRepository, this.context.backend);
    this.usageRepository = new MemoryUsageRepository(this.context.backend);
  }

  getContext(): RepositoryContext { return { ...this.context }; }
  getWorkspaceRepository(): WorkspaceRepository { return this.workspaceRepository; }
  getExecutionRepository(): ExecutionRepository { return this.executionRepository; }
  getArtifactRepository(): ArtifactRepository { return this.artifactRepository; }
  getLearningRepository(): LearningRepository { return this.learningRepository; }
  getUsageRepository(): UsageRepository { return this.usageRepository; }

  async getRepositoryHealth(): Promise<RepositoryHealthSummary> {
    const [workspace, execution, artifact, learning, usage] = await Promise.all([
      this.workspaceRepository.health(),
      this.executionRepository.health(),
      this.artifactRepository.health(),
      this.learningRepository.health(),
      this.usageRepository.health()
    ]);
    return { workspace, execution, artifact, learning, usage };
  }
}

export const repositoryManager = new RepositoryManager({ backend: "memory" });
