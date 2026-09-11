import type { RepositoryHealth } from "../RepositoryHealth.js";
import type { SkillDefinition, SkillEvent, SkillListFilters, SkillMutationMeta, SkillVersionSnapshot } from "../../skills/skillTypes.js";

export interface SkillRepository {
  health(): Promise<RepositoryHealth>;
  getSkillVersion(): Promise<number>;
  list(filters?: SkillListFilters): Promise<SkillDefinition[]>;
  get(skillId: string): Promise<SkillDefinition | undefined>;
  // F1 — additive top-up for a skill store populated before a canonical seed (e.g.
  // structure_studio_standards_pack) shipped. Mirrors WorkspaceStore.ensureWorkspaceNodeSeeds /
  // ensureConversationalAgentSeeds exactly: any seeded skillId absent from the store is appended
  // verbatim; a skill row already present — including an operator's edited instructions, version or
  // status — is NEVER touched. Unlike ensureConversationalAgentSeeds there is deliberately no
  // prompt-upgrade path here, so this is a pure append-missing, nothing more. A no-op (no write, no
  // version bump, no event) when nothing is missing.
  ensureSkillSeeds(meta?: SkillMutationMeta): Promise<SkillDefinition[]>;
  create(skill: SkillDefinition, meta?: SkillMutationMeta): Promise<{ skill: SkillDefinition; skillVersion: number }>;
  update(skillId: string, patch: Partial<SkillDefinition>, meta?: SkillMutationMeta): Promise<{ skill: SkillDefinition; skillVersion: number }>;
  delete(skillId: string, meta?: SkillMutationMeta): Promise<{ deleted: true; skillVersion: number }>;
  clone(skillId: string, newSkillId: string, meta?: SkillMutationMeta): Promise<{ skill: SkillDefinition; skillVersion: number }>;
  listVersions(skillId: string): Promise<SkillVersionSnapshot[]>;
  getVersion(skillId: string, versionId: string): Promise<SkillVersionSnapshot | undefined>;
  restoreVersion(skillId: string, versionId: string, meta?: SkillMutationMeta): Promise<{ skill: SkillDefinition; skillVersion: number }>;
  getEvents(skillId?: string): Promise<SkillEvent[]>;
}
