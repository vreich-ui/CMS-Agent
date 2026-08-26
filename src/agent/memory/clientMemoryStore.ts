// T15.32 (#208; ADR-2026-08-25-structure-studio §5) — the per-tenant CLIENT MEMORY store for
// finished templates.
//
// TENANCY SEAM (ADR §5.2, templateLibraryTypes.ts's header): the cross-tenant LIBRARY
// (src/agent/library/) is keyed by templateId, never by project. THIS store is the opposite — keyed
// by projectId, one memory record per tenant, never cross-tenant. A caller here always names exactly
// ONE projectId; there is no "list across every tenant" method, deliberately, so a reader can never
// accidentally leak one tenant's structures into another's context (ADR §5.2's own wording).
//
// DETERMINISM (ADR §5.3 — read this before touching the writer). normalizeMemoryEnvelope stamps
// `updatedAt` from wall-clock time on every write; that is why THIS module exists as a store a run's
// own stage output never reads from. recordTemplates()'s return value (a MemoryEnvelope, carrying that
// timestamp) is for a CALLER THAT WANTS IT (a workbench view, a test) — cloneConductorRoutes.ts's
// "report" stage calls recordTemplates() for its SIDE EFFECT only and never folds the return value (or
// any part of it) into the stage output it hands back to the run. See
// tests/agent/capture/clientMemoryWriteWiring.test.ts's determinism-boundary test, which asserts the
// report stage's own output is byte-identical across two calls separated by real wall-clock time.
//
// WRITER (ADR §5.2): every record passed to recordTemplates() must be built by READING BACK
// already-persisted engine state (a TemplateLibraryRecord's own provenance, a platform tool call
// result's own objectId) — never invented, interpreted, or asked of a model. Nothing in this module
// calls a model, calls an AI provider, or accepts a prompt; its entire input is typed, already-decided
// data, exactly like templateLibraryStore.ts's publish().
import { normalizeMemoryEnvelope, buildTemplateArtifactId, type MemoryEnvelope, type TemplateArtifactValue } from "./memoryEnvelope.js";
import { getBlobJson, type BlobStoreClient } from "../repository/blobs/blobClient.js";
import { resolveDefaultClientMemoryBackend } from "./clientMemoryBackend.js";

const MEMORY_PREFIX = "memory/";
const memoryKey = (projectId: string): string => `${MEMORY_PREFIX}${projectId}.json`;

export class ClientMemoryStore {
  constructor(private readonly store: BlobStoreClient = resolveDefaultClientMemoryBackend()) {}

  /** The project's current memory envelope, or a freshly-normalized empty one if it has never been
   *  written. Read-only: never writes anything, including on the "no record yet" path. */
  async get(projectId: string): Promise<MemoryEnvelope> {
    const raw = await getBlobJson<MemoryEnvelope>(this.store, memoryKey(projectId));
    return normalizeMemoryEnvelope(raw ?? { schemaVersion: "agent.memory.v1" }, { projectId });
  }

  /** Deterministic, engine-authored write of finished-template ledger facts into ONE project's own
   *  memory namespace (ADR §5.2 — never cross-tenant; §5.3 — the ledger timestamp this stamps is
   *  never to be read back into anything a run emits or hashes). Idempotent by `templateId@version`:
   *  re-recording the SAME template artifact (e.g. a re-run whose library deposit came back
   *  "unchanged", or a receiving tenant instantiating the same version twice) replaces the existing
   *  entry with an equivalent one rather than duplicating it — the array's length never grows for a
   *  repeat of the same fact. A no-op call (empty `records`) still returns the current envelope but
   *  performs no write, so a run with nothing to deposit never touches memory at all. */
  async recordTemplates(projectId: string, records: TemplateArtifactValue[]): Promise<MemoryEnvelope> {
    if (records.length === 0) return this.get(projectId);
    const current = await this.get(projectId);
    const incomingIds = new Set(records.map((record) => buildTemplateArtifactId(record.templateId, record.version)));
    const kept = current.artifacts.filter((artifact) => !(artifact.type === "template" && incomingIds.has(artifact.id)));
    const added = records.map((record) => ({ id: buildTemplateArtifactId(record.templateId, record.version), type: "template" as const, value: record }));
    const next = normalizeMemoryEnvelope({ ...current, artifacts: [...kept, ...added] }, { projectId });
    await this.store.setJSON(memoryKey(projectId), next);
    return next;
  }

  /** Read-only: every finished template this ONE project's memory currently lists — the ADR §5.2
   *  reader surface for client_manager ("what page structures do we have?") and the copy workflows
   *  (discovering what a tenant already owns before asking the studio for a new structure). Never
   *  mutates; a project with no recorded templates yet returns an empty array, never an error. */
  async listTemplates(projectId: string): Promise<TemplateArtifactValue[]> {
    const envelope = await this.get(projectId);
    return envelope.artifacts
      .filter((artifact): artifact is (typeof envelope.artifacts)[number] & { value: TemplateArtifactValue } => artifact.type === "template")
      .map((artifact) => artifact.value);
  }
}
