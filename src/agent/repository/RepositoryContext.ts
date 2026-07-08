import type { RepositoryBackend } from "./RepositoryManager.js";

export interface RepositoryContext {
  backend: RepositoryBackend;
  workspaceId?: string;
  projectId?: string;
  runId?: string;
}
