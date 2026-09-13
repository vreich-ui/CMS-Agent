// T12.28 gave navigation the same reuse-or-patch path as pages (collidingNav / patchExistingObject),
// but `object_inventory` rows never carry a navigation's `role` — InventoryRow
// (packages/core/server/lib/object-inventory.ts) only attaches a body-derived summary to recipe
// types (template / section_template / theme). A live run therefore found `navRoleOf(row)` null for
// every navigation summary row, so `collidingNav` never matched and both nav creates fell through to
// `object_create`, hitting the target's real id collision as
// `requested_id_unavailable` (`validation_or_create_failed`) instead of being patched in place — the
// reuse path existed but was never reached.
//
// This exercises executeEmission with a REALISTIC navigation inventory row (no inline `role`), the
// same shape pages already forced via their own route probe (`pageRouteRows`), proving the new
// `navRoleRows` probe reaches the existing reuse path instead of leaving it dead code.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeEmission, type EmissionPlan } from "../../../src/agent/capture/engine/emit.mjs";

const TARGET = "nav-reuse-test";

const sha256 = (seed: string) => createHash("sha256").update(seed).digest("hex");

const navCreateOp = (role: "header" | "footer") => ({
  kind: "navigation",
  objectType: "navigation",
  requestedId: `nav_capture_${sha256(`${TARGET}\0${role}`).slice(0, 18)}`,
  idempotencyKey: `idem_nav_${role}`,
  body: { role, groups: [{ id: "g_captured", items: [] }] },
  reason: "Mapped navigation candidate."
});

const plan: EmissionPlan = {
  schemaVersion: "capture-emission-plan.v1",
  task: "T12.4",
  target: TARGET,
  source: { mappingGeneratedAt: "2026-09-01T00:00:00.000Z", targetUrl: "https://source.example/" },
  pageRefs: [],
  repeatThreshold: 2,
  copy: { source: "target_project_contract", extractedTextPresent: false, dryRunDisposition: "policy_read_required_before_live_execution" },
  preflight: [],
  creates: [navCreateOp("header"), navCreateOp("footer")],
  media: [],
  assetPlans: [],
  gaps: [],
  forbiddenVerbs: ["object_publish", "release_to_production", "trigger_netlify_build", "deploy"]
};

const projectPolicyResolver = async (target: string) => ({
  project: { id: target, capturePolicy: { rights: { content: "retain_allowed_origin_content", media: "prohibited" } } }
});

/** Only `header` exists on the target already — `footer` must still be created. Its inventory row
 * carries no `role`, exactly like the real `InventoryRow` shape, so reuse can only work through a
 * probing resolver (mirroring `pageRouteRows`), never by reading the summary row directly. */
function makeTransport() {
  const objectCreateCalls: unknown[] = [];
  const objectGetCalls: Array<{ object_type: string; object_id: string }> = [];
  const objectPatchCalls: unknown[] = [];
  const heldLocks = new Map<string, string>();
  return {
    objectCreateCalls,
    objectGetCalls,
    objectPatchCalls,
    async call(verb: string, args: Record<string, unknown>) {
      switch (verb) {
        case "object_inventory":
          if (args.object_type === "site") return { data: { objects: [{ object_type: "site", object_id: "site_1", status: "active" }] } };
          if (args.object_type === "navigation")
            return { data: { objects: [{ object_id: "nav_existing_header", object_type: "navigation", status: "active" }] } };
          return { data: { objects: [] } };
        case "object_contract":
          return { data: { contract: { creation_policy: { agents: "open" } } } };
        case "object_get":
          objectGetCalls.push({ object_type: String(args.object_type), object_id: String(args.object_id) });
          if (args.object_type === "navigation" && args.object_id === "nav_existing_header") {
            return {
              data: {
                record: {
                  object_id: "nav_existing_header",
                  record_version: 3,
                  body: { role: "header", groups: [{ id: "g_seed", items: [] }] }
                }
              }
            };
          }
          throw new Error(`unexpected object_get ${JSON.stringify(args)}`);
        case "object_checkout":
          heldLocks.set(String(args.object_id), "lock_test_token");
          return { data: { record: { object_id: args.object_id, lockToken: "lock_test_token", record_version: 3 } } };
        case "object_patch":
          objectPatchCalls.push(args);
          if (heldLocks.get(String(args.object_id)) !== args.lock_token) throw new Error("lock not held");
          return { data: { record: { object_id: args.object_id, record_version: 4, publication: { published_time: null } } } };
        case "object_checkin":
          heldLocks.delete(String(args.object_id));
          return { data: { record: { object_id: args.object_id } } };
        case "object_validate":
          return { data: { summary: { eligible: true } } };
        case "object_create":
          objectCreateCalls.push(args);
          return { data: { record: { object_id: String(args.requested_id ?? "obj"), publication: { published_time: null } } } };
        default:
          throw new Error(`emitNavigationReuse test transport: unexpected verb ${verb}`);
      }
    }
  };
}

describe("navigation reuse reaches the T12.28 patch path (emit.mjs executeEmission)", () => {
  it("patches the existing header nav by role instead of colliding on its requested id, and still creates the missing footer", async () => {
    const transport = makeTransport();

    const outcome = await executeEmission({ plan, transport, projectPolicyResolver });
    expect(outcome.complete).toBe(true);
    if (!outcome.complete) throw new Error("unreachable");

    // The header role probe went through object_get, mirroring the page route probe.
    expect(transport.objectGetCalls).toContainEqual({ object_type: "navigation", object_id: "nav_existing_header" });

    const reusedNav = (outcome.reusedObjects ?? []).find((item) => (item as { objectType?: unknown }).objectType === "navigation");
    expect(reusedNav).toMatchObject({
      objectType: "navigation",
      objectId: "nav_existing_header",
      reason: "navigation_role_already_present",
      mode: "patched"
    });
    expect(transport.objectPatchCalls).toHaveLength(1);

    // Never falls through to object_create for the role that already exists.
    expect(transport.objectCreateCalls.some((call) => (call as { requested_id?: string }).requested_id === navCreateOp("header").requestedId)).toBe(false);
    // The footer role has no existing object, so it is still created normally.
    expect(transport.objectCreateCalls).toHaveLength(1);
    expect((transport.objectCreateCalls[0] as { requested_id?: string }).requested_id).toBe(navCreateOp("footer").requestedId);

    // The defect this guards against: no navigation ever quarantines as requested_id_unavailable.
    expect(outcome.quarantines.some((item: { reason?: string }) => item.reason === "requested_id_unavailable")).toBe(false);
  });
});
