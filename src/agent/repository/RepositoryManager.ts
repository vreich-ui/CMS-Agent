import { z } from "zod";
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
  backend: z.enum(["memory", "json", "blobs"]).default("memory")
}).strict();

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

const resolveConfig = (config: Partial<RepositoryConfig> = {}): RepositoryConfig => repositoryConfigSchema.parse({ backend: config.backend ?? "memory" });

export class RepositoryManager {
  private readonly workspaceRepository: WorkspaceRepository;
  private readonly executionRepository: ExecutionRepository;
  private readonly artifactRepository: ArtifactRepository;
  private readonly learningRepository: LearningRepository;
  private readonly usageRepository: UsageRepository;

  constructor(config: Partial<RepositoryConfig> = {}) {
    resolveConfig(config);
    this.workspaceRepository = new MemoryWorkspaceRepository();
    this.executionRepository = new MemoryExecutionRepository();
    this.artifactRepository = new MemoryArtifactRepository(this.executionRepository);
    this.learningRepository = new MemoryLearningRepository(this.workspaceRepository);
    this.usageRepository = new MemoryUsageRepository();
  }

  getWorkspaceRepository(): WorkspaceRepository { return this.workspaceRepository; }
  getExecutionRepository(): ExecutionRepository { return this.executionRepository; }
  getArtifactRepository(): ArtifactRepository { return this.artifactRepository; }
  getLearningRepository(): LearningRepository { return this.learningRepository; }
  getUsageRepository(): UsageRepository { return this.usageRepository; }
}

export const repositoryManager = new RepositoryManager({ backend: "memory" });
