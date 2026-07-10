import type { WorkspaceRiskLevel } from "../workspace/nodeTypes.js";
import type { WorkspaceMutationMeta } from "../mcp/workspace/store.js";

export const skillStatuses = ["draft", "active", "deprecated"] as const;
export type SkillStatus = typeof skillStatuses[number];

export type SkillExample = { name: string; input: unknown; output: unknown; notes?: string };
export type SkillMemoryPolicy = { namespaces: string[]; read: boolean; write: boolean; retention?: string };
export type SkillToolPolicy = { requestedTools: string[]; mutatingToolsRequireApproval: boolean; notes?: string };

export type SkillDefinition = {
  skillId: string;
  name: string;
  description: string;
  version: string;
  status: SkillStatus;
  instructions: string;
  inputSchema: unknown;
  outputSchema: unknown;
  allowedTools: string[];
  requiredArtifacts: string[];
  producedArtifacts: string[];
  examples: SkillExample[];
  preconditions: string[];
  completionCriteria: string[];
  blockerCriteria: string[];
  memoryPolicy: SkillMemoryPolicy;
  toolPolicy: SkillToolPolicy;
  riskLevel: WorkspaceRiskLevel;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SkillVersionSnapshot = { skillId: string; versionId: string; skillVersion: number; createdAt: string; summary?: string; skill: SkillDefinition };
export type SkillEvent = { id: string; type: string; skillId?: string; actor?: string; summary?: string; skillVersion: number; beforeHash?: string; afterHash?: string; createdAt: string };
export type SkillMutationMeta = WorkspaceMutationMeta;
export type SkillListFilters = { status?: SkillStatus; skillIds?: string[] };
export type SkillValidationResult = { valid: boolean; issues: string[] };
export type SkillConflict = { severity: "warning" | "blocker"; source: string; message: string };
export type SkillResolvedPolicy = {
  nodeId: string;
  skillIds: string[];
  instructions: string;
  inputSchema: unknown;
  outputSchema: unknown;
  effectiveTools: string[];
  requestedTools: string[];
  deniedTools: string[];
  riskLevel: WorkspaceRiskLevel;
  conflicts: SkillConflict[];
  memoryPolicies: SkillMemoryPolicy[];
  requiredArtifacts: string[];
  producedArtifacts: string[];
};
