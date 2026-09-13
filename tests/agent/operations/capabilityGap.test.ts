// R2 Piece 2 acceptance tests — the durable, deduplicated capability-gap ledger. Covers, bottom to
// top: the record's stable identity and genuine-reason filter (capabilityGapTypes.ts), the writer
// that bridges operationPreflight's per-call findings into durable occurrences
// (capabilityGapRecorder.ts), both repository implementations (Memory + a CAS-honoring Blob double —
// never a Map fake, per AGENTS.md), and the end-to-end MCP surface (operation.preflight recording,
// operation.list_capability_gaps reading) via the real global repositoryManager singleton.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { capabilityGapId, isGenuineCapabilityGapReason, MAX_CAPABILITY_GAP_SOURCE_REFS } from "../../../src/agent/operations/capabilityGapTypes.js";
import { recordGenuineCapabilityGaps } from "../../../src/agent/operations/capabilityGapRecorder.js";
import { MemoryCapabilityGapRepository } from "../../../src/agent/repository/memory/MemoryCapabilityGapRepository.js";
import { BlobCapabilityGapRepository } from "../../../src/agent/repository/blobs/BlobCapabilityGapRepository.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";
import type { OperationCapabilityGap } from "../../../src/agent/operations/operationTypes.js";
import type { CapabilityGapRepository } from "../../../src/agent/repository/interfaces/CapabilityGapRepository.js";
import { createOperationTools } from "../../../src/agent/mcp/workspace/operationTools.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const notConfiguredGap = (overrides: Partial<OperationCapabilityGap> = {}): OperationCapabilityGap => ({
  capability: "site_inventory_read",
  requiredBy: "site_inventory",
  reason: "not_configured",
  evidence: { requiredTool: "object_inventory" },
  remedy: "Grant the tool.",
  ...overrides
});

// A CAS-honoring GCS-shaped double, same minimal shape as conversationTurnGc.test.ts's own
// "GCS-shaped supersession GC CAS" double — real etags, real onlyIfNew/onlyIfMatch preconditions,
// never a Map fake with unconditional overwrite semantics.
const makeCasStore = (): BlobStoreClient & { objects: Map<string, unknown> } => {
  const values = new Map<string, { data: unknown; etag: string }>();
  let revision = 0;
  return {
    objects: { get size() { return values.size; } } as unknown as Map<string, unknown>,
    get: async (key: string) => (values.has(key) ? structuredClone(values.get(key)!.data) : null),
    getWithMetadata: async (key: string) => (values.has(key) ? structuredClone(values.get(key)!) : null),
    setJSON: async (key: string, data: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      const current = values.get(key);
      if ((options?.onlyIfNew && current) || (options?.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch)) return { modified: false };
      const etag = String(++revision);
      values.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: values.get(key)!.etag })),
      directories: []
    }),
    delete: async (key: string) => { values.delete(key); }
  } as unknown as BlobStoreClient & { objects: Map<string, unknown> };
};

describe("capabilityGapTypes", () => {
  it("treats only not_configured/not_supported as genuine — unavailable is excluded", () => {
    expect(isGenuineCapabilityGapReason("not_configured")).toBe(true);
    expect(isGenuineCapabilityGapReason("not_supported")).toBe(true);
    expect(isGenuineCapabilityGapReason("unavailable")).toBe(false);
  });

  it("capabilityGapId is deterministic and distinguishes tenant, operation, version, and capability", () => {
    const base = capabilityGapId("dr-lurie", "site_inventory", 1, "site_inventory_read");
    expect(capabilityGapId("dr-lurie", "site_inventory", 1, "site_inventory_read")).toBe(base);
    expect(capabilityGapId("other-tenant", "site_inventory", 1, "site_inventory_read")).not.toBe(base);
    expect(capabilityGapId("dr-lurie", "other_operation", 1, "site_inventory_read")).not.toBe(base);
    expect(capabilityGapId("dr-lurie", "site_inventory", 2, "site_inventory_read")).not.toBe(base);
    expect(capabilityGapId("dr-lurie", "site_inventory", 1, "other_capability")).not.toBe(base);
    expect(base.startsWith("gap_site_inventory_read_")).toBe(true);
  });
});

