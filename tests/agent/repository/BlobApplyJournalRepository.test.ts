// P2 v2 -- the durable ApplyJournal backend, over a CAS-honoring Blob double (never a Map fake with
// unconditional overwrite semantics -- AGENTS.md's own rule for a repository test), same shape as
// capabilityGap.test.ts's own `makeCasStore`.
import { describe, expect, it } from "vitest";
import { BlobApplyJournalRepository } from "../../../src/agent/repository/blobs/BlobApplyJournalRepository.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";
import type { ApplyJournalRecord } from "../../../src/agent/operations/siteContentObjectApplier.js";

const makeCasStore = (): BlobStoreClient => {
  const values = new Map<string, { data: unknown; etag: string }>();
  let revision = 0;
  return {
    get: async (key: string) => (values.has(key) ? structuredClone(values.get(key)!.data) : null),
    getWithMetadata: async (key: string) => (values.has(key) ? structuredClone(values.get(key)!) : null),
    setJSON: async (key: string, data: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      const current = values.get(key);
      if ((options?.onlyIfNew && current) || (options?.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = String(++revision);
      values.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({ blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: values.get(key)!.etag })), directories: [] }),
    delete: async (key: string) => { values.delete(key); }
  } as unknown as BlobStoreClient;
};

const record = (overrides: Partial<ApplyJournalRecord> = {}): ApplyJournalRecord => ({
  materializationKey: "mk_1",
  tenantId: "kugel-platform",
  status: "in_progress",
  entry: { objectType: "page", action: "create", status: "pending", at: "2026-09-18T00:00:00.000Z" },
  startedAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
  ...overrides
});

describe("BlobApplyJournalRepository", () => {
  it("round-trips a record under (tenantId, materializationKey), reading null before any write", async () => {
    const repo = new BlobApplyJournalRepository(makeCasStore());

    expect(await repo.read({ tenantId: "kugel-platform", materializationKey: "mk_1" })).toBeNull();
    await repo.write(record());
    expect(await repo.read({ tenantId: "kugel-platform", materializationKey: "mk_1" })).toEqual(record());
  });

  it("keeps two tenants' journals for the same materializationKey apart", async () => {
    const repo = new BlobApplyJournalRepository(makeCasStore());
    await repo.write(record({ tenantId: "tenant-a" }));
    await repo.write(record({ tenantId: "tenant-b", entry: { objectType: "page", action: "patch", status: "applied", objectId: "page_1", contentRevision: 2, version: 2, at: "2026-09-18T00:01:00.000Z" } }));

    expect((await repo.read({ tenantId: "tenant-a", materializationKey: "mk_1" }))!.entry.action).toBe("create");
    expect((await repo.read({ tenantId: "tenant-b", materializationKey: "mk_1" }))!.entry.action).toBe("patch");
  });

  it("progresses a journal from pending to applied across two writes from the SAME instance (the applier's own read-then-write-repeatedly sequence)", async () => {
    const repo = new BlobApplyJournalRepository(makeCasStore());
    await repo.read({ tenantId: "kugel-platform", materializationKey: "mk_1" }); // the applier always reads first
    await repo.write(record());
    const applied = record({ status: "complete", entry: { objectType: "page", action: "create", status: "applied", objectId: "page_1", contentRevision: 1, version: 1, at: "2026-09-18T00:00:01.000Z" } });
    await repo.write(applied);

    expect(await repo.read({ tenantId: "kugel-platform", materializationKey: "mk_1" })).toEqual(applied);
  });

  it("throws rather than silently overwriting a concurrent attempt's own progress", async () => {
    const store = makeCasStore();
    const repoA = new BlobApplyJournalRepository(store);
    const repoB = new BlobApplyJournalRepository(store);

    // Both instances read the same (empty) starting state, exactly as two concurrent apply attempts
    // for the same plan would.
    await repoA.read({ tenantId: "kugel-platform", materializationKey: "mk_1" });
    await repoB.read({ tenantId: "kugel-platform", materializationKey: "mk_1" });

    await repoA.write(record()); // A's first write lands.
    // B's own first write for this key, from its OWN (now stale) read, conflicts with A's and must
    // not clobber it -- B never re-read after A's write, so it has no idea A moved first.
    await expect(repoB.write(record({ entry: { objectType: "page", action: "create", status: "pending", at: "2026-09-18T00:00:02.000Z" } }))).rejects.toThrow(/apply_journal_conflict/);

    // A's write is intact.
    expect((await repoA.read({ tenantId: "kugel-platform", materializationKey: "mk_1" }))!.entry.at).toBe("2026-09-18T00:00:00.000Z");
  });

  it("reports healthy", async () => {
    const repo = new BlobApplyJournalRepository(makeCasStore());
    const health = await repo.health();
    expect(health).toMatchObject({ writable: true, readable: true, version: "apply_journal.v1" });
  });
});
