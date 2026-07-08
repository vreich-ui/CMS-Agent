import type { LearningObservation } from "../../mcp/workspace/store.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface LearningRepository {
  recordObservation(observation: string, metadata?: Record<string, unknown>): Promise<LearningObservation>;
  listObservations(): Promise<LearningObservation[]>;
  health(): Promise<RepositoryHealth>;
}
