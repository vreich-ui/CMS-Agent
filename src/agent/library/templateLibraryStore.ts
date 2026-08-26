// T15.31 (#207; ADR-2026-08-25-structure-studio §4.1) — the cross-tenant template library's storage.
//
// Mirrors BlobProjectRepository.ts exactly in shape (same blob-store facility, an injectable
// BlobStoreClient default of getCmsAgentBlobStore(), the same test-double pattern), because the
// library is the SAME kind of thing a project registry is: a fleet-wide record keyed independent of
// any one tenant's own object store, never scoped by RepositoryContext.projectId. See
// templateLibraryTypes.ts's header for why this must never be conflated with per-tenant client
// memory (#208).
//
// IMMUTABILITY (ADR §4.1: "a published template version is IMMUTABLE"). Every version file is
// written ONLY with `onlyIfNew: true` (Netlify Blobs' create-only condition) — a second attempt to
// write the SAME version key always fails to modify, never overwrites. The `latest` pointer is the
// only mutable thing here, and it only ever moves FORWARD (to a higher version) or stays put (an
// identical re-deposit); it is never rewritten to point at a version whose content is not what its
// own contentHash says. templateLibraryRecord.ts's resolveTemplateVersion is the pure decision this
// module executes; this module is the I/O and the compare-and-swap around it.
import { computeTemplateContentHash } from "./templateLibraryRecord.js";
import { resolveTemplateVersion, type TemplateLatestPointer } from "./templateLibraryRecord.js";
import { sectionTypesUsedInRecipe } from "./templateSectionTypes.js";
import { buildCaptureEngineHashes, STANDARDS_PACK_VERSION, validateTemplateProvenance } from "./templateProvenance.js";
import { TemplateLibraryRefusal, type TemplateLibraryObjectType, type TemplateLibraryRecord } from "./templateLibraryTypes.js";
import { getBlobJson, getBlobJsonWithEtag, type BlobStoreClient } from "../repository/blobs/blobClient.js";
import { resolveDefaultTemplateLibraryBackend } from "./templateLibraryBackend.js";

const clone = <T>(value: T): T => structuredClone(value);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const LIBRARY_PREFIX = "library/";
const versionKey = (templateId: string, version: number) => `${LIBRARY_PREFIX}${templateId}/${version}.json`;
const latestKey = (templateId: string) => `${LIBRARY_PREFIX}${templateId}/latest.json`;
const isLatestKey = (key: string) => key.endsWith("/latest.json");

export type TemplateDepositInput = {
  templateId: string;
  objectType: TemplateLibraryObjectType;
  name: string;
  recipe: Record<string, unknown>;
  sourceProjectId: string;
  // engineHashes and standardsPack are deliberately NOT accepted from the caller — publish() always
  // states them itself (buildCaptureEngineHashes(), STANDARDS_PACK_VERSION) so every deposit carries
  // the SAME pinned values a caller could otherwise omit, stale, or fabricate.
  provenance: { sourceUrl?: string | null; captureRunId?: string | null; driven: "clone" | "demand" };
};

export type TemplateDepositResult = { outcome: "minted" | "unchanged"; record: TemplateLibraryRecord };

export type TemplateLibraryListFilter = { templateId?: string; objectType?: TemplateLibraryObjectType; sectionType?: string };

export class TemplateLibraryStore {
  constructor(private readonly store: BlobStoreClient = resolveDefaultTemplateLibraryBackend()) {}

  async getVersion(templateId: string, version: number): Promise<TemplateLibraryRecord | undefined> {
    const record = await getBlobJson<TemplateLibraryRecord>(this.store, versionKey(templateId, version));
    return record ? clone(record) : undefined;
  }

  async getLatest(templateId: string): Promise<TemplateLibraryRecord | undefined> {
    const pointer = await getBlobJson<TemplateLatestPointer>(this.store, latestKey(templateId));
    if (!pointer) return undefined;
    return this.getVersion(templateId, pointer.version);
  }

  /** Every version of every template, or a filtered slice by templateId / objectType / a section
   *  type the recipe depends on — the "list/query the library by structure kind + requirements" T15.31
   *  point 4 names, consumed by T15.32's memory records and the workbench. Reads version files only
   *  (never the `latest` pointers, which carry no recipe of their own). */
  async list(filter: TemplateLibraryListFilter = {}): Promise<TemplateLibraryRecord[]> {
    const prefix = filter.templateId ? `${LIBRARY_PREFIX}${filter.templateId}/` : LIBRARY_PREFIX;
    const result = await this.store.list({ prefix });
    const keys = result.blobs.map((blob) => blob.key).filter((key) => !isLatestKey(key));
    const records = await Promise.all(keys.map((key) => getBlobJson<TemplateLibraryRecord>(this.store, key)));
    return records
      .filter((record): record is TemplateLibraryRecord => record !== null)
      .filter((record) => !filter.objectType || record.objectType === filter.objectType)
      .filter((record) => !filter.sectionType || record.sectionTypesUsed.includes(filter.sectionType))
      .sort((a, b) => a.templateId.localeCompare(b.templateId) || a.version - b.version)
      .map((record) => clone(record));
  }

