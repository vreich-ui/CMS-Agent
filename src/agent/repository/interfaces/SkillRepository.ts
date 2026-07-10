import type { RepositoryHealth } from "../RepositoryHealth.js";
import type { SkillDefinition, SkillEvent, SkillListFilters, SkillMutationMeta, SkillVersionSnapshot } from "../../skills/skillTypes.js";

export interface SkillRepository {
  health(): Promise<RepositoryHealth>;
  getSkillVersion(): Promise<number>;
  list(filters?: SkillListFilters): Promise<SkillDefinition[]>;
  get(skillId: string): Promise<SkillDefinition | undefined>;
  create(skill: SkillDefinition, meta?: SkillMutationMeta): Promise<{ skill: SkillDefinition; skillVersion: number }>;
  update(skillId: string, patch: Partial<SkillDefinition>, meta?: SkillMutationMeta): Promise<{ skill: SkillDefinition; skillVersion: number }>;
  delete(skillId: string, meta?: SkillMutationMeta): Promise<{ deleted: true; skillVersion: number }>;
  clone(skillId: string, newSkillId: string, meta?: SkillMutationMeta): Promise<{ skill: SkillDefinition; skillVersion: number }>;
  listVersions(skillId: string): Promise<SkillVersionSnapshot[]>;
  getVersion(skillId: string, versionId: string): Promise<SkillVersionSnapshot | undefined>;
  restoreVersion(skillId: string, versionId: string, meta?: SkillMutationMeta): Promise<{ skill: SkillDefinition; skillVersion: number }>;
  getEvents(skillId?: string): Promise<SkillEvent[]>;
}
