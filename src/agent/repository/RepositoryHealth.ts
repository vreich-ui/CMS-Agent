import type { RepositoryBackend } from "./RepositoryManager.js";

export interface RepositoryHealth {
  backend: RepositoryBackend;
  writable: boolean;
  readable: boolean;
  version: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export const healthyRepositoryStatus = (backend: RepositoryBackend): RepositoryHealth => ({
  backend,
  writable: true,
  readable: true,
  version: "memory.v1"
});
