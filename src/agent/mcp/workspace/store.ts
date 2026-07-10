import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { listWorkspaceNodes, sortWorkspaceNodes } from "../../workspace/nodes.js";
import { workspaceNodeStatuses, workspaceRiskLevels, type WorkspaceEvent, type WorkspaceNode, type WorkspaceVersionSnapshot } from "../../workspace/nodeTypes.js";
import { validateWorkspaceGraph } from "../../workspace/nodes.js";

// Replace a node in place when it already exists, otherwise append it. This preserves the existing
// array order so editing a node's prompt/schema never moves it (e.g. to the end of the workflow).
export const upsertWorkspaceNode = (nodes: WorkspaceNode[], node: WorkspaceNode): WorkspaceNode[] =>
  nodes.some((existing) => existing.id === node.id)
    ? nodes.map((existing) => existing.id === node.id ? node : existing)
    : [...nodes, node];

const visibleString = z.string().min(1);
const publicMediaSchema = z.object({
  type: z.enum(["image", "video", "audio", "embed"]),
  src: z.string().min(1).optional(),
  artifactReference: z.string().min(1).optional(),
  embed: z.string().min(1).optional(),
  alt: z.string().min(1).optional(),
  caption: z.string().min(1).optional()
}).strict().refine(
  (media) => media.src !== undefined || media.artifactReference !== undefined || media.embed !== undefined,
  { message: "Media requires at least one of src, artifactReference, or embed." }
);

const publicNodeFieldsSchema = z.object({
  eyebrow: visibleString.optional(),
  title: visibleString.optional(),
  body: visibleString.optional(),
  items: z.array(visibleString).min(1).optional(),
  ctaText: visibleString.optional(),
  ctaLink: visibleString.optional(),
  label: visibleString.optional(),
  media: publicMediaSchema.optional()
}).strict().refine(
  (publicFields) => Object.keys(publicFields).length > 0,
  { message: "Public node content requires at least one meaningful field." }
).refine(
  (publicFields) => (publicFields.ctaText === undefined) === (publicFields.ctaLink === undefined),
  { message: "CTA fields must include both ctaText and ctaLink." }
);

const nodeVisibilitySchema = z.enum(["public", "internal", "hidden"]).optional();
const articleBodyNodeSchema = z.object({
  id: z.string().regex(/^n_[A-Za-z0-9]+$/),
  kind: z.enum(["content", "action", "placement", "interactive"]),
  visibility: nodeVisibilitySchema,
  public: publicNodeFieldsSchema
}).strict();

const visiblePublicFields = ["eyebrow", "title", "body", "items", "ctaText", "ctaLink", "label", "media"] as const;
const hasVisiblePublicField = (publicFields: z.infer<typeof publicNodeFieldsSchema>) => visiblePublicFields.some((field) => publicFields[field] !== undefined);

export const articleBodySchema = z.object({
  schema_version: z.literal("article_body.v1"),
  nodes: z.array(articleBodyNodeSchema).min(1)
}).strict().refine(
  (articleBody) => articleBody.nodes.some((node) => (node.visibility === undefined || node.visibility === "public") && hasVisiblePublicField(node.public)),
  { message: "At least one node must be reader-visible with at least one public field.", path: ["nodes"] }
);

