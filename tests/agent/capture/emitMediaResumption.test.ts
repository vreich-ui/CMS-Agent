// W1.1 — capture_emit_live's media resumption. Before this fix, materializeMedia issued one
// create_artifact_from_url per asset SEQUENTIALLY inside a single executeEmission call, with the
// manifestRef -> artifactRef map (`artifactRefs`) and its dedup set (`seen`) both local to that
// call. A media-heavy site (295 assets on zilberman) could not finish inside the claim window
// (routeRegistry.ts's DETERMINISTIC_STAGE_MIN_TIMEOUT_MS + STALL_MARGIN_MS = 390s), so the node
// was reclaimed as stale_dispatch_reclaimed and re-dispatched — which restarted the SAME 295 calls
// from zero, forever (routeRegistry.ts's own "NOT CLAIMED HERE" note before this fix).
//
// These tests exercise executeEmission/materializeMedia directly (the emit.mjs layer captureEmitStep
// wraps), the same grain the resumption logic actually lives at.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeEmission, MEDIA_MATERIALIZE_BUDGET_MS, type EmissionPlan } from "../../../src/agent/capture/engine/emit.mjs";

const TARGET = "media-resume-test";

const sha256 = (seed: string) => createHash("sha256").update(seed).digest("hex");

const mediaAsset = (index: number) => ({
  pageRef: "page1",
  candidateId: `candidate_${index}`,
  manifestRef: `manifest_${index}`,
  sourceUrl: `https://source.example/asset-${index}.jpg`,
  kind: "image",
  contentType: "image/jpeg",
  expectedSizeBytes: 1000 + index,
  expectedSha256: sha256(`asset-${index}`)
});

/** A minimal, hand-built EmissionPlan — deliberately NOT routed through buildEmissionPlan/mapSnapshot,
 * so these tests stay pinned to the resumption mechanics rather than to a fixture's mapping shape. */
const basePlan = (mediaCount: number, creates: EmissionPlan["creates"] = []): EmissionPlan => ({
  schemaVersion: "capture-emission-plan.v1",
  task: "T12.4",
  target: TARGET,
  source: { mappingGeneratedAt: "2026-09-01T00:00:00.000Z", targetUrl: "https://source.example/" },
  pageRefs: ["page1"],
  repeatThreshold: 2,
  copy: { source: "target_project_contract", extractedTextPresent: false, dryRunDisposition: "policy_read_required_before_live_execution" },
  preflight: [],
  creates,
  media: Array.from({ length: mediaCount }, (_, index) => mediaAsset(index)),
  assetPlans: [],
  gaps: [],
  forbiddenVerbs: ["object_publish", "release_to_production", "trigger_netlify_build", "deploy"]
});

const MEDIA_ALLOWED_POLICY = { rights: { content: "retain_allowed_origin_content", media: "retain_referenced_allowed_origin_media" } };

const projectPolicyResolver = async (target: string) => ({ project: { id: target, capturePolicy: MEDIA_ALLOWED_POLICY } });

/** Counts create_artifact_from_url calls (the expensive per-asset round-trip) and answers every
 * other verb executeEmission's fixed preamble/creates-loop needs, generically enough to serve both
 * a media-only plan and one with a single page create. */
function makeTransport() {
  const createArtifactCalls: string[] = [];
  const objectCreateCalls: unknown[] = [];
  return {
    createArtifactCalls,
    objectCreateCalls,
    async call(verb: string, args: Record<string, unknown>) {
      switch (verb) {
        case "object_inventory":
          if (args.object_type === "site") return { data: { objects: [{ object_type: "site", object_id: "site_1", status: "active" }] } };
          return { data: { objects: [] } };
        case "object_contract":
          return { data: { contract: { creation_policy: { agents: "open" } } } };
        case "object_validate":
          return { data: { summary: { eligible: true } } };
        case "object_create": {
          objectCreateCalls.push(args);
          return { data: { record: { object_id: String(args.requested_id ?? "obj"), publication: { published_time: null } } } };
        }
        case "create_artifact_from_url": {
          createArtifactCalls.push(String(args.sourceUrl));
          const sha = String(args.expectedSha256);
          return { data: { artifact: { blobKey: `image/${String(args.requestId)}/${sha}.jpg` } } };
        }
        default:
          throw new Error(`emitMediaResumption test transport: unexpected verb ${verb}`);
      }
    }
  };
}

