import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface LearningRepository {
  recordObservation(observation: string, metadata?: Record<string, unknown>, provenance?: { runId?: string; nodeId?: string }): Promise<LearningObservation>;
  listObservations(): Promise<LearningObservation[]>;
  health(): Promise<RepositoryHealth>;
}