export type ArticleBody = z.infer<typeof articleBodySchema>;
export type StageOutput = { id: string; stage: string; value?: unknown; createdAt: string };
export type LearningObservation = { id: string; observation: string; metadata?: Record<string, unknown>; createdAt: string };
export type PublishPayload = { articleBody: ArticleBody; dryRun: true; target: "preview" | "cms"; builtAt: string };
export type WorkspaceMutationMeta = { expectedWorkspaceVersion?: number; actor?: string; summary?: string };
export type WorkspaceGraphUpdate = { create?: WorkspaceNode[]; update?: Array<Partial<WorkspaceNode> & { id: string }>; delete?: string[]; dependencies?: Record<string, string[]>; orderedNodeIds?: string[]; positions?: Record<string, { x: number; y: number }>; allowCanonicalNodeRemoval?: boolean; adminApproved?: boolean };
export type WorkspaceDocument = { schemaVersion: 1; workspaceVersion: number; updatedAt: string; nodes: WorkspaceNode[]; stageOutputs: StageOutput[]; learningObservations: LearningObservation[]; versions: WorkspaceVersionSnapshot[]; events: WorkspaceEvent[] };
export interface WorkspaceStore {
  getWorkspaceVersion(): Promise<number>;
  getNodes(): Promise<WorkspaceNode[]>;
  getNode(id: string): Promise<WorkspaceNode | undefined>;
  updateNodePrompt(id: string, prompt: string, meta?: WorkspaceMutationMeta): Promise<WorkspaceNode>;
  updateNodeSchema(id: string, schema: unknown, meta?: WorkspaceMutationMeta): Promise<WorkspaceNode>;
  createNode(node: WorkspaceNode, meta: WorkspaceMutationMeta): Promise<{ node: WorkspaceNode; workspaceVersion: number }>;
  deleteNode(id: string, meta: WorkspaceMutationMeta): Promise<{ deleted: true; workspaceVersion: number }>;
  cloneNode(id: string, newId: string, meta: WorkspaceMutationMeta): Promise<{ node: WorkspaceNode; workspaceVersion: number }>;
  updateNode(id: string, patch: Partial<WorkspaceNode>, meta: WorkspaceMutationMeta, eventType?: string): Promise<{ node: WorkspaceNode; workspaceVersion: number }>;
  updateGraph(update: WorkspaceGraphUpdate, meta: WorkspaceMutationMeta, eventType?: string): Promise<{ nodes: WorkspaceNode[]; workspaceVersion: number }>;
  getEvents(): Promise<WorkspaceEvent[]>;
  getVersions(): Promise<WorkspaceVersionSnapshot[]>;
  exportWorkspace(): Promise<WorkspaceDocument>;
  importWorkspace(workspace: { nodes?: WorkspaceNode[]; stageOutputs?: StageOutput[]; learningObservations?: LearningObservation[] }): Promise<{ imported: true; workspaceVersion: number; counts: { nodes: number; stageOutputs: number; learningObservations: number } }>;
  saveStageOutput(stage: string, value: unknown, id?: string): Promise<StageOutput>;
  getStageOutput(id: string): Promise<StageOutput | undefined>;
  listStageOutputs(stage?: string): Promise<StageOutput[]>;
  recordObservation(observation: string, metadata?: Record<string, unknown>): Promise<LearningObservation>;
  listObservations(): Promise<LearningObservation[]>;
}

export const articleBodyJsonSchema = {
  type: "object",
  required: ["schema_version", "nodes"],
  additionalProperties: false,
  properties: {
    schema_version: { const: "article_body.v1" },
    nodes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "kind", "public"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^n_[A-Za-z0-9]+$" },
          kind: { type: "string", enum: ["content", "action", "placement", "interactive"] },
          visibility: { type: "string", enum: ["public", "internal", "hidden"] },
          public: {
            type: "object",
            additionalProperties: false,
            anyOf: [{ required: ["eyebrow"] }, { required: ["title"] }, { required: ["body"] }, { required: ["items"] }, { required: ["label"] }, { required: ["media"] }, { required: ["ctaText"] }, { required: ["ctaLink"] }],
            dependentRequired: { ctaText: ["ctaLink"], ctaLink: ["ctaText"] },
            properties: {
              eyebrow: { type: "string", minLength: 1 },
              title: { type: "string", minLength: 1 },
              body: { type: "string", minLength: 1 },
              items: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              ctaText: { type: "string", minLength: 1 },
              ctaLink: { type: "string", minLength: 1 },
              label: { type: "string", minLength: 1 },
              media: {
                type: "object",
                required: ["type"],
                additionalProperties: false,
                anyOf: [{ required: ["src"] }, { required: ["artifactReference"] }, { required: ["embed"] }],
                properties: {
                  type: { type: "string", enum: ["image", "video", "audio", "embed"] },
                  src: { type: "string", minLength: 1 },
                  artifactReference: { type: "string", minLength: 1 },
                  embed: { type: "string", minLength: 1 },
                  alt: { type: "string", minLength: 1 },
                  caption: { type: "string", minLength: 1 }
                }
              }
            }
          }
        }
      }
    }
  }
};

