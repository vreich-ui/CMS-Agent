// P2 v2 acceptance -- the REAL SiteObjectWriter, exercised ONLY against a mocked ClientToolCall.
// Nothing here reaches the live connector: object_create/checkout/validate/patch/checkin/get are all
// scripted responses, never a network call. See platformSiteObjectWriter.ts's own header for the
// live evidence (object_contract, read 2026-09-18) this mock's response shapes are modeled on, and
// for why the checkout response is read tolerant of BOTH `lockToken` and `lock_token` (a real,
// documented production incident -- toolResultSearch.ts's own header).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlatformSiteObjectWriter } from "../../../src/agent/projects/platformSiteObjectWriter.js";
import type { ClientToolCall } from "../../../src/agent/projects/clientToolResult.js";
import type { PageObjectPatchOp } from "../../../src/agent/operations/siteContentObjectCompiler.js";
import { LIVE_PAGE_GET_SUMMARY } from "../operations/fixtures/liveObjectContractCapture.js";

type ScriptedCall = { tool: string; args: Record<string, unknown> };

// A scripted ClientToolCall: each tool name maps to either a fixed response or a queue of responses
// (consumed in order, for a tool called more than once -- e.g. two object_get calls). A response that
// is an Error is thrown, simulating a refused/failed tenant call.
function scriptedCall(responses: Record<string, unknown | unknown[]>): { call: ClientToolCall; log: ScriptedCall[] } {
  const log: ScriptedCall[] = [];
  const queues = new Map<string, unknown[]>(Object.entries(responses).map(([tool, value]) => [tool, Array.isArray(value) ? [...value] : [value]]));
  const call: ClientToolCall = async (tool, args) => {
    log.push({ tool, args });
    const queue = queues.get(tool);
    if (!queue || !queue.length) throw new Error(`scriptedCall: no scripted response left for "${tool}"`);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { call, log };
}

// A refused MCP result -- the shape checkedClientCall (this writer wraps every call with it) turns
// into a ClientToolRefusalError.
const refused = (statusCode: number, message: string) => ({ isError: true, content: [{ type: "text", text: message }], structuredContent: { statusCode, error: message } });

const CHECKOUT_OK = { lockToken: "lock_abc123", record_version: 5 };
const VALIDATE_OK = { valid: true, issues: [] };

describe("createPlatformSiteObjectWriter — createObject", () => {
  it("sends object_create with site/body/idempotency_key, omits requested_id, and reads the minted id", async () => {
    const { call, log } = scriptedCall({ object_create: { object_id: "page_new1", content_revision: 1, version: 1 } });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    const result = await writer.createObject({ tenantId: "kugel-platform", objectType: "page", fields: { pageType: "standard", slug: "about", title: "About", sections: [] }, idempotencyKey: "mk_1:page" });

    expect(result).toEqual({ objectId: "page_new1", contentRevision: 1, version: 1 });
    expect(log).toHaveLength(1);
    expect(log[0]!.tool).toBe("object_create");
    expect(log[0]!.args).toMatchObject({ object_type: "page", site: "site_platform", body: { pageType: "standard", slug: "about", title: "About", sections: [] }, idempotency_key: "mk_1:page" });
    expect(log[0]!.args).not.toHaveProperty("requested_id");
  });

  it("declares dedupesByIdempotencyKey: false -- object_create's replay is best-effort, never assumed safe", () => {
    const writer = createPlatformSiteObjectWriter({ call: async () => ({}), siteObjectId: "site_platform" });
    expect(writer.dedupesByIdempotencyKey).toBe(false);
  });

  it("propagates the tenant's own refusal verbatim rather than swallowing it", async () => {
    const { call } = scriptedCall({ object_create: refused(422, "invalid_body: title is required") });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    await expect(writer.createObject({ tenantId: "t", objectType: "page", fields: {}, idempotencyKey: "k" })).rejects.toThrow(/title is required/);
  });

  it("throws a named error when a SUCCESS result carries no object id", async () => {
    const { call } = scriptedCall({ object_create: { content_revision: 1, version: 1 } });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    await expect(writer.createObject({ tenantId: "t", objectType: "page", fields: {}, idempotencyKey: "k" })).rejects.toThrow(/platform_object_create_missing_id/);
  });
});

describe("createPlatformSiteObjectWriter — patchObject, the happy path", () => {
  it("checks out, validates, patches with the checkout's own lock/version, checks in, and translates every op to its live wire shape", async () => {
    const { call, log } = scriptedCall({
      object_checkout: CHECKOUT_OK,
      object_validate: VALIDATE_OK,
      object_patch: { content_revision: 6, version: 7 },
      object_checkin: { ok: true }
    });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    const ops: PageObjectPatchOp[] = [
      { op: "set_page_meta", fields: { title: "About Us" } },
      { op: "upsert_section", section: { id: "s_new1", type: "prose", data: { body: "<p>x</p>" } }, position: 2 },
      { op: "update_section_data", sectionId: "s_existing1", fields: { body: "<p>y</p>" } },
      { op: "move_section", sectionId: "s_existing1", toIndex: 0 },
      { op: "set_section_visibility", sectionId: "s_existing1", visibility: "hidden" },
      { op: "remove_section", sectionId: "s_old1" }
    ];

    const result = await writer.patchObject({ tenantId: "kugel-platform", objectType: "page", objectId: "page_about", ops });

    expect(result).toEqual({ objectId: "page_about", contentRevision: 6, version: 7 });
    expect(log.map((c) => c.tool)).toEqual(["object_checkout", "object_validate", "object_patch", "object_checkin"]);
    expect(log[0]!.args).toMatchObject({ object_type: "page", object_id: "page_about" });

    const wireOps = log[1]!.args.candidate_patch as Record<string, unknown>[];
    expect(wireOps).toEqual([
      { op: "set_page_meta", fields: { title: "About Us" } },
      { op: "upsert_section", section: { id: "s_new1", type: "prose", data: { body: "<p>x</p>" } }, position: 2 },
      { op: "update_section_data", section_id: "s_existing1", fields: { body: "<p>y</p>" } },
      { op: "move_section", section_id: "s_existing1", to_index: 0 },
      { op: "set_section_visibility", section_id: "s_existing1", visibility: "hidden" },
      { op: "remove_section", section_id: "s_old1" }
    ]);
    // object_patch gets the SAME translated ops, plus the checkout's own lock/version -- never a
    // stale, plan-frozen one.
    expect(log[2]!.args).toMatchObject({ object_type: "page", object_id: "page_about", lock_token: "lock_abc123", expected_record_version: 5, ops: wireOps });
    expect(log[3]!.args).toMatchObject({ object_type: "page", object_id: "page_about", lock_token: "lock_abc123" });
  });

  // NOT a live capture (object_patch is write-adjacent and forbidden to call live -- see this module's
  // own header) -- this only proves the depth-agnostic reader introduced for the readObject regression
  // below ALSO reaches content_revision/version if object_patch's response nests them the same way
  // object_get's does, rather than assuming object_patch is exempt from the bug just because it was
  // not independently observed.
  it("reads content_revision/version off a record-nested object_patch response, not only a flat one", async () => {
    const { call } = scriptedCall({ object_checkout: CHECKOUT_OK, object_validate: VALIDATE_OK, object_patch: { record: { object_id: "page_about", content_revision: 8, version: 9 } }, object_checkin: {} });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    const result = await writer.patchObject({ tenantId: "t", objectType: "page", objectId: "page_about", ops: [{ op: "set_page_meta", fields: { title: "About Us" } }] });

    expect(result).toEqual({ objectId: "page_about", contentRevision: 8, version: 9 });
  });

  it("reads the checkout's lock token under either spelling -- lockToken (the documented live shape) or lock_token", async () => {
    const { call, log } = scriptedCall({ object_checkout: { lock_token: "lock_snake", record_version: 2 }, object_validate: VALIDATE_OK, object_patch: { content_revision: 3, version: 3 }, object_checkin: {} });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    await writer.patchObject({ tenantId: "t", objectType: "page", objectId: "page_1", ops: [{ op: "set_page_meta", fields: {} }] });

    expect(log[2]!.args).toMatchObject({ lock_token: "lock_snake" });
  });
});

describe("createPlatformSiteObjectWriter — patchObject, the checks that stop it", () => {
  it("throws before taking any action when checkout succeeds but carries no lock token", async () => {
    const { call, log } = scriptedCall({ object_checkout: { record_version: 5 } });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    await expect(writer.patchObject({ tenantId: "t", objectType: "page", objectId: "page_1", ops: [{ op: "set_page_meta", fields: {} }] })).rejects.toThrow(/platform_checkout_missing_lock_token/);
    // No lock was ever taken, so there is nothing to release.
    expect(log.map((c) => c.tool)).toEqual(["object_checkout"]);
  });

  it("checks in even when the plan's frozen revision has moved, because the lock was already taken", async () => {
    const { call, log } = scriptedCall({ object_checkout: CHECKOUT_OK, object_get: { content_revision: 9 }, object_checkin: {} });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    await expect(writer.patchObject({ tenantId: "t", objectType: "page", objectId: "page_1", ops: [{ op: "set_page_meta", fields: {} }], expectedContentRevision: 3 })).rejects.toThrow(/page_target_moved/);
    expect(log.map((c) => c.tool)).toEqual(["object_checkout", "object_get", "object_checkin"]);
  });

  it("checks in even when object_validate refuses the candidate patch, and never calls object_patch", async () => {
    const { call, log } = scriptedCall({ object_checkout: CHECKOUT_OK, object_validate: { valid: false, issues: ["structure_anchor_unique: duplicate anchor"] }, object_checkin: {} });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    await expect(writer.patchObject({ tenantId: "t", objectType: "page", objectId: "page_1", ops: [{ op: "set_page_meta", fields: {} }] })).rejects.toThrow(/platform_patch_invalid/);
    expect(log.map((c) => c.tool)).toEqual(["object_checkout", "object_validate", "object_checkin"]);
  });

  it("checks in even when object_patch itself is refused (e.g. a stale expected_record_version)", async () => {
    const { call, log } = scriptedCall({ object_checkout: CHECKOUT_OK, object_validate: VALIDATE_OK, object_patch: refused(409, "blind_revert_refused: the record moved"), object_checkin: {} });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    await expect(writer.patchObject({ tenantId: "t", objectType: "page", objectId: "page_1", ops: [{ op: "set_page_meta", fields: {} }] })).rejects.toThrow(/blind_revert_refused/);
    expect(log.map((c) => c.tool)).toEqual(["object_checkout", "object_validate", "object_patch", "object_checkin"]);
  });
});

describe("createPlatformSiteObjectWriter — a refused checkin never turns a landed patch into a failure", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it("still returns the patch result when checkin itself fails, and names the failure on the log rather than being silent", async () => {
    const { call } = scriptedCall({ object_checkout: CHECKOUT_OK, object_validate: VALIDATE_OK, object_patch: { content_revision: 4, version: 4 }, object_checkin: new Error("lock already released") });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    const result = await writer.patchObject({ tenantId: "t", objectType: "page", objectId: "page_1", ops: [{ op: "set_page_meta", fields: {} }] });

    expect(result).toEqual({ objectId: "page_1", contentRevision: 4, version: 4 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("checkin_failed");
  });
});

describe("createPlatformSiteObjectWriter — readObject", () => {
  it("reads content_revision/version off object_get", async () => {
    const { call } = scriptedCall({ object_get: { object_id: "page_1", content_revision: 4, version: 4 } });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    const result = await writer.readObject({ tenantId: "t", objectType: "page", objectId: "page_1" });

    expect(result).toEqual({ objectId: "page_1", contentRevision: 4, version: 4 });
  });

  it("reports absence, never a guess, when the read cannot show either counter", async () => {
    const { call } = scriptedCall({ object_get: { object_id: "page_1" } });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    expect(await writer.readObject({ tenantId: "t", objectType: "page", objectId: "page_1" })).toBeNull();
  });

  it("reports absence, never throws, when the tenant refuses the read (e.g. not found)", async () => {
    const { call } = scriptedCall({ object_get: refused(404, "not found") });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    expect(await writer.readObject({ tenantId: "t", objectType: "page", objectId: "page_1" })).toBeNull();
  });

  // REGRESSION -- adversarial review of PR #387 (2026-09-18) found readContentRevision/readVersion
  // reading content_revision/version at the envelope's own top level, when a live, read-only
  // object_get call shows they live nested under `record` (this fixture is that exact live response,
  // verbatim -- see liveObjectContractCapture.ts). Against the ORIGINAL shallow reader this test would
  // have returned null (readObject reporting "no such object" for a page that plainly exists), which
  // -- on the createObject/patchObject side of this same reader -- is exactly how a landed create could
  // report itself `not_applied` and then `blocked_indeterminate` on retry: an orphan nobody is told
  // about.
  it("reads content_revision/version off the REAL, record-nested object_get envelope (live capture)", async () => {
    const { call } = scriptedCall({ object_get: LIVE_PAGE_GET_SUMMARY });
    const writer = createPlatformSiteObjectWriter({ call, siteObjectId: "site_platform" });

    const result = await writer.readObject({ tenantId: "kugel-platform", objectType: "page", objectId: "page_home" });

    expect(result).toEqual({ objectId: "page_home", contentRevision: 6, version: 21 });
  });
});
