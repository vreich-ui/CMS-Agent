import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { CapabilityGapOccurrenceInput, CapabilityGapRepository } from "../interfaces/CapabilityGapRepository.js";
import { capabilityGapId, MAX_CAPABILITY_GAP_SOURCE_REFS, type CapabilityGapRecord } from "../../operations/capabilityGapTypes.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

// KEY SPACE (docs/DATA_ARCHITECTURE.md §3): `capability-gaps/{tenantId}/{gapId}.json`. Tenant nested
// FIRST in the path — the same shape `driverHealth/{projectId}.json` and
// `learning/conversation-turn-gc/{projectId}/{conversationId}.json` already use — so tenant scoping is
// a PATH-level guarantee (listForTenant lists exactly one prefix) rather than an in-document filter a
// caller could forget, which is the lesson KNOWN_ISSUES K-M10 already paid for on `feedback_list` /
// `learning_list_observations`: "unfiltered, this returns everyone's rows" must never be reachable by
// omitting a filter, because it is impossible to add a filter to a key space that was never
// partitioned in the first place. There is deliberately no top-level `capability-gaps/{gapId}.json`
// listing and no cross-tenant list method on the interface at all.
const TENANT_PREFIX = (tenantId: string) => `capability-gaps/${encodeURIComponent(tenantId)}/`;
const gapKey = (tenantId: string, gapId: string) => `${TENANT_PREFIX(tenantId)}${encodeURIComponent(gapId)}.json`;
const MAX_WRITE_RETRIES = 5;

export class BlobCapabilityGapRepository implements CapabilityGapRepository {
  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  // CAS read-modify-write, same shape as BlobLearningRepository.mutateLedger (see that module's
  // header for why a ledger like this needs CAS rather than an unconditional overwrite: two
  // concurrent discoveries of the SAME gap — realistic, since capability gaps are found at
  // operation.preflight time and preflight itself is stateless and may be called from more than one
  // request at once — must both land as separate occurrences, not one clobbering the other's
  // increment).
  async recordOccurrence(input: CapabilityGapOccurrenceInput): Promise<CapabilityGapRecord> {
    const gapId = capabilityGapId(input.tenantId, input.operationId, input.operationVersion, input.capability);
    const key = gapKey(input.tenantId, gapId);
    const at = input.at ?? new Date().toISOString();
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const current = await getBlobJsonWithEtag<CapabilityGapRecord>(this.store, key);
      const existing = current.data ?? undefined;
      const sourceRefs = existing?.sourceRefs ?? [];
      const nextRefs = input.sourceRef && !sourceRefs.includes(input.sourceRef)
        ? [...sourceRefs, input.sourceRef].slice(-MAX_CAPABILITY_GAP_SOURCE_REFS)
        : sourceRefs;
      const record: CapabilityGapRecord = {
        id: gapId,
        tenantId: input.tenantId,
        capability: input.capability,
        operationId: input.operationId,
        operationVersion: input.operationVersion,
        reason: input.reason,
        occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
        firstSeenAt: existing?.firstSeenAt ?? at,
        lastSeenAt: at,
        sourceRefs: nextRefs,
        evidence: input.evidence,
        proposedRemedy: input.proposedRemedy,
        rev: (existing?.rev ?? 0) + 1
      };
      const result = await this.store.setJSON(key, record, current.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
      if (!result || (result as { modified?: boolean }).modified !== false) return record;
      // modified:false — another writer won the race for this exact key since our read; retry with a
      // fresh read, same as mutateLedger. The loop is bounded so a genuinely stuck store surfaces as
      // an error rather than hanging.
    }
    throw new Error(`BlobCapabilityGapRepository.recordOccurrence: CAS conflict on "${gapKey(input.tenantId, capabilityGapId(input.tenantId, input.operationId, input.operationVersion, input.capability))}" after ${MAX_WRITE_RETRIES} attempts.`);
  }

  async get(tenantId: string, gapId: string): Promise<CapabilityGapRecord | undefined> {
    return (await getBlobJson<CapabilityGapRecord>(this.store, gapKey(tenantId, gapId))) ?? undefined;
  }

  async listForTenant(tenantId: string): Promise<CapabilityGapRecord[]> {
    const result = await this.store.list({ prefix: TENANT_PREFIX(tenantId) });
    const records = await Promise.all(result.blobs.map((blob) => getBlobJson<CapabilityGapRecord>(this.store, blob.key)));
    return records
      .filter((record): record is CapabilityGapRecord => record !== null)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async health(): Promise<RepositoryHealth> { return { ...healthyRepositoryStatus(storeBackendLabel()), version: "capability_gap.v1" }; }
}
