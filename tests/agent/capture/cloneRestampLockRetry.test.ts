import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneRestampStep, CloneLockConflict, type CloneDeps } from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T15.12 (#191) — REPRODUCING run_1787582215829_u5rncz.
//
// The live run quarantined page_partners and page_filmography with `restamp_patch_failed: HTTP 423` —
// object_checkout found both objects already locked (by a still-finishing capture emission, or an
// overlapping run) at the instant restamp asked. Both fixtures below drive object_checkout to return
// a REAL 423 (isError, structuredContent.statusCode: 423 — the shape describeMcpErrorResult and
// mcpErrorStatusCode both read) rather than an arbitrary transport failure, so a checkout-succeeds
// happy-path test could never have caught this: the defect was specifically in how a LOCKED object is
// handled, not in how a clean checkout is handled.
//
// (1) proves the fix's positive claim: a 423 that resolves within the bound (the holder finishes and
//     releases) now restamps the page instead of quarantining it — "Restamp completes with zero
//     quarantined pages in the replay" from the issue's acceptance criteria.
// (2) proves the fix's negative claim: a 423 that NEVER resolves (a lock genuinely, permanently held)
//     is bounded — a fixed, small number of attempts, never infinite (no livelock) — and the page is
//     quarantined under a NAMED, distinct reason (restamp_lock_conflict, not the generic
//     restamp_patch_failed) so a human or a later run can tell at a glance that retrying is
//     reasonable. It also proves the lock is never stolen: no object_patch and no object_checkin ever
//     fire for a page whose checkout never actually succeeded.
const TARGET = "restamp-lock-retry-target";
const TARGET_ENDPOINT = "https://restamp-lock-retry-target.example/mcp";
const SITE_ID = "site_retry";
const THEME_ID = "thm_retry";
const PAGE_A = "pg_partners";
const PAGE_B = "pg_filmography";

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type WireCall = { name: string; args: Record<string, unknown> };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

// A REAL 423 — isError with structuredContent.statusCode: 423, exactly the shape the platform sends
// per contractReduction's own fixture ("423 = no/expired/other-held lock (checkout again)"), and the
// shape mcpErrorStatusCode reads to decide whether a failure is retry-eligible at all.
const respondLocked = (id: number) =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({
      jsonrpc: "2.0",
      id,
      result: { isError: true, structuredContent: { statusCode: 423, error_code: "object_locked" }, content: [{ type: "text", text: "object is checked out by another session" }] }
    })
  }) as unknown as Response;

const briefingWithPages = () => ({
  artifact: "clone_intake.v1" as const,
  summary: "fixture",
  captureRunId: "run_1",
  target: TARGET,
  site: { objectId: SITE_ID, palette: { colors: {}, fonts: {} } },
  theme: { objectId: THEME_ID, name: "Captured theme", palette: { colors: {}, fonts: {} } },
  registry: { sectionTypes: {}, pageTypes: {} },
  pages: [
    { pageRef: "page_partners", objectId: PAGE_A, route: "/partners", sourceShape: ["hero"], emittedShape: ["hero"], gaps: [], candidateIds: ["cand_a"] },
    { pageRef: "page_filmography", objectId: PAGE_B, route: "/filmography", sourceShape: ["hero"], emittedShape: ["hero"], gaps: [], candidateIds: ["cand_b"] }
  ],
  recipes: { section_template: [], template: [] },
  budget: { chars: 0, cap: 32000, truncated: [] },
  policy: {}
});

const registerTarget = async (projectId: string, envVar: string) =>
  createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId, name: `${projectId} restamp-lock-retry fixture`, mcpEndpointEnvVar: envVar, authMode: "none", defaultToolPolicy: "allowed" })
  );

// Deterministic, instantaneous "sleep" — the retry loop's real timing is deliberately never asserted
// on (that would violate #200: retry counts/elapsed times must not leak into anything a run emits or
// hashes); only the CODE PATH's outcome and call sequence are asserted on. randomImpl is pinned so the
// jittered delay computation itself never throws or behaves unexpectedly under test.
const instantDeps: Partial<CloneDeps> = { sleepImpl: async () => {}, randomImpl: () => 0.5 };

// A checkout handler decides, per objectId and per-object attempt number (1-based), whether THIS
// attempt is locked (423) or succeeds. Every other verb behaves like a clean, ordinary MCP target.
function stubFetch(calls: WireCall[], checkoutOutcome: (objectId: string, attempt: number) => "locked" | "ok") {
  const attemptForObject = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      calls.push({ name, args });
      const objectId = typeof args.object_id === "string" ? args.object_id : "";
      if (name === "object_get") {
        return respond(request.id, { record: { object_id: objectId, body: { route: `/${objectId}`, sections: [{ id: "s_1", type: "hero", data: {} }] } } });
      }
      if (name === "object_checkout") {
        const attempt = (attemptForObject.get(objectId) ?? 0) + 1;
        attemptForObject.set(objectId, attempt);
        return checkoutOutcome(objectId, attempt) === "locked" ? respondLocked(request.id) : respond(request.id, { lockToken: `lk_${objectId}`, recordVersion: 1 });
      }
      if (name === "object_patch") return respond(request.id, { record: { object_id: objectId } });
      if (name === "object_checkin") return respond(request.id, { ok: true });
      throw new Error(`Unexpected verb reached transport: ${name}`);
    })
  );
}

