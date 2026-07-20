import { healthyRepositoryStatus, type RepositoryHealth } from "../repository/RepositoryHealth.js";
import type { SkillRepository } from "../repository/interfaces/SkillRepository.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "../repository/blobs/blobClient.js";
import type { SkillDefinition, SkillEvent, SkillListFilters, SkillMutationMeta, SkillVersionSnapshot } from "./skillTypes.js";
import { assertValidSkill, skillDefinitionSchema } from "./skillValidator.js";

const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const hashValue = (value: unknown) => JSON.stringify(value).split("").reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0).toString(16);
const objectSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const baseExample = { name: "basic", input: { brief: "Draft or review a CMS article section." }, output: { result: "Completed skill output.", artifacts: [] } };
const skill = (skillId: string, name: string, description: string, instructions: string, allowedTools: string[] = [], riskLevel: SkillDefinition["riskLevel"] = "read"): SkillDefinition => ({
  skillId, name, description, version: "1.0.0", status: "active", instructions,
  inputSchema: objectSchema({ brief: { type: "string", minLength: 1 } }, ["brief"]),
  outputSchema: objectSchema({ result: { type: "string" }, artifacts: { type: "array", items: { type: "string" } } }, ["result", "artifacts"]),
  allowedTools, requiredArtifacts: [], producedArtifacts: [], examples: [baseExample], preconditions: ["A node has supplied task context."], completionCriteria: ["Return structured output matching the skill output schema."], blockerCriteria: ["Required context or authorized tools are unavailable."],
  memoryPolicy: { namespaces: [skillId], read: true, write: false }, toolPolicy: { requestedTools: allowedTools, mutatingToolsRequireApproval: true }, riskLevel, metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
});
export const initialSkillDefinitions: SkillDefinition[] = [
  skill("web_research", "Web research", "Gather current background information with citations.", "Research the brief, prefer primary sources, capture concise findings with source URLs.", ["web.search", "web.fetch"]),
  skill("source_verification", "Source verification", "Check source credibility and citation sufficiency.", "Verify claims against authoritative sources and flag weak, stale, or unsupported references.", ["web.fetch"]),
  skill("article_structuring", "Article structuring", "Create a clear article outline and section flow.", "Transform the brief into a logical article structure with headings, key points, and artifacts."),
  skill("editorial_review", "Editorial review", "Review tone, clarity, grammar, and audience fit.", "Edit for readability, consistency, style, and brand-neutral editorial quality."),
  skill("factual_review", "Factual review", "Identify factual risks and unsupported claims.", "Check assertions, dates, names, and numbers; block when material claims lack support.", ["web.fetch"]),
  skill("seo_review", "SEO review", "Review search intent, metadata, headings, and internal-link opportunities.", "Recommend SEO improvements without keyword stuffing or publication-specific assumptions."),
  skill("artifact_handling", "Artifact handling", "Track required and produced workflow artifacts.", "Validate artifact references, naming, and handoff readiness."),
  skill("article_body_builder", "Article body builder", "Build CMS article_body-compatible content blocks.", "Create article body nodes that satisfy the shared article_body.v1 contract."),
  skill("publication_readiness", "Publication readiness", "Assess whether content is ready for dry-run handoff or publishing approval.", "Confirm criteria, risks, artifacts, and explicit dry-run/publish state before handoff.", [], "write"),
  skill("learning_observation", "Learning observation", "Capture reusable lessons from workflow outcomes.", "Record non-sensitive observations suitable for future workspace learning loops.", ["learning.record_observation"], "write")
];

type SkillDocument = { schemaVersion: 1; skillVersion: number; updatedAt: string; skills: SkillDefinition[]; versions: SkillVersionSnapshot[]; events: SkillEvent[] };
const createDocument = (): SkillDocument => ({ schemaVersion: 1, skillVersion: 0, updatedAt: now(), skills: initialSkillDefinitions.map(assertValidSkill), versions: [], events: [] });
const assertVersion = (doc: SkillDocument, meta?: SkillMutationMeta) => { if (meta?.expectedWorkspaceVersion !== undefined && doc.skillVersion !== meta.expectedWorkspaceVersion) throw new Error(`skill_version_conflict: expected ${meta.expectedWorkspaceVersion}, current ${doc.skillVersion}`); };
// Legacy skill events keep a string actor; structured workspace actors collapse to their label.
const actorLabel = (meta?: SkillMutationMeta): string | undefined => meta?.actor === undefined ? undefined : typeof meta.actor === "string" ? meta.actor : meta.actor.label ?? meta.actor.id ?? meta.actor.kind;

