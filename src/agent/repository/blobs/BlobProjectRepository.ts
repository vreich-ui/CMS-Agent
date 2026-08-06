import { defaultProjectConfigs, migrateDefaultProjectConfig } from "../../projects/defaultMigration.js";
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import { auditProjectObjectDialects, formatProjectDialectFindings } from "../../projects/projectDialectAudit.js";
import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ProjectRepository } from "../interfaces/ProjectRepository.js";
import { getBlobJson, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

const clone = <T>(value: T): T => structuredClone(value);
const projectKey = (projectId: string) => `projects/${projectId}.json`;

export class BlobProjectRepository implements ProjectRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  // Perf (mcp-client-abort-timeouts-memoization): ensureSeeded had no memoization at all, so it
  // re-downloaded every default project's blob on EVERY get()/list() call — a run that touches
  // project.call_tool a dozen times across its nodes re-seeded a dozen times over. Memoized to run
  // its network work exactly once per repository instance (which, through the process-lifetime
  // singleton RepositoryManager, means once per process): the in-flight promise is shared so
  // concurrent callers await the SAME seeding attempt rather than each starting their own, and a
  // failed attempt clears itself so a transient blob-store error doesn't permanently mark this
  // instance "seeded" without ever having actually seeded anything.
  private seedPromise?: Promise<void>;

  // Seed the code-defined default projects the first time the store is read so the persisted registry
  // always contains the known projects. Only non-secret config is stored; endpoints/tokens stay in
  // environment variables.
  private async ensureSeeded(): Promise<void> {
    if (!this.seedPromise) {
      this.seedPromise = Promise.all(defaultProjectConfigs().map(async (project) => {
        const key = projectKey(project.projectId);
        const persisted = await getBlobJson<ProjectConnectionConfig>(this.store, key);
        if (persisted === null) {
          await this.store.setJSON(key, project);
          return;
        }
        const migrated = migrateDefaultProjectConfig(persisted);
        if (migrated.changed) await this.store.setJSON(key, migrated.config);
      })).then(() => undefined).catch((error) => {
        this.seedPromise = undefined;
        throw error;
      });
    }
    return this.seedPromise;
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

  async delete(projectId: string): Promise<boolean> {
    const existed = (await getBlobJson<ProjectConnectionConfig>(this.store, projectKey(projectId))) !== null;
    await this.store.delete(projectKey(projectId));
    return existed;
  }

  // G3 (T-2 re-run, run_1785405350649_9u5mjz): platform silently drifted a full definitionVersion
  // behind dr-lurie on the object-dialect parameters with no health surface reporting it. `details`
  // only ever carries the finding when one exists — a clean registry reports exactly like it always
  // has, so this is additive, not a new failure mode for `writable`/`readable`.
  async health(): Promise<RepositoryHealth> {
    const findings = formatProjectDialectFindings(auditProjectObjectDialects(await this.list()));
    return { ...healthyRepositoryStatus(storeBackendLabel()), version: "blobs.v1", ...(findings.length ? { details: { objectDialectFindings: findings } } : {}) };
  }
}
