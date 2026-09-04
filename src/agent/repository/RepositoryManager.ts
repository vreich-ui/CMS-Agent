import { z } from "zod";
import type { RepositoryContext } from "./RepositoryContext.js";
import type { RepositoryHealth } from "./RepositoryHealth.js";
import type { ArtifactRepository } from "./interfaces/ArtifactRepository.js";
import type { ExecutionRepository } from "./interfaces/ExecutionRepository.js";
import type { LearningRepository } from "./interfaces/LearningRepository.js";
import type { ProjectRepository } from "./interfaces/ProjectRepository.js";
import type { UsageRepository } from "./interfaces/UsageRepository.js";
import type { NodeTimingRepository } from "./interfaces/NodeTimingRepository.js";
import type { DriverHealthRepository } from "./interfaces/DriverHealthRepository.js";
import type { SkillRepository } from "./interfaces/SkillRepository.js";
import type { WorkspaceRepository } from "./interfaces/WorkspaceRepository.js";
import type { ChangeRepository } from "./interfaces/ChangeRepository.js";
import type { EvaluationRepository } from "./interfaces/EvaluationRepository.js";
import type { ImprovementRepository } from "./interfaces/ImprovementRepository.js";
import type { ConversationTurnRepository } from "./interfaces/ConversationTurnRepository.js";
import { BlobArtifactRepository } from "./blobs/BlobArtifactRepository.js";
import { BlobEvaluationRepository } from "./blobs/BlobEvaluationRepository.js";
import { BlobImprovementRepository } from "./blobs/BlobImprovementRepository.js";
import { BlobExecutionRepository } from "./blobs/BlobExecutionRepository.js";
import { BlobLearningRepository } from "./blobs/BlobLearningRepository.js";
import { BlobProjectRepository } from "./blobs/BlobProjectRepository.js";
import { BlobUsageRepository } from "./blobs/BlobUsageRepository.js";
import { BlobNodeTimingRepository } from "./blobs/BlobNodeTimingRepository.js";
import { BlobDriverHealthRepository } from "./blobs/BlobDriverHealthRepository.js";
import { BlobWorkspaceRepository } from "./blobs/BlobWorkspaceRepository.js";
import { BlobChangeRepository } from "./blobs/BlobChangeRepository.js";
import { BlobConversationTurnRepository } from "./blobs/BlobConversationTurnRepository.js";
import { BlobSkillRepository, MemorySkillRepository } from "../skills/skillRegistry.js";
import { MemoryArtifactRepository } from "./memory/MemoryArtifactRepository.js";
import { MemoryExecutionRepository } from "./memory/MemoryExecutionRepository.js";
import { MemoryLearningRepository } from "./memory/MemoryLearningRepository.js";
import { MemoryProjectRepository } from "./memory/MemoryProjectRepository.js";
import { MemoryUsageRepository } from "./memory/MemoryUsageRepository.js";
import { MemoryNodeTimingRepository } from "./memory/MemoryNodeTimingRepository.js";
import { MemoryDriverHealthRepository } from "./memory/MemoryDriverHealthRepository.js";
import { MemoryWorkspaceRepository } from "./memory/MemoryWorkspaceRepository.js";
import { MemoryChangeRepository } from "./memory/MemoryChangeRepository.js";
import { MemoryEvaluationRepository } from "./memory/MemoryEvaluationRepository.js";
import { MemoryImprovementRepository } from "./memory/MemoryImprovementRepository.js";
import { MemoryConversationTurnRepository } from "./memory/MemoryConversationTurnRepository.js";

export type RepositoryBackend = "memory" | "json" | "blobs" | "gcs";

export const repositoryConfigSchema = z.object({
  backend: z.enum(["memory", "json", "blobs", "gcs"]).default("memory"),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  runId: z.string().min(1).optional()
}).strict();

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
/** WHICH BUILD IS ANSWERING. Every field is non-secret and identifies code, never configuration.
 *
 *  This exists because "is the fix live?" was unanswerable from inside the system for three days.
 *  Cloud Build reported success, `gcloud run services describe` reported the new image, the console
 *  showed 100% traffic on the newest revision — and the behaviour on the wire was still the old
 *  code's. Every one of those signals is about the SERVICE's desired state; none of them is the
 *  answer to "what executed this request". Only the process can answer that, so now it does.
 *
 *  `revision` costs nothing to populate: Cloud Run sets K_REVISION in every container it starts, so
 *  this identifies the exact revision that served THIS call with no deploy-time wiring at all, and
 *  the revision maps to a commit-tagged image in the console. `gitSha`/`deployedAt` are stamped by
 *  the deploy (SERVICE_GIT_SHA / SERVICE_DEPLOYED_AT) exactly as pdf-tool's render-service does since
 *  T12.19; they read null until that wiring lands, which is honest rather than absent. */