describe("recordGenuineCapabilityGaps", () => {
  it("records a genuine, vocabulary-known gap and redacts evidence before it reaches the repository", async () => {
    const repository = new MemoryCapabilityGapRepository();
    const recorded = await recordGenuineCapabilityGaps({
      tenantId: "dr-lurie",
      operationId: "site_inventory",
      operationVersion: 1,
      capabilityGaps: [notConfiguredGap({ evidence: { requiredTool: "object_inventory", apiKey: "sk-should-not-persist" } })],
      repository
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ tenantId: "dr-lurie", capability: "site_inventory_read", occurrenceCount: 1 });
    expect(recorded[0]!.evidence).toEqual({ requiredTool: "object_inventory", apiKey: "[REDACTED]" });
  });

  it("filters out reason:unavailable (operational, not a genuine gap)", async () => {
    const repository = new MemoryCapabilityGapRepository();
    const recorded = await recordGenuineCapabilityGaps({
      tenantId: "dr-lurie", operationId: "site_inventory", operationVersion: 1,
      capabilityGaps: [notConfiguredGap({ reason: "unavailable" })], repository
    });
    expect(recorded).toEqual([]);
    expect(await repository.listForTenant("dr-lurie")).toEqual([]);
  });

  it("filters out a non-vocabulary capability id (e.g. preflight's own workflow_binding finding)", async () => {
    const repository = new MemoryCapabilityGapRepository();
    const recorded = await recordGenuineCapabilityGaps({
      tenantId: "dr-lurie", operationId: "site_inventory", operationVersion: 1,
      capabilityGaps: [notConfiguredGap({ capability: "workflow_binding", reason: "not_supported" })], repository
    });
    expect(recorded).toEqual([]);
  });
});

