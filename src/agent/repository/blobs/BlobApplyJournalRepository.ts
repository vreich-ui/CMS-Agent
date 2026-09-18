import { healthyRepositoryStatus, type RepositoryHealth } from "../RepositoryHealth.js";
import type { ApplyJournalRepository } from "../interfaces/ApplyJournalRepository.js";
import type { ApplyJournalRecord } from "../../operations/siteContentObjectApplier.js";
import { getBlobJson, getBlobJsonWithEtag, getCmsAgentBlobStore, storeBackendLabel, type BlobStoreClient } from "./blobClient.js";

// KEY SPACE (docs/DATA_ARCHITECTURE.md §3 convention -- tenant nested FIRST, same shape
// `capability-gaps/{tenantId}/{gapId}.json` already uses): `apply-journal/{tenantId}/{materializationKey}.json`.
// One record per (tenant, materializationKey) -- exactly the pair siteContentObjectApplier.ts's
// `ApplyJournal.read`/`write` already key on.
const journalKey = (tenantId: string, materializationKey: string) => `apply-journal/${encodeURIComponent(tenantId)}/${encodeURIComponent(materializationKey)}.json`;

// CAS discipline, scoped to what this interface can actually promise (see
// ApplyJournalRepository.ts's own header). This instance caches the ETag it last saw for a key --
// from its own `read` or its own successful `write` -- and requires that ETag (or `onlyIfNew` when it
// last saw nothing) on the next `write` to that key. Within one applier invocation (read once, then
// write repeatedly as its one effect progresses pending -> applied/failed) this closes the real race
// the applier's header calls out: a lost update between two writes to the SAME key.
//
// UNLIKE BlobCapabilityGapRepository's own CAS loop, a conflict here is NEVER retried by re-reading
// and re-writing the SAME record: this repository's `write` receives a fully-formed record from its
// caller, not a recompute-from-current function, so retrying blindly after a conflict would overwrite
// whatever a genuinely concurrent attempt just wrote with THIS attempt's now-stale view -- exactly the
// lost update this exists to prevent. A conflict is checked ONCE, for the one case that is harmless
// (this exact record was already written -- a duplicate write racing itself) and otherwise thrown,
// matching the applier's own "a journal that cannot be written is a hard stop" rule.
export class BlobApplyJournalRepository implements ApplyJournalRepository {
  private readonly lastEtag = new Map<string, string | undefined>();

  constructor(private readonly store: BlobStoreClient = getCmsAgentBlobStore()) {}

  async read(params: { tenantId: string; materializationKey: string }): Promise<ApplyJournalRecord | null> {
    const key = journalKey(params.tenantId, params.materializationKey);
    const { data, etag } = await getBlobJsonWithEtag<ApplyJournalRecord>(this.store, key);
    this.lastEtag.set(key, etag);
    return data;
  }

  async write(record: ApplyJournalRecord): Promise<void> {
    const key = journalKey(record.tenantId, record.materializationKey);
    const knownEtag = this.lastEtag.get(key);
    const options = knownEtag !== undefined ? { onlyIfMatch: knownEtag } : { onlyIfNew: true };
    const result = await this.store.setJSON(key, record, options);
    if (!result || (result as { modified?: boolean }).modified !== false) {
      // A fresh read, not `result`'s own (optional, backend-dependent) etag field: real
      // @netlify/blobs does not promise setJSON echoes one back, and this cache must stay correct
      // regardless of whether it does.
      const written = await getBlobJsonWithEtag<ApplyJournalRecord>(this.store, key);
      this.lastEtag.set(key, written.etag);
      return;
    }
    // Someone else wrote this exact key since our last read of it. Harmless only if THIS attempt's
    // own record is already what landed (a duplicate write racing itself) -- otherwise a genuine
    // conflict, surfaced rather than silently overwritten.
    const current = await getBlobJsonWithEtag<ApplyJournalRecord>(this.store, key);
    this.lastEtag.set(key, current.etag);
    if (current.data && JSON.stringify(current.data) === JSON.stringify(record)) return;
    throw new Error(`apply_journal_conflict: "${key}" was written by another attempt between this repository's last read and this write; refusing to overwrite a concurrent attempt's own progress.`);
  }

  async get(tenantId: string, materializationKey: string): Promise<ApplyJournalRecord | null> {
    return getBlobJson<ApplyJournalRecord>(this.store, journalKey(tenantId, materializationKey));
  }

  async health(): Promise<RepositoryHealth> {
    return { ...healthyRepositoryStatus(storeBackendLabel()), version: "apply_journal.v1" };
  }
}
