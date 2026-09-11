import { describe, expect, it } from "vitest";
import { captureSiteSnapshot, getSiteSnapshot, isSnapshotDigestValid, SiteSnapshotCache } from "../../../src/agent/operations/siteContext.js";
import { buildZilbermanFixtureData, createInMemorySiteContextSource, VIS_ZILBERMAN_OBJECT } from "./fixtures/inMemorySiteContextSource.js";

const OBJECT_TYPES = ["visual_standard", "image_model_config"];

describe("captureSiteSnapshot", () => {
  it("is deterministic: two captures of the same content produce the same digest", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const first = await captureSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES });
    const second = await captureSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES });
    expect(second.digest).toBe(first.digest);
    expect(isSnapshotDigestValid(first)).toBe(true);
    expect(isSnapshotDigestValid(second)).toBe(true);
  });

  it("digest is stable across differently-ordered but content-identical field maps (canonicalization)", async () => {
    const reordered = { ...VIS_ZILBERMAN_OBJECT, fields: {} as Record<string, unknown> };
    // Insert the exact same key/value pairs in reverse order.
    for (const key of Object.keys(VIS_ZILBERMAN_OBJECT.fields).reverse()) reordered.fields[key] = VIS_ZILBERMAN_OBJECT.fields[key];

    const { source: sourceA } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const { source: sourceB } = createInMemorySiteContextSource(
      buildZilbermanFixtureData({ objectsByType: { visual_standard: [reordered] } })
    );
    const snapshotA = await captureSiteSnapshot(sourceA, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES });
    const snapshotB = await captureSiteSnapshot(sourceB, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES });
    expect(snapshotB.digest).toBe(snapshotA.digest);
  });

  it("digest excludes capturedAtISO: two captures a clock-tick apart still hash identically", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    let tick = 0;
    const now = () => new Date(2026, 8, 11, 0, 0, tick++).toISOString();
    const first = await captureSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES }, { now });
    const second = await captureSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES }, { now });
    expect(first.capturedAtISO).not.toBe(second.capturedAtISO);
    expect(first.digest).toBe(second.digest);
  });

  it("isSnapshotDigestValid detects a hand-mutated snapshot", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const snapshot = await captureSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES });
    const tampered = { ...snapshot, objects: { byType: { ...snapshot.objects.byType, visual_standard: [] } } };
    expect(isSnapshotDigestValid(tampered)).toBe(false);
  });
});

describe("getSiteSnapshot caching", () => {
  it("a second call for the same tenant+revision is a cache hit: no underlying reads run again", async () => {
    const { source, callCounts } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const cache = new SiteSnapshotCache(10);
    const first = await getSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES }, { cache });
    expect(callCounts.listObjects).toBeGreaterThan(0);
    const listCallsAfterFirst = callCounts.listObjects;
    const contractCallsAfterFirst = callCounts.getObjectContract;
    const registryCallsAfterFirst = callCounts.getRegistries;

    const second = await getSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES }, { cache });
    expect(second).toBe(first); // same cached object identity
    expect(callCounts.listObjects).toBe(listCallsAfterFirst);
    expect(callCounts.getObjectContract).toBe(contractCallsAfterFirst);
    expect(callCounts.getRegistries).toBe(registryCallsAfterFirst);
    // getRevisionId is the cheap pre-check every call makes, so it DOES increment.
    expect(callCounts.getRevisionId).toBeGreaterThan(1);
  });

  it("a tenant with no revision concept (getRevisionId -> null) always re-reads, but still digest-addressable", async () => {
    const { source, callCounts } = createInMemorySiteContextSource(buildZilbermanFixtureData({ revisionId: null }));
    const cache = new SiteSnapshotCache(10);
    const first = await getSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES }, { cache });
    const second = await getSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES }, { cache });
    expect(first.revisionId).toBeNull();
    expect(second.digest).toBe(first.digest);
    expect(callCounts.listObjects).toBeGreaterThan(1); // no cache hit possible without a revision id
  });

  it("is bounded: entries beyond maxEntries evict the oldest, forcing a recapture", async () => {
    // Each successful capture stores under 2 keys (tenantId:rev:<revisionId> and
    // tenantId:digest:<digest> — see getSiteSnapshot's own comment), so maxEntries=2 holds exactly
    // one tenant's pair at a time; capturing a second tenant must evict the first tenant's entries.
    const cache = new SiteSnapshotCache(2);
    const tenantA = createInMemorySiteContextSource(buildZilbermanFixtureData({ tenantId: "tenant-a", revisionId: "rev-a" }));
    const tenantB = createInMemorySiteContextSource(buildZilbermanFixtureData({ tenantId: "tenant-b", revisionId: "rev-b" }));

    await getSiteSnapshot(tenantA.source, { tenantId: "tenant-a", objectTypes: OBJECT_TYPES }, { cache });
    expect(cache.size).toBe(2);
    await getSiteSnapshot(tenantB.source, { tenantId: "tenant-b", objectTypes: OBJECT_TYPES }, { cache });
    // Bounded: still 2, not 4 — tenant-a's pair was evicted to admit tenant-b's.
    expect(cache.size).toBe(2);

    const listCallsBeforeReRequest = tenantA.callCounts.listObjects;
    await getSiteSnapshot(tenantA.source, { tenantId: "tenant-a", objectTypes: OBJECT_TYPES }, { cache });
    expect(tenantA.callCounts.listObjects).toBeGreaterThan(listCallsBeforeReRequest);
  });
});
