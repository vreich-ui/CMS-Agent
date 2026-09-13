import { describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { getOperation } from "../../../src/agent/operations/operationCatalog.js";
import {
  runSiteInventoryExecutor,
  DEFAULT_INVENTORY_OBJECT_TYPES,
  SITE_INVENTORY_EXECUTOR_ID
} from "../../../src/agent/operations/siteInventoryExecutor.js";
import type { SiteContextSource } from "../../../src/agent/operations/siteContext.js";
import {
  createInMemorySiteContextSource,
  buildZilbermanFixtureData,
  VIS_ZILBERMAN_OBJECT
} from "./fixtures/inMemorySiteContextSource.js";

const ARCHIVED_OBJECT = {
  objectId: "vis_zilberman_old",
  objectType: "visual_standard",
  status: "archived",
  version: 1,
  contentRevision: 1,
  publishedTime: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  fields: {}
};

describe("runSiteInventoryExecutor (A4)", () => {
  it("returns a structured blocker (never throws) when siteContextSource is not configured", async () => {
    const result = await runSiteInventoryExecutor({ tenantId: "zilberman-ff", input: { tenantId: "zilberman-ff" }, deps: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toEqual([
        expect.objectContaining({ code: "site_context_source_not_configured", blocking: true })
      ]);
    }
  });

  it("produces inventory_snapshot evidence that satisfies site_inventory's own inventory_snapshot_returned completion check", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const result = await runSiteInventoryExecutor({
      tenantId: "zilberman-ff",
      input: { tenantId: "zilberman-ff", objectType: "visual_standard" },
      deps: { siteContextSource: source }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lookup = getOperation("site_inventory");
    expect(lookup.found).toBe(true);
    const check = result.completion.find((entry) => entry.id === "inventory_snapshot_returned");
    expect(check).toBeDefined();
    expect(check!.satisfied).toBe(true);
    expect(check!.evidence).toEqual(
      expect.objectContaining({ evidenceKind: "inventory_snapshot", tenantId: "zilberman-ff", totalObjects: 1 })
    );
  });

  it("honors objectType: scans only the requested type, not DEFAULT_INVENTORY_OBJECT_TYPES", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const result = await runSiteInventoryExecutor({
      tenantId: "zilberman-ff",
      input: { tenantId: "zilberman-ff", objectType: "visual_standard" },
      deps: { siteContextSource: source }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { objectTypesScanned: string[]; requested: { objectType: string | null } };
    expect(data.objectTypesScanned).toEqual(["visual_standard"]);
    expect(data.requested.objectType).toBe("visual_standard");
  });

  it("omitting objectType scans every DEFAULT_INVENTORY_OBJECT_TYPES entry", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const result = await runSiteInventoryExecutor({
      tenantId: "zilberman-ff",
      input: { tenantId: "zilberman-ff" },
      deps: { siteContextSource: source }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { objectTypesScanned: string[]; requested: { objectType: string | null } };
    expect(data.objectTypesScanned).toEqual([...DEFAULT_INVENTORY_OBJECT_TYPES]);
    expect(data.requested.objectType).toBeNull();
  });

  it("honors includeRetired: false (default) excludes archived objects, true includes them", async () => {
    const fixture = buildZilbermanFixtureData({
      objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT, ARCHIVED_OBJECT] }
    });
    const { source } = createInMemorySiteContextSource(fixture);

    const excluded = await runSiteInventoryExecutor({
      tenantId: "zilberman-ff",
      input: { tenantId: "zilberman-ff", objectType: "visual_standard" },
      deps: { siteContextSource: source }
    });
    expect(excluded.ok).toBe(true);
    if (excluded.ok) {
      const data = excluded.data as { objects: Array<{ objectId: string }> };
      expect(data.objects.map((o) => o.objectId)).toEqual(["vis_zilberman"]);
    }

    const included = await runSiteInventoryExecutor({
      tenantId: "zilberman-ff",
      input: { tenantId: "zilberman-ff", objectType: "visual_standard", includeRetired: true },
      deps: { siteContextSource: source }
    });
    expect(included.ok).toBe(true);
    if (included.ok) {
      const data = included.data as { objects: Array<{ objectId: string }> };
      expect(data.objects.map((o) => o.objectId).sort()).toEqual(["vis_zilberman", "vis_zilberman_old"]);
    }
  });

  it("honors since: echoes it back on history with supported:false and no fabricated events, never silently dropping it", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const result = await runSiteInventoryExecutor({
      tenantId: "zilberman-ff",
      input: { tenantId: "zilberman-ff", objectType: "visual_standard", since: "2026-01-01T00:00:00.000Z" },
      deps: { siteContextSource: source }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { history: { since: string | null; supported: false; events: unknown[] } };
    expect(data.history).toEqual({ since: "2026-01-01T00:00:00.000Z", supported: false, events: [] });
  });

  it("omitting since reports history.since as null, not undefined or fabricated", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const result = await runSiteInventoryExecutor({
      tenantId: "zilberman-ff",
      input: { tenantId: "zilberman-ff", objectType: "visual_standard" },
      deps: { siteContextSource: source }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { history: { since: string | null } };
    expect(data.history.since).toBeNull();
  });

  it("a thrown tenant-read failure from the injected source surfaces as a structured tenant_read_failed blocker, never a crash and never a silently empty snapshot", async () => {
    class BoomError extends Error {
      constructor() {
        super("simulated tenant read failure");
        this.name = "BoomError";
      }
    }
    const throwingSource: SiteContextSource = {
      async listObjects() {
        throw new BoomError();
      },
      async getObjectContract() {
        return null;
      },
      async getRegistries() {
        return { visualStandards: [], pdfTemplates: [], imagePolicyContexts: [] };
      },
      async getRevisionId() {
        return null;
      }
    };
    const result = await runSiteInventoryExecutor({
      tenantId: "zilberman-ff",
      input: { tenantId: "zilberman-ff", objectType: "visual_standard" },
      deps: { siteContextSource: throwingSource }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: "tenant_read_failed",
        blocking: true,
        evidence: expect.objectContaining({ errorName: "BoomError", tenantId: "zilberman-ff" })
      })
    ]);
  });

  it("SITE_INVENTORY_EXECUTOR_ID is a stable, non-empty identifier", () => {
    expect(SITE_INVENTORY_EXECUTOR_ID).toBe("site_inventory_executor");
  });

  it("an unrelated tenantId in the fixture yields an empty (not fabricated) object list, never throwing", async () => {
    const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
    const result = await runSiteInventoryExecutor({
      tenantId: "some-other-tenant",
      input: { tenantId: "some-other-tenant", objectType: "visual_standard" },
      deps: { siteContextSource: source }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { objects: unknown[] };
    expect(data.objects).toEqual([]);
  });
});