const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const defaultWorkspaceNodes = (): WorkspaceNode[] => listWorkspaceNodes().map((node) => node.id === "article_body" ? { ...node, schema: articleBodyJsonSchema, outputSchema: articleBodyJsonSchema } : node);
export const createDefaultWorkspaceDocument = (): WorkspaceDocument => ({ schemaVersion: 1, workspaceVersion: 0, updatedAt: now(), nodes: defaultWorkspaceNodes(), stageOutputs: [], learningObservations: [], versions: [], events: [] });

const workspaceNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1).default("workspace"),
  description: z.string().default(""),
  prompt: z.string(),
  schema: z.unknown().optional(),
  inputSchema: z.unknown().default({ type: "object" }),
  outputSchema: z.unknown().default({ type: "object" }),
  allowedTools: z.array(z.string()).default([]),
  assignedSkills: z.array(z.string()).default([]),
  requiredInputs: z.array(z.string()).default([]),
  produces: z.array(z.string()).default([]),
  riskLevel: z.enum(workspaceRiskLevels).default("read"),
  dependsOn: z.array(z.string()).default([]),
  status: z.enum(workspaceNodeStatuses).default("draft"),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
  modelConfig: z.record(z.unknown()).optional(),
  executionConfig: z.record(z.unknown()).optional()
}).passthrough().transform((node) => ({ ...node, outputSchema: node.outputSchema ?? node.schema ?? { type: "object" } }));
const stageOutputSchema: z.ZodType<StageOutput> = z.object({ id: z.string().min(1), stage: z.string().min(1), value: z.unknown().optional(), createdAt: z.string().datetime() }).strict();
const learningObservationSchema: z.ZodType<LearningObservation> = z.object({ id: z.string().min(1), observation: z.string().min(1), metadata: z.record(z.unknown()).optional(), createdAt: z.string().datetime() }).strict();
const workspaceEventSchema: z.ZodType<WorkspaceEvent> = z.object({ id: z.string(), type: z.string(), nodeId: z.string().optional(), actor: z.string().optional(), summary: z.string().optional(), workspaceVersion: z.number().int().nonnegative(), beforeHash: z.string().optional(), afterHash: z.string().optional(), createdAt: z.string().datetime() }).strict();
const workspaceVersionSnapshotSchema: z.ZodType<WorkspaceVersionSnapshot> = z.object({ workspaceVersion: z.number().int().nonnegative(), createdAt: z.string().datetime(), summary: z.string().optional(), nodes: z.array(workspaceNodeSchema as z.ZodType<WorkspaceNode>) }).strict();
export const workspaceDocumentSchema = z.object({ schemaVersion: z.literal(1), workspaceVersion: z.number().int().nonnegative(), updatedAt: z.string().datetime(), nodes: z.array(workspaceNodeSchema), stageOutputs: z.array(stageOutputSchema), learningObservations: z.array(learningObservationSchema), versions: z.array(workspaceVersionSnapshotSchema).default([]), events: z.array(workspaceEventSchema).default([]) }).strict();