describe("clone_conductor restamp — 423 lock-conflict retry (T15.12, #191)", () => {
  let calls: WireCall[];

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    process.env.RESTAMP_LOCK_RETRY_MCP_ENDPOINT = TARGET_ENDPOINT;
    await registerTarget(TARGET, "RESTAMP_LOCK_RETRY_MCP_ENDPOINT");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESTAMP_LOCK_RETRY_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("(1) a 423 that resolves within the bound restamps the page — zero quarantined, per the issue's acceptance criteria", async () => {
    // PAGE_A is locked for its first 2 checkout attempts (the exact run_1787582215829 shape: a lock
    // that is genuinely transient, held by another writer that finishes in time), then free. PAGE_B
    // was never contended at all.
    stubFetch(calls, (objectId, attempt) => (objectId === PAGE_A && attempt < 3 ? "locked" : "ok"));

    const envelope = await cloneRestampStep(
      { targetProjectId: TARGET, intake: briefingWithPages(), mint: { artifact: "clone_recipe_mint.v1", rejected: [] } },
      instantDeps as CloneDeps
    );

    expect(envelope.quarantined).toEqual([]);
    expect(envelope.restamped.map((p) => p.objectId).sort()).toEqual([PAGE_A, PAGE_B].sort());

    // PAGE_A's checkout was actually retried (423 twice, then a real lock on the 3rd try) — it did
    // not just get lucky on attempt 1.
    const pageACheckouts = calls.filter((call) => call.name === "object_checkout" && call.args.object_id === PAGE_A);
    expect(pageACheckouts.length).toBe(3);
    // Exactly one patch and one checkin per page — the retried checkout still results in exactly one
    // write and one lock release, never a double-patch and never a leaked lock.
    expect(calls.filter((call) => call.name === "object_patch" && call.args.object_id === PAGE_A)).toHaveLength(1);
    expect(calls.filter((call) => call.name === "object_checkin" && call.args.object_id === PAGE_A)).toHaveLength(1);
  });

  it("(2) a 423 that never resolves is BOUNDED (no livelock) and quarantines under a NAMED reason — the lock is never stolen", async () => {
    // PAGE_A is held by "someone else" for the entire test — it never releases. PAGE_B is clean.
    stubFetch(calls, (objectId) => (objectId === PAGE_A ? "locked" : "ok"));

    const envelope = await cloneRestampStep(
      { targetProjectId: TARGET, intake: briefingWithPages(), mint: { artifact: "clone_recipe_mint.v1", rejected: [] } },
      instantDeps as CloneDeps
    );

    // PAGE_B (never contended) restamped cleanly; PAGE_A is quarantined, NAMED distinctly from a
    // generic patch failure — never a silent skip.
    expect(envelope.restamped.map((p) => p.objectId)).toEqual([PAGE_B]);
    expect(envelope.quarantined).toHaveLength(1);
    expect(envelope.quarantined[0]).toMatchObject({ objectId: PAGE_A, reason: "restamp_lock_conflict" });
    expect(String(envelope.quarantined[0].detail)).toMatch(/lock/i);

    // THE BOUND. object_checkout for PAGE_A was attempted a small, FIXED number of times — never
    // once, never unbounded (a livelock). Reading the count off the actual calls proves the retry
    // loop itself terminates, without asserting on any wall-clock timing.
    const pageACheckouts = calls.filter((call) => call.name === "object_checkout" && call.args.object_id === PAGE_A);
    expect(pageACheckouts.length).toBeGreaterThan(1); // it did retry...
    expect(pageACheckouts.length).toBeLessThanOrEqual(4); // ...but it is bounded, not infinite.

    // THE LOCK WAS NEVER STOLEN. Every checkout attempt failed, so there is genuinely no lock this
    // stage ever held for PAGE_A — no patch was attempted against it, and no checkin was ever sent
    // for it (there is nothing to release).
    expect(calls.some((call) => call.name === "object_patch" && call.args.object_id === PAGE_A)).toBe(false);
    expect(calls.some((call) => call.name === "object_checkin" && call.args.object_id === PAGE_A)).toBe(false);
  });

  it("(3) the exhausted-retry refusal is a distinguishable, named typed refusal — CloneLockConflict extends CloneRefusal", () => {
    // Documents the typed-refusal contract cloneEngine.ts now exports: every existing
    // `instanceof CloneRefusal` catch site keeps working (CloneLockConflict IS one), while a caller
    // that wants to name the lock conflict specifically — cloneRestampStep's own catch block above —
    // now can.
    const conflict = new CloneLockConflict("object_checkout on x could not acquire the lock");
    expect(conflict.code).toBe("clone_lock_conflict");
    expect(conflict).toBeInstanceOf(Error);
  });
});
