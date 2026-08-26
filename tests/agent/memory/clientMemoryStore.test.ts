import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientMemoryStore } from "../../../src/agent/memory/clientMemoryStore.js";
import { resetClientMemoryStore } from "../../../src/agent/memory/clientMemoryBackend.js";
import type { TemplateArtifactValue } from "../../../src/agent/memory/memoryEnvelope.js";

// T15.32 (#208; ADR-2026-08-25-structure-studio §5) — the per-tenant client-memory store's own unit
// coverage: tenancy isolation, idempotency, and the reader surface. The determinism-boundary proof
// (a memory read never introducing a wall-clock value into RUN output) lives in
// tests/agent/capture/clientMemoryWriteWiring.test.ts, against the actual studio wiring — this file
// covers the store in isolation.

const templateValue = (overrides: Partial<TemplateArtifactValue> = {}): TemplateArtifactValue => ({
  templateId: "zilberman::section_template::req_hero",
  version: 1,
  objectType: "section_template",
  instantiatedObjectId: "tmpl_hero_1",
  provenance: { sourceUrl: "https://zilberman.example/", captureRunId: "run_1", engineHashes: { "clone.mjs": "abc" }, standardsPack: "unpinned-pending-T15.33" },
  ...overrides
});

describe("ClientMemoryStore", () => {
  beforeEach(() => resetClientMemoryStore());
  afterEach(() => resetClientMemoryStore());

  it("a published template appears in the owning tenant's memory and NOT in another tenant's (ADR §5.2 tenancy seam)", async () => {
    const store = new ClientMemoryStore();
    await store.recordTemplates("tenant-a", [templateValue()]);

    const tenantA = await store.listTemplates("tenant-a");
    expect(tenantA).toEqual([templateValue()]);

    const tenantB = await store.listTemplates("tenant-b");
    expect(tenantB).toEqual([]);
  });

  it("the record carries full provenance, read back verbatim", async () => {
    const store = new ClientMemoryStore();
    const value = templateValue({ provenance: { sourceUrl: "https://client.example/", captureRunId: "run_9", engineHashes: { "clone.mjs": "deadbeef", "publish.mjs": "cafef00d" }, standardsPack: "2026.08" } });
    await store.recordTemplates("tenant-a", [value]);
    const [recorded] = await store.listTemplates("tenant-a");
    expect(recorded.provenance).toEqual(value.provenance);
  });

  it("a reader can find a tenant's templates by projectId alone, with no cross-tenant list method available", async () => {
    const store = new ClientMemoryStore();
    await store.recordTemplates("tenant-a", [templateValue()]);
    expect(await store.listTemplates("tenant-a")).toHaveLength(1);
    // The class deliberately exposes no "list every project's memory" method — only per-project reads.
    expect((store as unknown as Record<string, unknown>).listAllTemplates).toBeUndefined();
  });

  it("is idempotent by templateId@version: recording the same artifact twice does not duplicate it", async () => {
    const store = new ClientMemoryStore();
    await store.recordTemplates("tenant-a", [templateValue()]);
    await store.recordTemplates("tenant-a", [templateValue()]);
    const templates = await store.listTemplates("tenant-a");
    expect(templates).toHaveLength(1);
  });

  it("re-recording the same templateId@version REPLACES the entry with the newer value (e.g. an updated instantiatedObjectId)", async () => {
    const store = new ClientMemoryStore();
    await store.recordTemplates("tenant-a", [templateValue({ instantiatedObjectId: "tmpl_hero_1" })]);
    await store.recordTemplates("tenant-a", [templateValue({ instantiatedObjectId: "tmpl_hero_1_replaced" })]);
    const templates = await store.listTemplates("tenant-a");
    expect(templates).toHaveLength(1);
    expect(templates[0].instantiatedObjectId).toBe("tmpl_hero_1_replaced");
  });

  it("recording a DIFFERENT version of the same templateId adds a second entry, never overwriting the first", async () => {
    const store = new ClientMemoryStore();
    await store.recordTemplates("tenant-a", [templateValue({ version: 1 })]);
    await store.recordTemplates("tenant-a", [templateValue({ version: 2, instantiatedObjectId: "tmpl_hero_2" })]);
    const templates = await store.listTemplates("tenant-a");
    expect(templates.map((t) => t.version).sort()).toEqual([1, 2]);
  });

  it("preserves non-template artifacts already in memory when recording a template", async () => {
    const store = new ClientMemoryStore();
    const seeded = await store.get("tenant-a");
    await store.recordTemplates("tenant-a", [templateValue()]);
    const after = await store.get("tenant-a");
    expect(after.artifacts.filter((a) => a.type !== "template")).toEqual(seeded.artifacts.filter((a) => a.type !== "template"));
  });

  it("recording zero records performs no write and returns the current (unchanged) envelope", async () => {
    const store = new ClientMemoryStore();
    const before = await store.get("tenant-a");
    const result = await store.recordTemplates("tenant-a", []);
    expect(result.artifacts).toEqual(before.artifacts);
    expect(await store.listTemplates("tenant-a")).toEqual([]);
  });

  it("a project with no recorded templates yet returns an empty array, never an error", async () => {
    const store = new ClientMemoryStore();
    await expect(store.listTemplates("never-seeded-tenant")).resolves.toEqual([]);
  });
});