  /** Validates provenance (refuses, never coerces, per ADR §4.1), computes the content hash, decides
   *  the version via resolveTemplateVersion, and — for a genuinely new version — writes it under a
   *  create-only condition so no later call can ever overwrite it. A deposit whose content matches
   *  the current latest version is a no-op: the existing record (INCLUDING its original
   *  `publishedAt`) is returned untouched, which is what makes two identical deposits produce
   *  identical library records. */
  async publish(input: TemplateDepositInput): Promise<TemplateDepositResult> {
    const templateId = input.templateId.trim();
    if (!templateId) throw new TemplateLibraryRefusal("template_id_missing", "publish() requires a non-empty templateId.");

    const provenanceResult = validateTemplateProvenance({
      sourceUrl: input.provenance.sourceUrl,
      captureRunId: input.provenance.captureRunId,
      driven: input.provenance.driven,
      engineHashes: buildCaptureEngineHashes(),
      standardsPack: STANDARDS_PACK_VERSION
    });
    if (!provenanceResult.ok) throw new TemplateLibraryRefusal(provenanceResult.code, provenanceResult.reason);

    const sectionTypesUsed = sectionTypesUsedInRecipe(input.objectType, input.recipe);
    const contentHash = computeTemplateContentHash({ objectType: input.objectType, recipe: input.recipe, sectionTypesUsed });

    const { data: pointer, etag } = await getBlobJsonWithEtag<TemplateLatestPointer>(this.store, latestKey(templateId));
    const decision = resolveTemplateVersion({ existingLatest: pointer ?? undefined, contentHash });

    if (decision.outcome === "unchanged") {
      const existing = await this.getVersion(templateId, decision.version);
      if (!existing) {
        throw new TemplateLibraryRefusal(
          "template_library_integrity_broken",
          `templateId "${templateId}" has a latest pointer naming version ${decision.version}, but that version file does not exist. The pointer and its version are never written except together; this is a storage-layer integrity failure, not a content one.`
        );
      }
      return { outcome: "unchanged", record: existing };
    }

    const record: TemplateLibraryRecord = {
      templateId,
      version: decision.version,
      objectType: input.objectType,
      name: input.name,
      recipe: input.recipe,
      sectionTypesUsed,
      provenance: provenanceResult.provenance,
      sourceProjectId: input.sourceProjectId,
      contentHash,
      // The one wall-clock read in this module — a LEDGER fact (ADR §5.3's caveat, applied here to
      // the library exactly as it applies to client memory), stamped ONCE at mint and never rewritten
      // by a later identical deposit. Never fed back into anything a run emits or hashes.
      publishedAt: new Date().toISOString()
    };

    const versionWrite = await this.store.setJSON(versionKey(templateId, decision.version), record, { onlyIfNew: true });
    if (versionWrite.modified === false) {
      // Lost a race against a concurrent identical (or, if this ever fires with a mismatch, a
      // genuinely conflicting) deposit for the SAME version number. Re-read rather than assume.
      const existing = await this.getVersion(templateId, decision.version);
      if (existing && existing.contentHash === contentHash) return { outcome: "unchanged", record: existing };
      throw new TemplateLibraryRefusal(
        "template_version_immutable",
        `templateId "${templateId}" version ${decision.version} already exists with different content; a published version is immutable (ADR-2026-08-25-structure-studio §4.1) and this deposit refuses to overwrite it rather than silently mutating it. A genuine change mints the NEXT version instead.`
      );
    }

    const pointerValue: TemplateLatestPointer = { version: decision.version, contentHash };
    const pointerWrite = await this.store.setJSON(latestKey(templateId), pointerValue, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (pointerWrite.modified === false) {
      // The version file above is already safely, immutably written regardless of who wins the
      // pointer race — re-check whether a concurrent identical writer already advanced it to (at
      // least) our version before treating this as a real conflict.
      const latestPointer = await getBlobJson<TemplateLatestPointer>(this.store, latestKey(templateId));
      const alreadyAdvanced = latestPointer && latestPointer.version >= decision.version && latestPointer.contentHash === contentHash;
      if (!alreadyAdvanced) {
        throw new TemplateLibraryRefusal(
          "template_version_conflict",
          `templateId "${templateId}"'s latest pointer changed concurrently while minting version ${decision.version}; the version itself was written immutably, but its pointer could not be safely advanced. Retry the deposit.`
        );
      }
    }

    return { outcome: "minted", record };
  }
}

export const isTemplateLibraryRecord = (value: unknown): value is TemplateLibraryRecord =>
  isRecord(value) && typeof value.templateId === "string" && typeof value.version === "number";