export type PlaneBuildIdentity = {
  revision: string | null;
  service: string | null;
  gitSha: string | null;
  deployedAt: string | null;
};

const planeBuildIdentity = (env: NodeJS.ProcessEnv = process.env): PlaneBuildIdentity => ({
  revision: env.K_REVISION?.trim() || null,
  service: env.K_SERVICE?.trim() || null,
  gitSha: env.SERVICE_GIT_SHA?.trim() || null,
  deployedAt: env.SERVICE_DEPLOYED_AT?.trim() || null
});

export type RepositoryHealthSummary = {
  backend: RepositoryBackend;
  storageHealth: "healthy" | "degraded";
  build: PlaneBuildIdentity;
  workspaceVersion: number;
  workspace: RepositoryHealth;
  execution: RepositoryHealth;
  artifact: RepositoryHealth;
  learning: RepositoryHealth;
  usage: RepositoryHealth;
  nodeTiming: RepositoryHealth;
  // W0 T0.2/T0.3 — the tick ledger / tenant driver-health store. Reported here for the same reason
  // every other store is: a driver-visibility store nobody can write is exactly the silent failure
  // the wave exists to end.
  driverHealth: RepositoryHealth;
  project: RepositoryHealth;
  skill: RepositoryHealth;
  change: RepositoryHealth;
  evaluation: RepositoryHealth;
  improvement: RepositoryHealth;
  conversationTurns: RepositoryHealth;
};

const resolveBackend = (context: Partial<RepositoryContext>) => context.backend ?? (process.env.WORKSPACE_STORE as RepositoryBackend | undefined) ?? "memory";
const resolveContext = (context: Partial<RepositoryContext> = {}): RepositoryContext => repositoryConfigSchema.parse({ backend: resolveBackend(context), workspaceId: context.workspaceId, projectId: context.projectId, runId: context.runId });

export class RepositoryManager {
  private readonly context: RepositoryContext;
  private readonly workspaceRepository: WorkspaceRepository;
  private readonly executionRepository: ExecutionRepository;
  private readonly artifactRepository: ArtifactRepository;
  private readonly learningRepository: LearningRepository;
  private readonly usageRepository: UsageRepository;
  private readonly nodeTimingRepository: NodeTimingRepository;
  private readonly driverHealthRepository: DriverHealthRepository;
  private readonly projectRepository: ProjectRepository;
  private readonly skillRepository: SkillRepository;
  private readonly changeRepository: ChangeRepository;
  private readonly evaluationRepository: EvaluationRepository;
  private readonly improvementRepository: ImprovementRepository;
  private readonly conversationTurnRepository: ConversationTurnRepository;