describe("MemoryCapabilityGapRepository", () => {
  it("dedupes repeated occurrences into ONE record, incrementing occurrenceCount and bounding+deduping sourceRefs", async () => {
    const repository = new MemoryCapabilityGapRepository();
    const input = { tenantId: "dr-lurie", capability: "site_inventory_read", operationId: "site_inventory", operationVersion: 1, reason: "not_configured" as const, evidence: {}, proposedRemedy: "Grant it." };
    let last = await repository.recordOccurrence({ ...input, sourceRef: "run_1", at: "2026-09-01T00:00:00.000Z" });
    expect(last).toMatchObject({ occurrenceCount: 1, firstSeenAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-01T00:00:00.000Z", sourceRefs: ["run_1"] });

    for (let i = 2; i <= 13; i++) {
      last = await repository.recordOccurrence({ ...input, sourceRef: `run_${i}`, at: `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    expect(last.occurrenceCount).toBe(13);
    expect(last.firstSeenAt).toBe("2026-09-01T00:00:00.000Z"); // first-seen never moves
    expect(last.sourceRefs).toHaveLength(MAX_CAPABILITY_GAP_SOURCE_REFS); // bounded
    expect(last.sourceRefs).toEqual(["run_4", "run_5", "run_6", "run_7", "run_8", "run_9", "run_10", "run_11", "run_12", "run_13"]); // most-recent-last, oldest dropped

    // A repeat of a ref already present does not grow the list or duplicate it.
    const repeat = await repository.recordOccurrence({ ...input, sourceRef: "run_13", at: "2026-09-01T00:00:14.000Z" });
    expect(repeat.occurrenceCount).toBe(14);
    expect(repeat.sourceRefs.filter((ref) => ref === "run_13")).toHaveLength(1);

    expect(await repository.listForTenant("dr-lurie")).toHaveLength(1);
  });

  it("scopes listForTenant to exactly the named tenant (no cross-tenant leak)", async () => {
    const repository = new MemoryCapabilityGapRepository();
    await repository.recordOccurrence({ tenantId: "dr-lurie", capability: "site_inventory_read", operationId: "site_inventory", operationVersion: 1, reason: "not_configured", evidence: {}, proposedRemedy: "r" });
    await repository.recordOccurrence({ tenantId: "other-tenant", capability: "site_inventory_read", operationId: "site_inventory", operationVersion: 1, reason: "not_configured", evidence: {}, proposedRemedy: "r" });
    expect((await repository.listForTenant("dr-lurie")).map((r) => r.tenantId)).toEqual(["dr-lurie"]);
    expect((await repository.listForTenant("other-tenant")).map((r) => r.tenantId)).toEqual(["other-tenant"]);
  });

  it("get() round-trips exactly what recordOccurrence returned, by id", async () => {
    const repository = new MemoryCapabilityGapRepository();
    const record = await repository.recordOccurrence({ tenantId: "dr-lurie", capability: "site_inventory_read", operationId: "site_inventory", operationVersion: 1, reason: "not_configured", evidence: {}, proposedRemedy: "r" });
    expect(await repository.get("dr-lurie", record.id)).toEqual(record);
    expect(await repository.get("dr-lurie", "gap_not_a_real_id")).toBeUndefined();
  });
});

describe("BlobCapabilityGapRepository (CAS-honoring, never a Map fake)", () => {
  it("uses the tenant-nested key space capability-gaps/{tenantId}/{gapId}.json", async () => {
    const store = makeCasStore();
    const repository = new BlobCapabilityGapRepository(store);
    const record = await repository.recordOccurrence({ tenantId: "dr-lurie", capability: "site_inventory_read", operationId: "site_inventory", operationVersion: 1, reason: "not_configured", evidence: {}, proposedRemedy: "r" });
    const listed = await store.list({ prefix: "capability-gaps/dr-lurie/" });
    expect(listed.blobs.map((b) => b.key)).toEqual([`capability-gaps/dr-lurie/${record.id}.json`]);
  });

  it("keeps every concurrent occurrence's increment through real CAS retry (no lost update)", async () => {
    const store = makeCasStore();
    const input = { tenantId: "dr-lurie", capability: "site_inventory_read", operationId: "site_inventory", operationVersion: 1, reason: "not_configured" as const, evidence: {}, proposedRemedy: "r" };
    // Concurrency kept within MAX_WRITE_RETRIES (5): each round of true (unmocked, no artificial
    // delay) contention resolves exactly one winner and every loser retries, so N concurrent writers
    // need up to N attempts in the worst in-order scheduling — this proves the "no lost update"
    // property without depending on an adversarial-contention wrapper like the tool-execution-ledger
    // CAS test uses for its own, differently-shaped index structure.
    const writers = Array.from({ length: 4 }, () => new BlobCapabilityGapRepository(store));
    await Promise.all(writers.map((repository, index) => repository.recordOccurrence({ ...input, sourceRef: `run_${index}` })));

    const final = await new BlobCapabilityGapRepository(store).listForTenant("dr-lurie");
    expect(final).toHaveLength(1); // still ONE record, not four siblings
    expect(final[0]!.occurrenceCount).toBe(4); // every concurrent writer's increment survived
    expect(final[0]!.sourceRefs.sort()).toEqual(["run_0", "run_1", "run_2", "run_3"]);
  });

  it("listForTenant only returns the named tenant's prefix", async () => {
    const store = makeCasStore();
    await new BlobCapabilityGapRepository(store).recordOccurrence({ tenantId: "dr-lurie", capability: "site_inventory_read", operationId: "site_inventory", operationVersion: 1, reason: "not_configured", evidence: {}, proposedRemedy: "r" });
    await new BlobCapabilityGapRepository(store).recordOccurrence({ tenantId: "other-tenant", capability: "site_inventory_read", operationId: "site_inventory", operationVersion: 1, reason: "not_configured", evidence: {}, proposedRemedy: "r" });
    expect((await new BlobCapabilityGapRepository(store).listForTenant("dr-lurie")).map((r) => r.tenantId)).toEqual(["dr-lurie"]);
  });

  it("health() reports readable/writable without persisting a probe record", async () => {
    const store = makeCasStore();
    const health = await new BlobCapabilityGapRepository(store).health();
    expect(health).toMatchObject({ readable: true, writable: true, version: "capability_gap.v1" });
  });
});

describe("operation.preflight / operation.list_capability_gaps (MCP surface, real global repositoryManager)", () => {
  beforeEach(() => resetRepositoryManager());
  afterEach(() => resetRepositoryManager());

  const tools = () => {
    const list = createOperationTools();
    const byName = new Map(list.map((t) => [t.name, t]));
    return {
      preflight: byName.get("operation.preflight")!,
      listGaps: byName.get("operation.list_capability_gaps")!
    };
  };

  it("discovers a genuine gap on an unregistered tenant and durably records exactly one occurrence", async () => {
    const { preflight, listGaps } = tools();
    const result = (await preflight.execute({ operationId: "site_inventory", tenantId: "unregistered-tenant", input: { tenantId: "unregistered-tenant" }, sourceRef: "run_a" })) as { data: { capabilityGaps: OperationCapabilityGap[] } };
    // Both a genuine (not_configured, vocabulary-known) and a non-genuine (not_supported, unbound
    // workflow_binding) gap surface in the per-call response — preflightOperation itself is untouched.
    expect(result.data.capabilityGaps.some((g) => g.capability === "site_inventory_read" && g.reason === "not_configured")).toBe(true);
    expect(result.data.capabilityGaps.some((g) => g.capability === "workflow_binding")).toBe(true);

    const listed = (await listGaps.execute({ tenantId: "unregistered-tenant" })) as { data: { capabilityGaps: Array<{ capability: string; occurrenceCount: number }> } };
    // Only the genuine, vocabulary-known gap became a durable record — workflow_binding did not.
    expect(listed.data.capabilityGaps).toHaveLength(1);
    expect(listed.data.capabilityGaps[0]).toMatchObject({ capability: "site_inventory_read", occurrenceCount: 1 });
  });

  it("deduplicates repeated preflight calls into the SAME record (occurrenceCount grows, sourceRefs accumulate) rather than minting siblings", async () => {
    const { preflight, listGaps } = tools();
    for (const runId of ["run_1", "run_2", "run_3"]) {
      await preflight.execute({ operationId: "site_inventory", tenantId: "unregistered-tenant", input: { tenantId: "unregistered-tenant" }, sourceRef: runId });
    }
    const listed = (await listGaps.execute({ tenantId: "unregistered-tenant" })) as { data: { capabilityGaps: Array<{ occurrenceCount: number; sourceRefs: string[] }> } };
    expect(listed.data.capabilityGaps).toHaveLength(1);
    expect(listed.data.capabilityGaps[0]!.occurrenceCount).toBe(3);
    expect(listed.data.capabilityGaps[0]!.sourceRefs).toEqual(["run_1", "run_2", "run_3"]);
  });

  it("never mixes two tenants' gap records", async () => {
    const { preflight, listGaps } = tools();
    await preflight.execute({ operationId: "site_inventory", tenantId: "tenant-a", input: { tenantId: "tenant-a" } });
    await preflight.execute({ operationId: "site_inventory", tenantId: "tenant-b", input: { tenantId: "tenant-b" } });
    const listedA = (await listGaps.execute({ tenantId: "tenant-a" })) as { data: { capabilityGaps: unknown[] } };
    const listedB = (await listGaps.execute({ tenantId: "tenant-b" })) as { data: { capabilityGaps: unknown[] } };
    expect(listedA.data.capabilityGaps).toHaveLength(1);
    expect(listedB.data.capabilityGaps).toHaveLength(1);
  });

  it("a capability-gap ledger write failure never turns the read-only preflight response into an error (best-effort)", async () => {
    const throwingRepository: CapabilityGapRepository = {
      recordOccurrence: async () => { throw new Error("ledger unavailable"); },
      get: async () => undefined,
      listForTenant: async () => [],
      health: async () => ({ readable: false, writable: false, backend: "memory", version: "capability_gap.v1" })
    };
    const original = repositoryManager.getCapabilityGapRepository();
    (repositoryManager as unknown as { getCapabilityGapRepository: () => CapabilityGapRepository }).getCapabilityGapRepository = () => throwingRepository;
    try {
      const { preflight } = tools();
      const result = (await preflight.execute({ operationId: "site_inventory", tenantId: "unregistered-tenant", input: { tenantId: "unregistered-tenant" } })) as { ok: boolean; data: { capabilityGaps: unknown[] } };
      expect(result.ok).toBe(true);
      expect(result.data.capabilityGaps.length).toBeGreaterThan(0); // the read-only finding is still reported
    } finally {
      (repositoryManager as unknown as { getCapabilityGapRepository: () => CapabilityGapRepository }).getCapabilityGapRepository = () => original;
    }
  });
});