const hashValue = (value: unknown) => JSON.stringify(value).split("").reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0).toString(16);
const canonicalIds = () => new Set(listWorkspaceNodes().map((node) => node.id));
export const validateJsonSchema = (schema: unknown): string[] => {
  if (typeof schema === "boolean") return [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["JSON Schema must be an object or boolean."];
  const type = (schema as { type?: unknown }).type;
  const validTypes = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);
  if (type !== undefined) {
    const values = Array.isArray(type) ? type : [type];
    for (const value of values) if (typeof value !== "string" || !validTypes.has(value)) return [`Invalid JSON Schema type: ${String(value)}`];
  }
  return [];
};
const normalizeNode = (node: WorkspaceNode): WorkspaceNode => ({ ...node, assignedSkills: node.assignedSkills ?? [], inputSchema: node.inputSchema ?? { type: "object" }, outputSchema: node.outputSchema ?? node.schema ?? { type: "object" }, updatedAt: node.updatedAt ?? now() });
const assertWorkspaceVersion = (document: WorkspaceDocument, meta?: WorkspaceMutationMeta) => { if (meta?.expectedWorkspaceVersion !== undefined && document.workspaceVersion !== meta.expectedWorkspaceVersion) throw new Error(`workspace_version_conflict: expected ${meta.expectedWorkspaceVersion}, current ${document.workspaceVersion}`); };
const assertGraphValid = (nodes: WorkspaceNode[], allowCanonicalNodeRemoval = false, adminApproved = false) => {
  for (const node of nodes) {
    const inputIssues = validateJsonSchema(node.inputSchema);
    const outputIssues = validateJsonSchema(node.outputSchema);
    if (inputIssues.length || outputIssues.length) throw new Error([...inputIssues.map((issue) => `${node.id} inputSchema: ${issue}`), ...outputIssues.map((issue) => `${node.id} outputSchema: ${issue}`)].join("; "));
  }
  if (!allowCanonicalNodeRemoval || !adminApproved) for (const id of canonicalIds()) if (!nodes.some((node) => node.id === id)) throw new Error(`Missing required canonical node: ${id}`);
  const validation = validateWorkspaceGraph(nodes);
  if (!validation.valid) throw new Error(validation.issues.join("; "));
};

