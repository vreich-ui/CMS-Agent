import type { WorkspaceStore } from "../../mcp/workspace/store.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

export interface WorkspaceRepository extends WorkspaceStore {
  health(): Promise<RepositoryHealth>;
}
