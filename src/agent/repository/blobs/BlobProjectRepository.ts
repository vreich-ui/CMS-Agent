import { defaultProjectConnections } from "../../projects/drLurie/definition.js";
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ProjectRepository } from "../interfaces/ProjectRepository.js";
import { getBlobJson, getCmsAgentBlobStore, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const projectKey = (projectId: string) => `projects/${projectId}.json`;

export class BlobProjectRepository implements ProjectRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  // Seed the code-defined default projects the first time the store is read so the persisted registry
  // always contains the known projects. Only non-secret config is stored; endpoints/tokens stay in
  // environment variables.
  private async ensureSeeded(): Promise<void> {
    const result = await this.store.list({ prefix: "projects/" });
    if (result.blobs.length > 0) return;
    await Promise.all(defaultProjectConnections.map((project) => this.store.setJSON(projectKey(project.projectId), project)));
  }

  async list(): Promise<ProjectConnectionConfig[]> {
    await this.ensureSeeded();
    const result = await this.store.list({ prefix: "projects/" });
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<ProjectConnectionConfig>(this.store, blob.key)));
    return records.filter((record): record is ProjectConnectionConfig => record !== null).sort((a, b) => a.projectId.localeCompare(b.projectId)).map((record) => clone(record));
  }

  async get(projectId: string): Promise<ProjectConnectionConfig | undefined> {
    await this.ensureSeeded();
    const record = await getBlobJson<ProjectConnectionConfig>(this.store, projectKey(projectId));
    return record === null ? undefined : clone(record);
  }

  async save(config: ProjectConnectionConfig): Promise<ProjectConnectionConfig> {
    await this.store.setJSON(projectKey(config.projectId), config);
    return clone(config);
  }

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus("blobs"), version: "blobs.v1" };
  }
}
