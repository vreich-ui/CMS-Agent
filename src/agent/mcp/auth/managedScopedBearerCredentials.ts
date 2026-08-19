import { createHash, randomBytes } from "node:crypto";
import { getBlobJsonWithEtag, getCmsAgentBlobStore, type BlobStoreClient } from "../../repository/blobs/blobClient.js";
import type { ScopedBearerTokenPolicy } from "./scopedBearerTokens.js";

// Genesis-owned scoped credentials. Raw bearers exist only between minting and the Netlify env
// write; this registry persists their SHA-256 digest plus the authorization policy. The bearer is
// 256 bits of CSPRNG output, so a digest is not practically reversible and is safe to keep in the
// same durable store as the non-secret project registry.
export const MANAGED_SCOPED_BEARER_REGISTRY_KEY = "auth/managed-scoped-bearers.v1.json";
export const MANAGED_SCOPED_BEARER_CONTRACT = "managed_scoped_bearers.v1";

export type ManagedScopedBearerMetadata = {
  digest: string;
  projects: string[];
  toolAllowlist: string[];
  createdAt: string;
  netlifySiteId: string;
  netlifySiteName: string;
};

type ManagedScopedBearerDocument = {
  contract: typeof MANAGED_SCOPED_BEARER_CONTRACT;
  revision: number;
  credentials: ManagedScopedBearerMetadata[];
};

export type MintedManagedScopedBearer = {
  // Internal handoff only. Callers must send this directly to a secret store and discard it.
  token: string;
  digest: string;
  policy: ScopedBearerTokenPolicy;
};

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_CAS_ATTEMPTS = 8;

const emptyDocument = (): ManagedScopedBearerDocument => ({
  contract: MANAGED_SCOPED_BEARER_CONTRACT,
  revision: 0,
  credentials: []
});

const uniqueValidStrings = (value: unknown, pattern: RegExp): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && pattern.test(item)) && new Set(value).size === value.length;

const parseDocument = (value: unknown): ManagedScopedBearerDocument => {
  if (value === null) return emptyDocument();
  const document = value as Partial<ManagedScopedBearerDocument>;
  if (
    !document ||
    document.contract !== MANAGED_SCOPED_BEARER_CONTRACT ||
    !Number.isInteger(document.revision) ||
    (document.revision ?? -1) < 0 ||
    !Array.isArray(document.credentials)
  ) throw new Error("Managed scoped bearer registry is invalid.");
  for (const entry of document.credentials) {
    if (
      !entry ||
      !DIGEST.test(entry.digest) ||
      !uniqueValidStrings(entry.projects, PROJECT_ID) ||
      !uniqueValidStrings(entry.toolAllowlist, TOOL_NAME) ||
      typeof entry.createdAt !== "string" ||
      !entry.createdAt ||
      typeof entry.netlifySiteId !== "string" ||
      !entry.netlifySiteId ||
      typeof entry.netlifySiteName !== "string" ||
      !entry.netlifySiteName
    ) throw new Error("Managed scoped bearer registry is invalid.");
  }
  if (new Set(document.credentials.map((entry) => entry.digest)).size !== document.credentials.length) {
    throw new Error("Managed scoped bearer registry is invalid.");
  }
  return structuredClone(document as ManagedScopedBearerDocument);
};

export const managedScopedBearerStoreEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const explicit = env.MCP_MANAGED_SCOPED_BEARERS?.trim().toLowerCase();
  if (explicit === "false" || explicit === "0") return false;
  if (explicit === "true" || explicit === "1") return true;
  return env.WORKSPACE_STORE === "gcs" || env.WORKSPACE_STORE === "blobs";
};

