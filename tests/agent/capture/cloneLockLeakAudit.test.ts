import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneRestampStep, cloneThemeBindStep, type CloneDeps } from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T13.4 — THE LOCK-LEAK AUDIT.
//
// The live incident: object_checkout SUCCEEDED server-side (history recorded it, a lock was issued)
// but the OLD reader only recognized `lock_token`, the platform's real response carried `lockToken`,
// extraction came back `undefined`, the stage threw BEFORE ever recording the lock, and the lock
// leaked for the full 15-minute lease — nothing downstream ever called object_checkin for it.
//
// These tests prove two things hold now, for BOTH lock-taking paths in cloneEngine.ts
// (cloneThemeBindStep's theme+site pair, cloneRestampStep's per-page loop):
//   1. A checkout whose response uses ONLY camelCase (`lockToken`/`recordVersion`, no snake_case
//      sibling at all) is still recognized and its lock registered — the exact historical failure
//      mode, now closed by mcpBoundary's fromWireResult.
//   2. A registered lock is released even when a LATER step in the same sequence throws — release
//      does not depend on any step other than the checkout that took the lock.
const TARGET = "lock-leak-target";
const TARGET_ENDPOINT = "https://lock-leak-target.example/mcp";
const SITE_ID = "site_leak";
const THEME_ID = "thm_leak";

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type WireCall = { name: string; args: Record<string, unknown> };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

const respondError = (id: number, message: string) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: message }] } }) }) as unknown as Response;

const SITE_BRAND_TOKENS = {
  colors: { "brand-primary": "#111111", "brand-secondary": "#222222" },
  fonts: { body: "Inter, sans-serif" }
};
// A TOTAL proposal (CLONE-ENGINE-API.md §4's totality rule) — covers every color and font slot the
// site declares, so buildThemeApplyPlan actually returns steps instead of a theme_not_total refusal.
const TOTAL_THEME_PROPOSAL = { colors: { "brand-primary": "#333333", "brand-secondary": "#444444" }, fonts: { body: "Georgia, serif" } };

const registerTarget = async (projectId: string, envVar: string) =>
  createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId, name: `${projectId} lock-leak fixture`, mcpEndpointEnvVar: envVar, authMode: "none", defaultToolPolicy: "allowed" })
  );

const briefing = () => ({
  artifact: "clone_intake.v1",
  summary: "fixture",
  captureRunId: "run_1",
  target: TARGET,
  site: { objectId: SITE_ID, palette: SITE_BRAND_TOKENS },
  theme: { objectId: THEME_ID, name: "Captured theme", palette: { colors: {}, fonts: {} } },
  registry: { sectionTypes: {}, pageTypes: {} },
  pages: [],
  recipes: { section_template: [], template: [] },
  budget: { chars: 0, cap: 32000, truncated: [] },
  policy: {}
});

