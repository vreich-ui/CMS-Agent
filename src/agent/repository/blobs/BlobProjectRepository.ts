import { defaultProjectConfigs, migrateDefaultProjectConfig } from "../../projects/defaultMigration.js";
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
    await Promise.all(defaultProjectConfigs().map(async (project) => {
      const key = projectKey(project.projectId);
      const persisted = await getBlobJson<ProjectConnectionConfig>(this.store, key);
      if (persisted === null) {
        await this.store.setJSON(key, project);
        return;
      }
      const migrated = migrateDefaultProjectConfig(persisted);
      if (migrated.changed) await this.store.setJSON(key, migrated.config);
    }));
  }

  async list(): Promise<ProjectConnectionConfig[]> {
    await this.ensureSeeded();
    const result = await this.store.list({ prefix: "projects/" });
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<ProjectConnectionConfig>(this.store, blob.key)));
    return records.filter((record): record is ProjectConnectionConfig => record !== null).sort((a, b) => a.projectId.localeCompare(b.projectId)).map((record) => clone(record));
  }

  async get(projectId: string): Promise<ProjectConnectionConfig | undefined> {
    await this.ensureSeeded();
    const key = projectKey(projectId);
    const record = await getBlobJson<ProjectConnectionConfig>(this.store, key);
    if (record === null) return undefined;
    const migrated = migrateDefaultProjectConfig(record);
    if (migrated.changed) await this.store.setJSON(key, migrated.config);
    return clone(migrated.config);
  }

  async save(config: ProjectConnectionConfig): Promise<ProjectConnectionConfig> {
    await this.store.setJSON(projectKey(config.projectId), config);
    return clone(config);
  }

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus("blobs"), version: "blobs.v1" };
  }
}
