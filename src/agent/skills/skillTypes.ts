import type { WorkspaceRiskLevel } from "../workspace/nodeTypes.js";
import type { WorkspaceMutationMeta } from "../mcp/workspace/store.js";
import type { PolicyScope } from "../scope/policyScope.js";

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
  /**
   * C2 (part 2) — WHAT THIS SKILL APPLIES TO. Absent means the fleet: it applies wherever it is
   * assigned, which is every skill's behaviour before this field existed and therefore the only
   * default that changes nothing.
   *
   * A scope NARROWS an assignment; it never creates one. A node still has to assign the skill
   * (`skill_assign`) — scope decides whether that assignment survives at dispatch, on this run, on
   * this site. So a skill scoped to a site nobody assigned it on is inert, not implicit.
   */
  scope?: PolicyScope;
  /**
   * C2 (part 2) — MUTUAL EXCLUSION. Two skills in the same family are two versions of one job (the
   * DTC and foundation cuts of `organization_narrative`, say), and exactly one of them may reach a
   * dispatch. Of the family members that apply, the narrowest wins; an equal-specificity tie is a
   * configuration error that is named rather than resolved by sort order.
   *
   * Absent means the skill belongs to no family and never displaces, or is displaced by, anything.
   */
  family?: string;
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
  // Why each denied tool was denied, keyed by toolId, straight from the single tool authority
  // (toolResolver.evaluateToolsForNode). A caller has to be able to tell a MISCONFIGURATION
  // ("node_tool_not_allowed") from a gate working as designed ("approval_required") — treating them
  // alike is how the approval gate ends up reported as a defect.
  deniedToolReasons: Record<string, string[]>;
  riskLevel: WorkspaceRiskLevel;
  conflicts: SkillConflict[];
  memoryPolicies: SkillMemoryPolicy[];
  requiredArtifacts: string[];
  producedArtifacts: string[];
};
