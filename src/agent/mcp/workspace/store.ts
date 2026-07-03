import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { listWorkspaceNodes } from "../../workspace/nodes.js";
import { workspaceNodeStatuses, workspaceRiskLevels, type WorkspaceNode } from "../../workspace/nodeTypes.js";

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
export type WorkspaceDocument = { schemaVersion: 1; workspaceVersion: number; updatedAt: string; nodes: WorkspaceNode[]; stageOutputs: StageOutput[]; learningObservations: LearningObservation[] };
export type WorkspaceStoreKind = "memory" | "json";

export interface WorkspaceStore {
  getWorkspaceVersion(): Promise<number>;
  getNodes(): Promise<WorkspaceNode[]>;
  getNode(id: string): Promise<WorkspaceNode | undefined>;
  updateNodePrompt(id: string, prompt: string): Promise<WorkspaceNode>;
  updateNodeSchema(id: string, schema: unknown): Promise<WorkspaceNode>;
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
const createDefaultWorkspaceDocument = (): WorkspaceDocument => ({ schemaVersion: 1, workspaceVersion: 0, updatedAt: now(), nodes: defaultWorkspaceNodes(), stageOutputs: [], learningObservations: [] });

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
  requiredInputs: z.array(z.string()).default([]),
  produces: z.array(z.string()).default([]),
  riskLevel: z.enum(workspaceRiskLevels).default("read"),
  dependsOn: z.array(z.string()).default([]),
  status: z.enum(workspaceNodeStatuses).default("draft"),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();
const stageOutputSchema: z.ZodType<StageOutput> = z.object({ id: z.string().min(1), stage: z.string().min(1), value: z.unknown().optional(), createdAt: z.string().datetime() }).strict();
const learningObservationSchema: z.ZodType<LearningObservation> = z.object({ id: z.string().min(1), observation: z.string().min(1), metadata: z.record(z.unknown()).optional(), createdAt: z.string().datetime() }).strict();
const workspaceDocumentSchema = z.object({ schemaVersion: z.literal(1), workspaceVersion: z.number().int().nonnegative(), updatedAt: z.string().datetime(), nodes: z.array(workspaceNodeSchema), stageOutputs: z.array(stageOutputSchema), learningObservations: z.array(learningObservationSchema) }).strict();

class WorkspaceStateStore implements WorkspaceStore {
  protected document: WorkspaceDocument;
  constructor(document: WorkspaceDocument = createDefaultWorkspaceDocument()) { this.document = document; }
  protected async load() { return this.document; }
  protected async save(document: WorkspaceDocument) { this.document = document; }
  protected async mutate(update: (document: WorkspaceDocument) => void) {
    const document = await this.load();
    update(document);
    document.workspaceVersion += 1;
    document.updatedAt = now();
    await this.save(document);
    return document.workspaceVersion;
  }
  async getWorkspaceVersion() { return (await this.load()).workspaceVersion; }
  async getNodes() { return [...(await this.load()).nodes]; }
  async getNode(id: string) { return (await this.load()).nodes.find((node) => node.id === id); }
  async updateNodePrompt(id: string, prompt: string) {
    let updated: WorkspaceNode | undefined;
    await this.mutate((document) => {
      const existing = document.nodes.find((node) => node.id === id) ?? { ...listWorkspaceNodes()[0], id, name: id, prompt: "", schema: {}, updatedAt: now(), dependsOn: [], requiredInputs: [], produces: [] };
      updated = { ...existing, prompt, updatedAt: now() };
      document.nodes = [...document.nodes.filter((node) => node.id !== id), updated];
    });
    return updated!;
  }
  async updateNodeSchema(id: string, schema: unknown) {
    let updated: WorkspaceNode | undefined;
    await this.mutate((document) => {
      const existing = document.nodes.find((node) => node.id === id) ?? { ...listWorkspaceNodes()[0], id, name: id, prompt: "", schema: {}, updatedAt: now(), dependsOn: [], requiredInputs: [], produces: [] };
      updated = { ...existing, schema, updatedAt: now() };
      document.nodes = [...document.nodes.filter((node) => node.id !== id), updated];
    });
    return updated!;
  }
  async exportWorkspace() { return structuredClone(await this.load()); }
  async importWorkspace(workspace: { nodes?: WorkspaceNode[]; stageOutputs?: StageOutput[]; learningObservations?: LearningObservation[] }) {
    let workspaceVersion = 0;
    workspaceVersion = await this.mutate((document) => {
      workspace.nodes?.forEach((node) => { document.nodes = [...document.nodes.filter((existing) => existing.id !== node.id), node]; });
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

export function createWorkspaceStore(kind: WorkspaceStoreKind = "memory", filePath = process.env.WORKSPACE_STORE_PATH ?? ".data/workspace.json"): WorkspaceStore {
  if (kind === "json") return new JsonWorkspaceStore(filePath);
  return new InMemoryWorkspaceStore();
}

const productionJsonStoreError = "Invalid workspace storage configuration: JSON workspace storage is local/dev only. Netlify serverless filesystem is not durable storage. Use WORKSPACE_STORE=memory for now or implement a database/object-store adapter before enabling persistence in production.";

export function createWorkspaceStoreFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  const kind = env.WORKSPACE_STORE === "json" ? "json" : "memory";
  if (env.NODE_ENV === "production" && kind === "json") throw new Error(productionJsonStoreError);
  return createWorkspaceStore(kind, env.WORKSPACE_STORE_PATH ?? ".data/workspace.json");
}

export const workspaceStore = createWorkspaceStoreFromEnv();
