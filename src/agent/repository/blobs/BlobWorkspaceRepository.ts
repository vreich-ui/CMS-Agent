import { z } from "zod";
import { createDefaultWorkspaceDocument, workspaceDocumentSchema, type LearningObservation, type StageOutput, type WorkspaceDocument } from "../../mcp/workspace/store.js";
import { listWorkspaceNodes } from "../../workspace/nodes.js";
import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { WorkspaceRepository } from "../interfaces/WorkspaceRepository.js";
import { getBlobJson, getCmsAgentBlobStore, type BlobStoreClient } from "./blobClient.js";

const key = "workspace/current.json";
const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const clone = <T>(value: T): T => structuredClone(value);
const partialWorkspaceSchema = z.object({ nodes: z.array(z.unknown()).optional(), stageOutputs: z.array(z.unknown()).optional(), learningObservations: z.array(z.unknown()).optional() }).passthrough();

export class BlobWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  private async load(): Promise<WorkspaceDocument> {
    const raw = await getBlobJson<unknown>(this.store, key);
    if (raw === null) {
      const document = createDefaultWorkspaceDocument();
      await this.save(document);
      return document;
    }
    return workspaceDocumentSchema.parse(raw) as WorkspaceDocument;
  }

  private async save(document: WorkspaceDocument) {
    await this.store.setJSON(key, document);
  }

  private async mutate(update: (document: WorkspaceDocument) => void) {
    const document = await this.load();
    update(document);
    document.workspaceVersion += 1;
    document.updatedAt = now();
    await this.save(document);
    return document.workspaceVersion;
  }

  async getWorkspaceVersion() { return (await this.load()).workspaceVersion; }
  async getNodes() { return clone((await this.load()).nodes); }
  async getNode(id: string) { return clone((await this.load()).nodes.find((node) => node.id === id)); }

  async updateNodePrompt(id: string, prompt: string) {
    let updated: WorkspaceNode | undefined;
    await this.mutate((document) => {
      const existing = document.nodes.find((node) => node.id === id) ?? { ...listWorkspaceNodes()[0], id, name: id, prompt: "", schema: {}, updatedAt: now(), dependsOn: [], requiredInputs: [], produces: [] };
      updated = { ...existing, prompt, updatedAt: now() };
      document.nodes = [...document.nodes.filter((node) => node.id !== id), updated];
    });
    return clone(updated!);
  }

  async updateNodeSchema(id: string, schema: unknown) {
    let updated: WorkspaceNode | undefined;
    await this.mutate((document) => {
      const existing = document.nodes.find((node) => node.id === id) ?? { ...listWorkspaceNodes()[0], id, name: id, prompt: "", schema: {}, updatedAt: now(), dependsOn: [], requiredInputs: [], produces: [] };
      updated = { ...existing, schema, updatedAt: now() };
      document.nodes = [...document.nodes.filter((node) => node.id !== id), updated];
    });
    return clone(updated!);
  }

  async exportWorkspace() { return clone(await this.load()); }

  async importWorkspace(workspace: { nodes?: WorkspaceNode[]; stageOutputs?: StageOutput[]; learningObservations?: LearningObservation[] }) {
    partialWorkspaceSchema.parse(workspace);
    const workspaceVersion = await this.mutate((document) => {
      workspace.nodes?.forEach((node) => { document.nodes = [...document.nodes.filter((existing) => existing.id !== node.id), node]; });
      workspace.stageOutputs?.forEach((output) => { document.stageOutputs = [...document.stageOutputs.filter((existing) => existing.id !== output.id), output]; });
      workspace.learningObservations?.forEach((observation) => { document.learningObservations = [...document.learningObservations.filter((existing) => existing.id !== observation.id), observation]; });
    });
    return { imported: true as const, workspaceVersion, counts: { nodes: workspace.nodes?.length ?? 0, stageOutputs: workspace.stageOutputs?.length ?? 0, learningObservations: workspace.learningObservations?.length ?? 0 } };
  }

  async saveStageOutput(stage: string, value: unknown, id = makeId("stage")) {
    const output = { id, stage, value, createdAt: now() };
    await this.mutate((document) => { document.stageOutputs = [...document.stageOutputs.filter((existing) => existing.id !== id), output]; });
    return clone(output);
  }
  async getStageOutput(id: string) { return clone((await this.load()).stageOutputs.find((output) => output.id === id)); }
  async listStageOutputs(stage?: string) { return clone((await this.load()).stageOutputs.filter((output) => !stage || output.stage === stage)); }
  async recordObservation(observation: string, metadata?: Record<string, unknown>) {
    const record = { id: makeId("learning"), observation, metadata, createdAt: now() };
    await this.mutate((document) => { document.learningObservations = [...document.learningObservations, record]; });
    await this.store.setJSON(`learning/${record.id}.json`, record);
    return clone(record);
  }
  async listObservations() { return clone((await this.load()).learningObservations); }
  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus("blobs"), version: "blobs.v1" }; }
}