/** A clock that advances a fixed step on every read — deterministic, no real waiting, and lets a
 * test pick exactly how many assets a budget admits without depending on wall-clock timing. */
const steppedClock = (stepMs: number) => {
  let t = 0;
  return () => { t += stepMs; return t; };
};

describe("capture_emit_live media resumption (emit.mjs executeEmission)", () => {
  it("stops cleanly inside its soft budget, skips already-materialized assets on resume, and never re-fetches one", async () => {
    const assetCount = 5;
    const plan = basePlan(assetCount);
    const transport = makeTransport();

    // Budget admits exactly 2 assets per pass with this clock (startedAt=1000; asset 1 at
    // 2000-1000=1000<=2500; asset 2 at 3000-1000=2000<=2500; asset 3 at 4000-1000=3000>2500 stops).
    const passBudgetMs = 2500;
    const passClock = steppedClock(1000);

    const first = await executeEmission({ plan, transport, projectPolicyResolver, mediaBudgetMs: passBudgetMs, now: passClock });
    expect(first.complete).toBe(false);
    if (first.complete) throw new Error("unreachable");
    expect(first.mediaDone).toBe(2);
    expect(first.mediaTotal).toBe(assetCount);
    expect(Object.keys(first.mediaLedger)).toHaveLength(2);
    expect(transport.createArtifactCalls).toHaveLength(2);
    // Nothing past media ran: the plan.creates loop (empty here) never even matters to this
    // assertion — what matters is that materializeMedia itself returned before object_create could.
    expect(transport.objectCreateCalls).toHaveLength(0);

    // Resume: the SAME transport (so its call counters accumulate across both passes), a fresh
    // clock, and this pass's own generous default budget — the second dispatch, exactly as the
    // route would make it after persisting `first.mediaLedger` and re-queuing the node.
    const second = await executeEmission({ plan, transport, projectPolicyResolver, mediaLedger: first.mediaLedger });
    expect(second.complete).toBe(true);
    if (!second.complete) throw new Error("unreachable");
    expect(second.mediaPolicy?.materialized).toBe(assetCount);

    // The whole point: across BOTH passes, every distinct asset was fetched exactly once.
    expect(transport.createArtifactCalls).toHaveLength(assetCount);
    expect(new Set(transport.createArtifactCalls).size).toBe(assetCount);
  });

  it("a plan that fits inside the default budget completes in one pass, with no pending state, and proceeds to the creates loop", async () => {
    const assetCount = 3;
    const createOp = {
      kind: "page",
      objectType: "page",
      requestedId: "page_capture_test",
      idempotencyKey: "idem_page_capture_test",
      body: { route: "/test", title: "Test Page" },
      reason: "test create",
      pageRef: "page1"
    };
    const plan = basePlan(assetCount, [createOp]);
    const transport = makeTransport();

    const outcome = await executeEmission({ plan, transport, projectPolicyResolver });
    expect(outcome.complete).toBe(true);
    if (!outcome.complete) throw new Error("unreachable");
    expect(outcome.mediaPolicy?.materialized).toBe(assetCount);
    expect(outcome.mediaPolicy?.declined).toBe(0);
    expect(transport.createArtifactCalls).toHaveLength(assetCount);
    // The object-creates loop ran (media completed in this same dispatch, as today for a one-pass
    // site) and produced a verified draft.
    expect(outcome.createdObjects).toHaveLength(1);
    expect(outcome.createdObjects[0]).toMatchObject({ objectId: "page_capture_test", draftVerified: true });
    // No "()" here: MEDIA_MATERIALIZE_BUDGET_MS is comfortably above what 3 assets with a real
    // clock take, so this run never comes close to its own soft budget.
    expect(MEDIA_MATERIALIZE_BUDGET_MS).toBeGreaterThan(0);
  });

  it("rights.media = 'prohibited' still materializes nothing and never enters the resumable loop at all", async () => {
    const plan = basePlan(4);
    const transport = makeTransport();
    const prohibitedResolver = async (target: string) => ({
      project: { id: target, capturePolicy: { rights: { content: "retain_allowed_origin_content", media: "prohibited" } } }
    });

    const outcome = await executeEmission({ plan, transport, projectPolicyResolver: prohibitedResolver });
    expect(outcome.complete).toBe(true);
    if (!outcome.complete) throw new Error("unreachable");
    expect(outcome.mediaPolicy).toEqual({ mediaRetention: "prohibited", materialized: 0, declined: 4 });
    expect(transport.createArtifactCalls).toHaveLength(0);
  });
});
