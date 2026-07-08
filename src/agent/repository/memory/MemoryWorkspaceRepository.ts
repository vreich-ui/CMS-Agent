import { InMemoryWorkspaceStore } from "../../mcp/workspace/store.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";

export class MemoryWorkspaceRepository extends InMemoryWorkspaceStore implements WorkspaceRepository {}