  constructor(context: Partial<RepositoryContext> = {}) {
    this.context = resolveContext(context);
    // "gcs" reuses the blob repository classes verbatim: they consume the BlobStoreClient surface,
    // and getCmsAgentBlobStore() hands them the GCS transport registered by the entrypoint
    // (registerCmsAgentStoreFactory in blobClient.ts). Same logic, different bytes.
    if (this.context.backend === "blobs" || this.context.backend === "gcs") {
      this.workspaceRepository = new BlobWorkspaceRepository();
      this.executionRepository = new BlobExecutionRepository();
      this.artifactRepository = new BlobArtifactRepository();
      this.learningRepository = new BlobLearningRepository(this.workspaceRepository);
      this.usageRepository = new BlobUsageRepository();
      this.nodeTimingRepository = new BlobNodeTimingRepository();
      this.driverHealthRepository = new BlobDriverHealthRepository();
      this.projectRepository = new BlobProjectRepository();
      this.skillRepository = new BlobSkillRepository();
      this.changeRepository = new BlobChangeRepository();
      this.evaluationRepository = new BlobEvaluationRepository();
      this.improvementRepository = new BlobImprovementRepository();
      this.conversationTurnRepository = new BlobConversationTurnRepository();
      this.workspaceRepository.attachChangeSink?.(this.changeRepository);
      return;
    }

    this.workspaceRepository = new MemoryWorkspaceRepository(this.context.backend);
    this.executionRepository = new MemoryExecutionRepository(this.context.backend);
    this.artifactRepository = new MemoryArtifactRepository(this.executionRepository, this.context.backend);
    this.learningRepository = new MemoryLearningRepository(this.workspaceRepository, this.context.backend);
    this.usageRepository = new MemoryUsageRepository(this.context.backend);
    this.nodeTimingRepository = new MemoryNodeTimingRepository(this.context.backend);
    this.driverHealthRepository = new MemoryDriverHealthRepository(this.context.backend);
    this.projectRepository = new MemoryProjectRepository(this.context.backend);
    this.skillRepository = new MemorySkillRepository(this.context.backend);
    this.changeRepository = new MemoryChangeRepository(this.context.backend);
    this.evaluationRepository = new MemoryEvaluationRepository(this.context.backend);
    this.improvementRepository = new MemoryImprovementRepository(this.context.backend);
    this.conversationTurnRepository = new MemoryConversationTurnRepository(this.context.backend);
    this.workspaceRepository.attachChangeSink?.(this.changeRepository);
  }

  getContext(): RepositoryContext { return { ...this.context }; }
  getWorkspaceRepository(): WorkspaceRepository { return this.workspaceRepository; }
  getExecutionRepository(): ExecutionRepository { return this.executionRepository; }
  getArtifactRepository(): ArtifactRepository { return this.artifactRepository; }
  getLearningRepository(): LearningRepository { return this.learningRepository; }
  getUsageRepository(): UsageRepository { return this.usageRepository; }
  getNodeTimingRepository(): NodeTimingRepository { return this.nodeTimingRepository; }
  // W0 T0.2/T0.3 — the tick ledger and per-tenant background-dispatch stamp.
  getDriverHealthRepository(): DriverHealthRepository { return this.driverHealthRepository; }
  getProjectRepository(): ProjectRepository { return this.projectRepository; }
  getSkillRepository(): SkillRepository { return this.skillRepository; }
  getChangeRepository(): ChangeRepository { return this.changeRepository; }
  getEvaluationRepository(): EvaluationRepository { return this.evaluationRepository; }
  getImprovementRepository(): ImprovementRepository { return this.improvementRepository; }
  getConversationTurnRepository(): ConversationTurnRepository { return this.conversationTurnRepository; }

  // G3 (T-2 re-run, run_1785405350649_9u5mjz): the project repository's own health() has always
  // existed, but this summary never once called it — the project registry had NO representation in
  // the workspace-wide health check at all. It now does, which is what actually surfaces
  // ProjectRepository.health()'s objectDialect findings (see BlobProjectRepository.health()) to an
  // operator or startup check reading repository.get_health instead of leaving them reachable only by
  // calling project repo health directly.
  async getRepositoryHealth(): Promise<RepositoryHealthSummary> {
    const [workspace, execution, artifact, learning, usage, nodeTiming, driverHealth, project, skill, change, evaluation, improvement, conversationTurns] = await Promise.all([
      this.workspaceRepository.health(),
      this.executionRepository.health(),
      this.artifactRepository.health(),
      this.learningRepository.health(),
      this.usageRepository.health(),
      this.nodeTimingRepository.health(),
      this.driverHealthRepository.health(),
      this.projectRepository.health(),
      this.skillRepository.health(),
      this.changeRepository.health(),
      this.evaluationRepository.health(),
      this.improvementRepository.health(),
      this.conversationTurnRepository.health()
    ]);
    const storageHealth = [workspace, execution, artifact, learning, usage, nodeTiming, driverHealth, project, skill, change, evaluation, improvement, conversationTurns].every((status) => status.readable && status.writable) ? "healthy" : "degraded";
    return { backend: this.context.backend, storageHealth, build: planeBuildIdentity(), workspaceVersion: await this.workspaceRepository.getWorkspaceVersion(), workspace, execution, artifact, learning, usage, nodeTiming, driverHealth, project, skill, change, evaluation, improvement, conversationTurns };
  }
}