export class MemorySkillRepository implements SkillRepository {
  private static documents = new Map<string, SkillDocument>();
  constructor(private readonly backend: "memory" | "json" = "memory") { if (!MemorySkillRepository.documents.has(backend)) MemorySkillRepository.documents.set(backend, createDocument()); }
  protected async load() { return MemorySkillRepository.documents.get(this.backend)!; }
  protected async save(doc: SkillDocument) { MemorySkillRepository.documents.set(this.backend, doc); }
  async health(): Promise<RepositoryHealth> { return healthyRepositoryStatus(this.backend); }
  async getSkillVersion() { return (await this.load()).skillVersion; }
  async list(filters: SkillListFilters = {}) { return (await this.load()).skills.filter((s) => (!filters.status || s.status === filters.status) && (!filters.skillIds?.length || filters.skillIds.includes(s.skillId))).map((s) => structuredClone(s)); }
  async get(skillId: string) { return (await this.load()).skills.find((s) => s.skillId === skillId); }
  private async mutate(update: (doc: SkillDocument) => string | undefined, meta?: SkillMutationMeta, eventType = "skill.updated") { const doc = structuredClone(await this.load()); assertVersion(doc, meta); const before = structuredClone(doc.skills); const skillId = update(doc); doc.skills = doc.skills.map(assertValidSkill); doc.skillVersion += 1; doc.updatedAt = now(); const changed = skillId ? doc.skills.find((s) => s.skillId === skillId) : undefined; if (changed && skillId) doc.versions.push({ skillId, versionId: makeId("version"), skillVersion: doc.skillVersion, createdAt: doc.updatedAt, summary: meta?.summary, skill: structuredClone(changed) }); doc.events.push({ id: makeId("event"), type: eventType, skillId, actor: actorLabel(meta), summary: meta?.summary, skillVersion: doc.skillVersion, beforeHash: hashValue(before), afterHash: hashValue(doc.skills), createdAt: doc.updatedAt }); await this.save(doc); return doc.skillVersion; }
  async create(newSkill: SkillDefinition, meta?: SkillMutationMeta) { const skill = assertValidSkill({ ...newSkill, createdAt: newSkill.createdAt ?? now(), updatedAt: now() }); const skillVersion = await this.mutate((doc) => { if (doc.skills.some((s) => s.skillId === skill.skillId)) throw new Error(`Duplicate skill id: ${skill.skillId}`); doc.skills.push(skill); return skill.skillId; }, meta, "skill.created"); return { skill, skillVersion }; }
  async update(skillId: string, patch: Partial<SkillDefinition>, meta?: SkillMutationMeta) { let skill!: SkillDefinition; const skillVersion = await this.mutate((doc) => { const existing = doc.skills.find((s) => s.skillId === skillId); if (!existing) throw new Error(`Unknown skill: ${skillId}`); skill = assertValidSkill({ ...existing, ...patch, skillId, updatedAt: now() }); doc.skills = doc.skills.map((s) => s.skillId === skillId ? skill : s); return skillId; }, meta); return { skill, skillVersion }; }
  async delete(skillId: string, meta?: SkillMutationMeta) { const skillVersion = await this.mutate((doc) => { if (!doc.skills.some((s) => s.skillId === skillId)) throw new Error(`Unknown skill: ${skillId}`); doc.skills = doc.skills.filter((s) => s.skillId !== skillId); return skillId; }, meta, "skill.deleted"); return { deleted: true as const, skillVersion }; }
  async clone(skillId: string, newSkillId: string, meta?: SkillMutationMeta) { const existing = await this.get(skillId); if (!existing) throw new Error(`Unknown skill: ${skillId}`); return this.create({ ...structuredClone(existing), skillId: newSkillId, name: `${existing.name} Copy`, createdAt: now(), updatedAt: now() }, meta); }
  async listVersions(skillId: string) { return (await this.load()).versions.filter((v) => v.skillId === skillId).map((v) => structuredClone(v)); }
  async getVersion(skillId: string, versionId: string) { return (await this.load()).versions.find((v) => v.skillId === skillId && v.versionId === versionId); }
  async restoreVersion(skillId: string, versionId: string, meta?: SkillMutationMeta) { const version = await this.getVersion(skillId, versionId); if (!version) throw new Error(`Unknown skill version: ${skillId}/${versionId}`); return this.update(skillId, { ...version.skill, skillId, updatedAt: now() }, meta); }
  async getEvents(skillId?: string) { return (await this.load()).events.filter((event) => !skillId || event.skillId === skillId).map((event) => structuredClone(event)); }
}

export class BlobSkillRepository extends MemorySkillRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) { super("memory"); }
  private currentKey = (skillId: string) => `skills/current/${skillId}.json`;
  private versionKey = (skillId: string, versionId: string) => `skills/versions/${skillId}/${versionId}.json`;
  private eventKey = (eventId: string) => `skills/events/${eventId}.json`;
  protected override async load(): Promise<SkillDocument> { const listed = await this.store.list({ prefix: "skills/current/" }); if (!listed.blobs.length) { const doc = createDocument(); await this.save(doc); return doc; } const skills = (await Promise.all(listed.blobs.map((b) => getBlobJson<SkillDefinition>(this.store, b.key)))).filter(Boolean).map((s) => skillDefinitionSchema.parse(s)); const versionsList = await this.store.list({ prefix: "skills/versions/" }); const versions = (await Promise.all(versionsList.blobs.map((b) => getBlobJson<SkillVersionSnapshot>(this.store, b.key)))).filter(Boolean) as SkillVersionSnapshot[]; const eventsList = await this.store.list({ prefix: "skills/events/" }); const events = (await Promise.all(eventsList.blobs.map((b) => getBlobJson<SkillEvent>(this.store, b.key)))).filter(Boolean) as SkillEvent[]; return { schemaVersion: 1, skillVersion: Math.max(0, ...events.map((e) => e.skillVersion)), updatedAt: now(), skills, versions, events }; }
  protected override async save(doc: SkillDocument) { const current = await this.store.list({ prefix: "skills/current/" }); const desired = new Set(doc.skills.map((s) => this.currentKey(s.skillId))); await Promise.all([...current.blobs.filter((b) => !desired.has(b.key)).map((b) => this.store.delete(b.key)), ...doc.skills.map((s) => this.store.setJSON(this.currentKey(s.skillId), s)), ...doc.versions.map((v) => this.store.setJSON(this.versionKey(v.skillId, v.versionId), v)), ...doc.events.map((e) => this.store.setJSON(this.eventKey(e.id), e))]); }
  override async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1" }; }
}
