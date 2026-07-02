import { z } from "zod";

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
export type WorkspaceNode = { id: string; name: string; prompt: string; schema?: unknown; updatedAt: string };
export type StageOutput = { id: string; stage: string; value?: unknown; createdAt: string };
export type LearningObservation = { id: string; observation: string; metadata?: Record<string, unknown>; createdAt: string };
export type PublishPayload = { articleBody: ArticleBody; dryRun: true; target: "preview" | "cms"; builtAt: string };

export interface WorkspaceStore {
  getNodes(): Promise<WorkspaceNode[]>;
  getNode(id: string): Promise<WorkspaceNode | undefined>;
  updateNodePrompt(id: string, prompt: string): Promise<WorkspaceNode>;
  updateNodeSchema(id: string, schema: unknown): Promise<WorkspaceNode>;
  exportWorkspace(): Promise<{ nodes: WorkspaceNode[]; stageOutputs: StageOutput[]; learningObservations: LearningObservation[] }>;
  importWorkspace(workspace: { nodes?: WorkspaceNode[]; stageOutputs?: StageOutput[]; learningObservations?: LearningObservation[] }): Promise<{ imported: true; counts: { nodes: number; stageOutputs: number; learningObservations: number } }>;
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

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private nodes = new Map<string, WorkspaceNode>([
    ["article_body", { id: "article_body", name: "Article Body", prompt: "Build canonical `article_body.v1` structured article nodes. Markdown is only an export/rendering adapter.", schema: articleBodyJsonSchema, updatedAt: now() }],
    ["publish_payload", { id: "publish_payload", name: "Publish Payload", prompt: "Build a dry-run publishing payload from rendered output. Flow: article_body.v1 → render markdown → publish payload.", schema: { type: "object" }, updatedAt: now() }]
  ]);
  private stageOutputs = new Map<string, StageOutput>();
  private learningObservations = new Map<string, LearningObservation>();

  async getNodes() { return [...this.nodes.values()]; }
  async getNode(id: string) { return this.nodes.get(id); }
  async updateNodePrompt(id: string, prompt: string) {
    const node = this.nodes.get(id) ?? { id, name: id, prompt: "", schema: {}, updatedAt: now() };
    const updated = { ...node, prompt, updatedAt: now() };
    this.nodes.set(id, updated);
    return updated;
  }
  async updateNodeSchema(id: string, schema: unknown) {
    const node = this.nodes.get(id) ?? { id, name: id, prompt: "", schema: {}, updatedAt: now() };
    const updated = { ...node, schema, updatedAt: now() };
    this.nodes.set(id, updated);
    return updated;
  }
  async exportWorkspace() { return { nodes: await this.getNodes(), stageOutputs: await this.listStageOutputs(), learningObservations: await this.listObservations() }; }
  async importWorkspace(workspace: { nodes?: WorkspaceNode[]; stageOutputs?: StageOutput[]; learningObservations?: LearningObservation[] }) {
    workspace.nodes?.forEach((node) => this.nodes.set(node.id, node));
    workspace.stageOutputs?.forEach((output) => this.stageOutputs.set(output.id, output));
    workspace.learningObservations?.forEach((observation) => this.learningObservations.set(observation.id, observation));
    return { imported: true as const, counts: { nodes: workspace.nodes?.length ?? 0, stageOutputs: workspace.stageOutputs?.length ?? 0, learningObservations: workspace.learningObservations?.length ?? 0 } };
  }
  async saveStageOutput(stage: string, value: unknown, id = makeId("stage")) {
    const output = { id, stage, value, createdAt: now() };
    this.stageOutputs.set(id, output);
    return output;
  }
  async getStageOutput(id: string) { return this.stageOutputs.get(id); }
  async listStageOutputs(stage?: string) { return [...this.stageOutputs.values()].filter((output) => !stage || output.stage === stage); }
  async recordObservation(observation: string, metadata?: Record<string, unknown>) {
    const record = { id: makeId("learning"), observation, metadata, createdAt: now() };
    this.learningObservations.set(record.id, record);
    return record;
  }
  async listObservations() { return [...this.learningObservations.values()]; }
}

export const workspaceStore = new InMemoryWorkspaceStore();