describe("clone_conductor lock-leak audit — theme_bind", () => {
  let calls: WireCall[];

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    process.env.LOCK_LEAK_TARGET_MCP_ENDPOINT = TARGET_ENDPOINT;
    await registerTarget(TARGET, "LOCK_LEAK_TARGET_MCP_ENDPOINT");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LOCK_LEAK_TARGET_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const stubFetch = (handlers: Partial<Record<string, (args: Record<string, unknown>, id: number) => Response>>) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const name = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        calls.push({ name, args });
        const handler = handlers[name];
        if (!handler) throw new Error(`Unexpected verb reached transport: ${name}`);
        return handler(args, request.id);
      })
    );
  };

  it("(1) a CAMELCASE-ONLY checkout response is recognized — the exact historical bug is closed", async () => {
    stubFetch({
      object_get: (args) =>
        args.object_type === "site"
          ? respond(0, { record: { object_id: SITE_ID, body: { brandTokens: SITE_BRAND_TOKENS } } })
          : respond(0, { record: { object_id: THEME_ID, body: { tokens: {} } } }),
      // NOTE: camelCase ONLY — no lock_token, no record_version anywhere in this response. The old
      // findLockToken() reader would have returned undefined here.
      object_checkout: (_args, id) => respond(id, { action: "checkout", lockToken: "lk_theme_camel", recordVersion: 9 }),
      object_patch: (_args, id) => respond(id, { record: { object_id: THEME_ID } }),
      object_checkin: (_args, id) => respond(id, { ok: true }),
      site_apply_theme: (args, id) => respond(id, { dry_run: args.dry_run === true, applied: true })
    });

    const envelope = await cloneThemeBindStep({ targetProjectId: TARGET, intake: briefing(), themeProposal: TOTAL_THEME_PROPOSAL });

    expect(envelope.applied.colors).toEqual(TOTAL_THEME_PROPOSAL.colors);
    const themeCheckin = calls.find((call) => call.name === "object_checkin" && call.args.object_type === "theme")!;
    expect(themeCheckin.args).toMatchObject({ object_type: "theme", object_id: THEME_ID, lock_token: "lk_theme_camel" });
    const themePatch = calls.find((call) => call.name === "object_patch")!;
    expect(themePatch.args).toMatchObject({ lock_token: "lk_theme_camel", expected_record_version: 9 });
  });

  it("(2) a failure AFTER a successful checkout still releases that lock — release does not depend on a later step", async () => {
    stubFetch({
      object_get: (args) =>
        args.object_type === "site"
          ? respond(0, { record: { object_id: SITE_ID, body: { brandTokens: SITE_BRAND_TOKENS } } })
          : respond(0, { record: { object_id: THEME_ID, body: { tokens: {} } } }),
      object_checkout: (_args, id) => respond(id, { lockToken: "lk_theme_camel", recordVersion: 9 }),
      // The step immediately AFTER checkout fails at the wire. The historical bug's failure mode was
      // extraction failing BEFORE registration; this proves the newer, harder case too — registration
      // already happened, and a wholly unrelated later failure must not un-register it.
      object_patch: (_args, id) => respondError(id, "simulated transport failure mid-sequence"),
      object_checkin: (_args, id) => respond(id, { ok: true })
    });

    await expect(cloneThemeBindStep({ targetProjectId: TARGET, intake: briefing(), themeProposal: TOTAL_THEME_PROPOSAL })).rejects.toBeTruthy();

    const themeCheckouts = calls.filter((call) => call.name === "object_checkout" && call.args.object_type === "theme");
    const themeCheckins = calls.filter((call) => call.name === "object_checkin" && call.args.object_type === "theme");
    expect(themeCheckouts, "the theme checkout must have been attempted").toHaveLength(1);
    expect(themeCheckins, "every checkout taken must be released, even though object_patch failed right after it").toHaveLength(1);
    expect(themeCheckins[0].args).toMatchObject({ object_type: "theme", object_id: THEME_ID, lock_token: "lk_theme_camel" });
    // The site lock was never taken (the theme step failed first) — nothing to leak or release there.
    expect(calls.some((call) => call.name === "object_checkout" && call.args.object_type === "site")).toBe(false);
  });

  it("(3) a failure on the SITE's real apply (after theme succeeded end-to-end) still releases the site lock", async () => {
    let applyCallCount = 0;
    stubFetch({
      object_get: (args) =>
        args.object_type === "site"
          ? respond(0, { record: { object_id: SITE_ID, body: { brandTokens: SITE_BRAND_TOKENS } } })
          : respond(0, { record: { object_id: THEME_ID, body: { tokens: {} } } }),
      object_checkout: (args, id) =>
        args.object_type === "theme" ? respond(id, { lockToken: "lk_theme", recordVersion: 9 }) : respond(id, { lockToken: "lk_site_camel", recordVersion: 3 }),
      object_patch: (_args, id) => respond(id, { record: { object_id: THEME_ID } }),
      object_checkin: (_args, id) => respond(id, { ok: true }),
      site_apply_theme: (args, id) => {
        if (args.dry_run === true) return respond(id, { dry_run: true, applied: false });
        applyCallCount += 1;
        return respondError(id, "simulated real-apply failure");
      }
    });

    await expect(cloneThemeBindStep({ targetProjectId: TARGET, intake: briefing(), themeProposal: TOTAL_THEME_PROPOSAL })).rejects.toBeTruthy();
    expect(applyCallCount).toBe(1);

    // The theme's checkout/patch/checkin all completed cleanly BEFORE the site half started.
    expect(calls.filter((call) => call.name === "object_checkin" && call.args.object_type === "theme")).toHaveLength(1);
    // The site checkout succeeded (camelCase-only) and the real apply failed — the site lock must
    // still have been released.
    const siteCheckins = calls.filter((call) => call.name === "object_checkin" && call.args.object_type === "site");
    expect(siteCheckins, "the site lock taken before the failed real-apply call must still be released").toHaveLength(1);
    expect(siteCheckins[0].args).toMatchObject({ object_type: "site", object_id: SITE_ID, lock_token: "lk_site_camel" });
  });
});

