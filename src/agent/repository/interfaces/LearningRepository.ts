import type { LearningObservation } from "../../mcp/workspace/store.js";

export interface LearningRepository {
  recordObservation(observation: string, metadata?: Record<string, unknown>): Promise<LearningObservation>;
  listObservations(): Promise<LearningObservation[]>;
}