export const digestScopedBearer = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export class ManagedScopedBearerCredentialRepository {
  constructor(
    private readonly store: BlobStoreClient = getCmsAgentBlobStore(),
    private readonly clock: () => string = () => new Date().toISOString()
  ) {}

  private async read(): Promise<{ document: ManagedScopedBearerDocument; etag?: string }> {
    const current = await getBlobJsonWithEtag<ManagedScopedBearerDocument>(this.store, MANAGED_SCOPED_BEARER_REGISTRY_KEY);
    return { document: parseDocument(current.data), etag: current.etag };
  }

  private async mutate(change: (document: ManagedScopedBearerDocument) => ManagedScopedBearerDocument): Promise<ManagedScopedBearerDocument> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { document, etag } = await this.read();
      const next = change(structuredClone(document));
      next.contract = MANAGED_SCOPED_BEARER_CONTRACT;
      next.revision = document.revision + 1;
      const result = await this.store.setJSON(MANAGED_SCOPED_BEARER_REGISTRY_KEY, next, etag ? { onlyIfMatch: etag } : document.revision === 0 && document.credentials.length === 0 ? { onlyIfNew: true } : undefined);
      if (result.modified !== false) return next;
    }
    throw new Error("Managed scoped bearer registry changed concurrently; retry the operation.");
  }

  async findPolicy(token: string): Promise<ScopedBearerTokenPolicy | undefined> {
    const digest = digestScopedBearer(token);
    const { document } = await this.read();
    const match = document.credentials.find((entry) => entry.digest === digest);
    return match ? { projects: [...match.projects], toolAllowlist: [...match.toolAllowlist] } : undefined;
  }

  async hasProjectCredential(projectIds: readonly string[]): Promise<boolean> {
    if (projectIds.length === 0) return false;
    const { document } = await this.read();
    return document.credentials.some((entry) => entry.projects.some((projectId) => projectIds.includes(projectId)));
  }

  async mint(input: { projectId: string; toolAllowlist: string[]; netlifySiteId: string; netlifySiteName: string }): Promise<MintedManagedScopedBearer> {
    if (!PROJECT_ID.test(input.projectId) || !uniqueValidStrings(input.toolAllowlist, TOOL_NAME) || !input.netlifySiteId || !input.netlifySiteName) {
      throw new Error("Managed scoped bearer mint input is invalid.");
    }
    const token = randomBytes(32).toString("base64url");
    const digest = digestScopedBearer(token);
    const metadata: ManagedScopedBearerMetadata = {
      digest,
      projects: [input.projectId],
      toolAllowlist: [...input.toolAllowlist],
      createdAt: this.clock(),
      netlifySiteId: input.netlifySiteId,
      netlifySiteName: input.netlifySiteName
    };
    await this.mutate((document) => ({ ...document, credentials: [...document.credentials, metadata] }));
    return { token, digest, policy: { projects: [input.projectId], toolAllowlist: [...input.toolAllowlist] } };
  }

  // Rotation overlap is deliberate: mint/register first, install and verify second, retire the old
  // digest last. A failed Netlify write therefore leaves the previously installed credential valid.
  async retireOtherProjectCredentials(projectId: string, keepDigest: string): Promise<void> {
    await this.mutate((document) => ({
      ...document,
      credentials: document.credentials.filter((entry) => !entry.projects.includes(projectId) || entry.digest === keepDigest)
    }));
  }

  async listMetadata(): Promise<ManagedScopedBearerMetadata[]> {
    return (await this.read()).document.credentials.map((entry) => structuredClone(entry));
  }
}

export const findManagedScopedBearerTokenPolicy = async (token: string, env: NodeJS.ProcessEnv = process.env): Promise<ScopedBearerTokenPolicy | undefined> => {
  if (!managedScopedBearerStoreEnabled(env)) return undefined;
  return new ManagedScopedBearerCredentialRepository().findPolicy(token);
};

export const hasManagedScopedBearerForProjects = async (projectIds: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<boolean> => {
  if (!managedScopedBearerStoreEnabled(env)) return false;
  return new ManagedScopedBearerCredentialRepository().hasProjectCredential(projectIds);
};