describe("clone_conductor lock-leak audit — restamp", () => {
  const PAGE_ID = "pg_leak";
  let calls: WireCall[];

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    process.env.LOCK_LEAK_RESTAMP_MCP_ENDPOINT = TARGET_ENDPOINT;
    await registerTarget(`${TARGET}-restamp`, "LOCK_LEAK_RESTAMP_MCP_ENDPOINT");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LOCK_LEAK_RESTAMP_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("a camelCase-only checkout followed by a patch failure still checks the page back in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const name = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        calls.push({ name, args });
        if (name === "object_get") return respond(request.id, { record: { object_id: PAGE_ID, body: { route: "/", sections: [{ id: "s_1", type: "hero", data: {} }] } } });
        // camelCase ONLY, same historical shape as the theme_bind case above.
        if (name === "object_checkout") return respond(request.id, { lockToken: "lk_page_camel", recordVersion: 7 });
        if (name === "object_patch") return respondError(request.id, "simulated patch failure");
        if (name === "object_checkin") return respond(request.id, { ok: true });
        throw new Error(`Unexpected verb reached transport: ${name}`);
      })
    );

    const intake = {
      artifact: "clone_intake.v1" as const,
      summary: "fixture",
      captureRunId: "run_1",
      target: `${TARGET}-restamp`,
      site: { objectId: SITE_ID, palette: SITE_BRAND_TOKENS },
      theme: { objectId: THEME_ID, name: "Captured theme", palette: { colors: {}, fonts: {} } },
      registry: { sectionTypes: {}, pageTypes: {} },
      pages: [{ pageRef: "page_home", objectId: PAGE_ID, route: "/", sourceShape: ["hero"], emittedShape: ["hero"], gaps: [], candidateIds: ["cand_1"] }],
      recipes: { section_template: [], template: [] },
      budget: { chars: 0, cap: 32000, truncated: [] },
      policy: {}
    };

    const envelope = await cloneRestampStep({
      targetProjectId: `${TARGET}-restamp`,
      intake,
      mint: { artifact: "clone_recipe_mint.v1", rejected: [] }
    });

    expect(envelope.restamped).toEqual([]);
    expect(envelope.quarantined).toEqual([{ objectId: PAGE_ID, reason: "restamp_patch_failed", detail: expect.stringContaining("simulated patch failure") }]);
    const checkins = calls.filter((call) => call.name === "object_checkin");
    expect(checkins, "the lock taken by the checkout must still be released even though the patch afterward failed").toHaveLength(1);
    expect(checkins[0].args).toMatchObject({ object_type: "page", object_id: PAGE_ID, lock_token: "lk_page_camel" });
  });
});
