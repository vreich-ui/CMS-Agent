import { z } from "zod";

export const articleBodySchema = z.object({
  title: z.string().min(1),
  dek: z.string().optional(),
  bodyMarkdown: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  tags: z.array(z.string().min(1)).default([]),
  author: z.string().optional()
}).strict();

export type ArticleBody = z.infer<typeof articleBodySchema>;
export type WorkspaceNode = { id: string; name: string; prompt: string; schema?: unknown; updatedAt: string };
export type StageOutput = { id: string; stage: string; value?: unknown; createdAt: string };
export type LearningObservation = { id: string; observation: string; metadata?: Record<string, unknown>; createdAt: string };
export type PublishPayload = ArticleBody & { dryRun: true; target: "preview" | "cms"; builtAt: string };

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

const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private nodes = new Map<string, WorkspaceNode>([
    ["article_body", { id: "article_body", name: "Article Body", prompt: "Draft a complete article body in Markdown.", schema: { type: "object", required: ["title", "bodyMarkdown", "slug"], properties: { title: { type: "string" }, dek: { type: "string" }, bodyMarkdown: { type: "string" }, slug: { type: "string" }, tags: { type: "array", items: { type: "string" } }, author: { type: "string" } } }, updatedAt: now() }],
    ["publish_payload", { id: "publish_payload", name: "Publish Payload", prompt: "Build a dry-run publishing payload.", schema: { type: "object" }, updatedAt: now() }]
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