export class WorkspaceStateStore implements WorkspaceStore {
  protected document: WorkspaceDocument;
  constructor(document: WorkspaceDocument = createDefaultWorkspaceDocument()) { this.document = document; }
  protected async load() { return this.document; }
  protected async save(document: WorkspaceDocument) { this.document = document; }
  protected async mutate(update: (document: WorkspaceDocument) => void, meta?: WorkspaceMutationMeta, eventType = "workspace.updated", nodeId?: string) {
    const document = await this.load();
    assertWorkspaceVersion(document, meta);
    const beforeNodes = structuredClone(document.nodes);
    update(document);
    document.nodes = document.nodes.map(normalizeNode);
    assertGraphValid(document.nodes);
    document.workspaceVersion += 1;
    document.updatedAt = now();
    document.versions = [...(document.versions ?? []), { workspaceVersion: document.workspaceVersion, createdAt: document.updatedAt, summary: meta?.summary, nodes: structuredClone(document.nodes) }];
    document.events = [...(document.events ?? []), { id: makeId("event"), type: eventType, nodeId, actor: meta?.actor, summary: meta?.summary, workspaceVersion: document.workspaceVersion, beforeHash: hashValue(beforeNodes), afterHash: hashValue(document.nodes), createdAt: document.updatedAt }];
    await this.save(document);
    return document.workspaceVersion;
  }
  async getWorkspaceVersion() { return (await this.load()).workspaceVersion; }
  async getNodes() { return sortWorkspaceNodes([...(await this.load()).nodes]); }
  async getNode(id: string) { return (await this.load()).nodes.find((node) => node.id === id); }
  async getEvents() { return [...((await this.load()).events ?? [])]; }
  async getVersions() { return [...((await this.load()).versions ?? [])]; }
  async updateNodePrompt(id: string, prompt: string, meta?: WorkspaceMutationMeta) {
    let updated: WorkspaceNode | undefined;
    await this.mutate((document) => {
      const existing = document.nodes.find((node) => node.id === id) ?? { ...listWorkspaceNodes()[0], id, name: id, prompt: "", schema: {}, updatedAt: now(), dependsOn: [], requiredInputs: [], produces: [] };
      updated = { ...existing, prompt, updatedAt: now() };
      document.nodes = upsertWorkspaceNode(document.nodes, updated);
    }, meta, "node.prompt_updated", id);
    return updated!;
  }
  async updateNodeSchema(id: string, schema: unknown, meta?: WorkspaceMutationMeta) {
    let updated: WorkspaceNode | undefined;
    await this.mutate((document) => {
      const existing = document.nodes.find((node) => node.id === id) ?? { ...listWorkspaceNodes()[0], id, name: id, prompt: "", schema: {}, updatedAt: now(), dependsOn: [], requiredInputs: [], produces: [] };
      updated = { ...existing, schema, outputSchema: schema, updatedAt: now() };
      document.nodes = upsertWorkspaceNode(document.nodes, updated);
    }, meta, "node.output_schema_updated", id);
    return updated!;
  }
  async createNode(node: WorkspaceNode, meta: WorkspaceMutationMeta) { let workspaceVersion = 0; const normalized = normalizeNode(node); workspaceVersion = await this.mutate((document) => { if (document.nodes.some((existing) => existing.id === node.id)) throw new Error(`Duplicate node id: ${node.id}`); document.nodes = [...document.nodes, normalized]; }, meta, "node.created", node.id); return { node: normalized, workspaceVersion }; }
  async deleteNode(id: string, meta: WorkspaceMutationMeta) { let workspaceVersion = 0; workspaceVersion = await this.mutate((document) => { if (document.nodes.some((node) => node.dependsOn.includes(id))) throw new Error(`Cannot delete referenced node: ${id}`); document.nodes = document.nodes.filter((node) => node.id !== id); }, meta, "node.deleted", id); return { deleted: true as const, workspaceVersion }; }
  async cloneNode(id: string, newId: string, meta: WorkspaceMutationMeta) { const existing = await this.getNode(id); if (!existing) throw new Error(`Unknown node: ${id}`); const node = normalizeNode({ ...structuredClone(existing), id: newId, name: `${existing.name} Copy`, dependsOn: [...existing.dependsOn], updatedAt: now() }); let workspaceVersion = 0; workspaceVersion = await this.mutate((document) => { if (document.nodes.some((existingNode) => existingNode.id === newId)) throw new Error(`Duplicate node id: ${newId}`); document.nodes = [...document.nodes, node]; }, meta, "node.cloned", newId); return { node, workspaceVersion }; }
  async updateNode(id: string, patch: Partial<WorkspaceNode>, meta: WorkspaceMutationMeta, eventType = "node.updated") { let node: WorkspaceNode | undefined; const workspaceVersion = await this.mutate((document) => { const existing = document.nodes.find((candidate) => candidate.id === id); if (!existing) throw new Error(`Unknown node: ${id}`); node = normalizeNode({ ...existing, ...patch, id, updatedAt: now() }); document.nodes = upsertWorkspaceNode(document.nodes, node); }, meta, eventType, id); return { node: node!, workspaceVersion }; }
  async updateGraph(update: WorkspaceGraphUpdate, meta: WorkspaceMutationMeta, eventType = "graph.updated") { let nodes: WorkspaceNode[] = []; const workspaceVersion = await this.mutate((document) => { nodes = [...document.nodes]; (update.delete ?? []).forEach((id) => { if (nodes.some((node) => node.dependsOn.includes(id)) && !(update.delete ?? []).includes(id)) throw new Error(`Cannot delete referenced node: ${id}`); nodes = nodes.filter((node) => node.id !== id); }); (update.create ?? []).forEach((node) => { if (nodes.some((existing) => existing.id === node.id)) throw new Error(`Duplicate node id: ${node.id}`); nodes.push(normalizeNode(node)); }); (update.update ?? []).forEach((patch) => { const existing = nodes.find((node) => node.id === patch.id); if (!existing) throw new Error(`Unknown node: ${patch.id}`); nodes = upsertWorkspaceNode(nodes, normalizeNode({ ...existing, ...patch, updatedAt: now() })); }); Object.entries(update.dependencies ?? {}).forEach(([id, dependsOn]) => { const existing = nodes.find((node) => node.id === id); if (!existing) throw new Error(`Unknown node: ${id}`); nodes = upsertWorkspaceNode(nodes, normalizeNode({ ...existing, dependsOn, updatedAt: now() })); }); Object.entries(update.positions ?? {}).forEach(([id, position]) => { const existing = nodes.find((node) => node.id === id); if (!existing) throw new Error(`Unknown node: ${id}`); nodes = upsertWorkspaceNode(nodes, normalizeNode({ ...existing, position, updatedAt: now() })); }); if (update.orderedNodeIds) { const ordered = update.orderedNodeIds.map((id) => nodes.find((node) => node.id === id)); if (ordered.some((node) => !node) || ordered.length !== nodes.length) throw new Error("orderedNodeIds must contain every node exactly once."); nodes = (ordered as WorkspaceNode[]).map((node, index) => normalizeNode({ ...node, position: node.position ? { ...node.position, y: index * 100 } : { x: 0, y: index * 100 }, updatedAt: now() })); } assertGraphValid(nodes, update.allowCanonicalNodeRemoval, update.adminApproved); document.nodes = nodes; }, meta, eventType); return { nodes: sortWorkspaceNodes(nodes), workspaceVersion }; }
  async exportWorkspace() { return structuredClone(await this.load()); }
  async importWorkspace(workspace: { nodes?: WorkspaceNode[]; stageOutputs?: StageOutput[]; learningObservations?: LearningObservation[] }) {
    let workspaceVersion = 0;
    workspaceVersion = await this.mutate((document) => {
      workspace.nodes?.forEach((node) => { document.nodes = upsertWorkspaceNode(document.nodes, node); });
      workspace.stageOutputs?.forEach((output) => { document.stageOutputs = [...document.stageOutputs.filter((existing) => existing.id !== output.id), output]; });
      workspace.learningObservations?.forEach((observation) => { document.learningObservations = [...document.learningObservations.filter((existing) => existing.id !== observation.id), observation]; });
    });
    return { imported: true as const, workspaceVersion, counts: { nodes: workspace.nodes?.length ?? 0, stageOutputs: workspace.stageOutputs?.length ?? 0, learningObservations: workspace.learningObservations?.length ?? 0 } };
  }
  async saveStageOutput(stage: string, value: unknown, id = makeId("stage")) {
    const output = { id, stage, value, createdAt: now() };
    await this.mutate((document) => { document.stageOutputs = [...document.stageOutputs.filter((existing) => existing.id !== id), output]; });
    return output;
  }
  async getStageOutput(id: string) { return (await this.load()).stageOutputs.find((output) => output.id === id); }
  async listStageOutputs(stage?: string) { return (await this.load()).stageOutputs.filter((output) => !stage || output.stage === stage); }
  async recordObservation(observation: string, metadata?: Record<string, unknown>) {
    const record = { id: makeId("learning"), observation, metadata, createdAt: now() };
    await this.mutate((document) => { document.learningObservations = [...document.learningObservations, record]; });
    return record;
  }
  async listObservations() { return [...(await this.load()).learningObservations]; }
}

export class InMemoryWorkspaceStore extends WorkspaceStateStore {}

export class JsonWorkspaceStore extends WorkspaceStateStore {
  private loaded = false;
  constructor(private readonly filePath: string) { super(createDefaultWorkspaceDocument()); }
  protected override async load() {
    if (this.loaded) return this.document;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      this.document = workspaceDocumentSchema.parse(parsed) as WorkspaceDocument;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.document = createDefaultWorkspaceDocument();
        await this.save(this.document);
      } else {
        throw error;
      }
    }
    this.loaded = true;
    return this.document;
  }
  protected override async save(document: WorkspaceDocument) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
    this.document = document;
    this.loaded = true;
  }
}
