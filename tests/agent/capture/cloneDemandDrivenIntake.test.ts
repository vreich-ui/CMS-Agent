import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloneIntakeStep,
  cloneMintStep,
  cloneThemeBindStep,
  cloneRestampStep,
  buildCloneReportStep,
  CLONE_ARTIFACTS
} from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T15.30 (#206; ADR-2026-08-25-structure-studio §3) — "one node graph, two entry adapters."
// clone_intake normalizes EITHER a captureRunId (clone-driven) or a structureBrief (demand-driven)
// into the SAME clone_intake.v1 shape. This suite covers:
//   (a) the demand-driven intake itself — success shape, refusals, mismatches derived from the brief;
//   (b) CONVERGENCE — a demand-driven intake built against the SAME target as a clone-driven one
//       carries byte-identical registry/site/theme/recipes content, and feeding the SAME downstream
//       design/proposal to both produces byte-identical recipe_mint / theme_bind / restamp / report
//       output — proving no captureRunId (or anything else clone-specific) leaks past clone_intake
//       into what any downstream stage hashes or emits.

const TARGET = "clone-demand-target";
const TARGET_ENDPOINT = "https://clone-demand-target.example/mcp";
const SITE_ID = "site_demand";
const THEME_ID = "theme_demand";
const CAPTURE_RUN_ID = "run_capture_demand_fixture";

const SITE_BRAND_TOKENS = {
  colors: { "brand-primary": "#123456", "brand-secondary": "#654321" },
  fonts: { body: "Inter, sans-serif" }
};

const COMPONENT_REGISTRY = {
  definitions: [
    { type: "hero", data_schema: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } }, required: ["heading"] } }
  ]
};
const PAGE_TYPE_REGISTRY = { definitions: [{ id: "landing", allowedSections: "any", requiredSections: [] }] };

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type WireCall = { name: string; args: Record<string, unknown> };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

const registerTarget = async () =>
  createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: TARGET, name: "Demand-driven fixture target", mcpEndpointEnvVar: "CLONE_DEMAND_TARGET_MCP_ENDPOINT", authMode: "none", defaultToolPolicy: "allowed" })
  );

// The capture run backing the CLONE-DRIVEN half of the convergence comparison. Zero pages, on
// purpose: the property under test is that recipe_mint/theme_bind/restamp/report never read
// captureRunId or `pages` shape — only registry/site/theme/recipes, which both entries resolve
// identically against the SAME mocked target. A capture run with real pages would only add page
// content the convergence assertions below deliberately don't need to reason about.
const captureRunFixture = () => ({
  runId: CAPTURE_RUN_ID,
  projectId: TARGET,
  stageOutputs: {
    capture_crawl: { snapshot: { schemaVersion: "capture-snapshot.v1", pages: [] } },
    capture_map: { mapping: { schemaVersion: "capture-map.v1", pages: [] } },
    capture_theme: { theme: { name: "Captured draft", tokens: { colors: {}, fonts: {} } } }
  }
});

describe("clone_conductor demand-driven intake", () => {
  let calls: WireCall[];
  let siteRows: Array<Record<string, unknown>>;

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    siteRows = [{ object_id: SITE_ID, object_type: "site", status: "active" }];
    process.env.CLONE_DEMAND_TARGET_MCP_ENDPOINT = TARGET_ENDPOINT;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const name = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        calls.push({ name, args });
        if (name === "registry_get") return respond(request.id, args.registry === "component" ? COMPONENT_REGISTRY : PAGE_TYPE_REGISTRY);
        if (name === "object_inventory") {
          if (args.object_type === "site") return respond(request.id, { objects: siteRows });
          if (args.object_type === "theme") return respond(request.id, { objects: [{ object_id: THEME_ID, object_type: "theme", status: "active" }] });
          return respond(request.id, { objects: [] });
        }
        if (name === "object_get" && args.object_type === "site") {
          return respond(request.id, { record: { object_id: SITE_ID, body: { name: "Fixture site", brandTokens: SITE_BRAND_TOKENS } } });
        }
        if (name === "object_get" && args.object_type === "theme") {
          return respond(request.id, { record: { object_id: THEME_ID, body: { name: "Site theme", tokens: { colors: { "brand-primary": "#123456" }, fonts: { body: "Inter, sans-serif" } } } } });
        }
        throw new Error(`Unexpected verb reached transport during clone demand intake: ${name}`);
      })
    );

    await registerTarget();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLONE_DEMAND_TARGET_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const executionDeps = () => ({ executionRepository: { getRun: async () => captureRunFixture() } as never });

  const brief = (overrides: Record<string, unknown> = {}) => ({
    sourceUrl: "https://tenant.example/reference",
    needs: [{ pageRef: "need_hero", kind: "section_template", sourceShape: ["hero"], rationale: "Tenant wants a reusable hero block." }],
    ...overrides
  });

  it("(a) normalizes a structureBrief into the SAME clone_intake.v1 shape: entryMode, null captureRunId, and mismatches in layout_analyst's own vocabulary", async () => {
    const envelope = await cloneIntakeStep({ targetProjectId: TARGET, structureBrief: brief() }, executionDeps());

    expect(envelope.artifact).toBe(CLONE_ARTIFACTS.intake);
    expect(envelope.entryMode).toBe("demand");
    expect(envelope.captureRunId).toBeNull();
    expect(envelope.sourceUrl).toBe("https://tenant.example/reference");
    expect(envelope.pages).toEqual([]);
    expect(envelope.mismatches).toEqual([
      { pageRef: "need_hero", sourceShape: ["hero"], emittedShape: [], missingRecipeKind: "section_template", rationale: "Tenant wants a reusable hero block." }
    ]);
    // No capture run was ever consulted — a demand-driven intake never looks one up.
    expect(calls.some((call) => call.name === "capture_crawl" || call.name === "capture_map")).toBe(false);
    expect(envelope.site).toEqual({ objectId: SITE_ID, palette: SITE_BRAND_TOKENS });
    expect(envelope.registry.sectionTypes.hero).toEqual({ fields: ["body", "heading"], required: ["heading"] });
  });

  it("(a) an optional structureBrief.pages passthrough restamps existing pages once the brief asks — same CloneBriefingPage shape a clone-driven run derives from its mapping", async () => {
    const envelope = await cloneIntakeStep(
      { targetProjectId: TARGET, structureBrief: brief({ pages: [{ objectId: "pg_existing", route: "/about", sourceShape: ["prose"] }] }) },
      executionDeps()
    );
    expect(envelope.pages).toEqual([{ pageRef: "pg_existing", objectId: "pg_existing", route: "/about", sourceShape: ["prose"], emittedShape: [], gaps: [], candidateIds: [] }]);
  });

  it("(a) refuses when neither captureRunId nor structureBrief is supplied", async () => {
    await expect(cloneIntakeStep({ targetProjectId: TARGET }, executionDeps())).rejects.toMatchObject({ code: "clone_source_missing" });
    expect(calls).toEqual([]);
  });

  it("(a) refuses a structureBrief with no needs — an empty demand-driven request is a caller error, not an empty-but-valid run", async () => {
    await expect(cloneIntakeStep({ targetProjectId: TARGET, structureBrief: { sourceUrl: "https://tenant.example/", needs: [] } }, executionDeps())).rejects.toMatchObject({ code: "clone_intake_invalid" });
  });

  it("(a) refuses a need whose kind is not section_template/template — the recipe vocabulary is total, not guessed", async () => {
    await expect(
      cloneIntakeStep({ targetProjectId: TARGET, structureBrief: brief({ needs: [{ pageRef: "n1", kind: "theme" }] }) }, executionDeps())
    ).rejects.toMatchObject({ code: "clone_intake_invalid" });
  });

  it("(a) refuses a structureBrief entirely absent when no captureRunId is given", async () => {
    await expect(cloneIntakeStep({ targetProjectId: TARGET, structureBrief: undefined }, executionDeps())).rejects.toMatchObject({ code: "clone_source_missing" });
  });

  describe("(b) CONVERGENCE — clone-driven and demand-driven intakes against the SAME target", () => {
    it("carry byte-identical registry/site/theme/recipes; only entryMode and captureRunId differ", async () => {
      const cloneIntake = await cloneIntakeStep({ targetProjectId: TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps());
      const demandIntake = await cloneIntakeStep({ targetProjectId: TARGET, structureBrief: brief() }, executionDeps());

      expect(cloneIntake.registry).toEqual(demandIntake.registry);
      expect(cloneIntake.site).toEqual(demandIntake.site);
      expect(cloneIntake.theme).toEqual(demandIntake.theme);
      expect(cloneIntake.recipes).toEqual(demandIntake.recipes);
      expect(cloneIntake.target).toBe(demandIntake.target);

      expect(cloneIntake.entryMode).toBe("clone");
      expect(demandIntake.entryMode).toBe("demand");
      expect(cloneIntake.captureRunId).toBe(CAPTURE_RUN_ID);
      expect(demandIntake.captureRunId).toBeNull();
    });

    it("feeding the SAME design into recipe_mint against each intake produces byte-identical applied/rejected/reused/substitutions — no captureRunId leaks into what mint emits", async () => {
      const cloneIntake = await cloneIntakeStep({ targetProjectId: TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps());
      const demandIntake = await cloneIntakeStep({ targetProjectId: TARGET, structureBrief: brief() }, executionDeps());

      const design = {
        sectionTemplates: [{ name: "Reusable Hero", whenToUse: "Landing pages that need a bold opener.", blueprint_type: "hero", blueprint: { type: "hero", data: { heading: "Welcome" } } }],
        templates: []
      };

      // object_create for the mint stage: deterministic (target+name-derived requestedId), so both
      // calls hit the SAME requestedId and this stub can answer identically either way.
      const createHandler = vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const args = request.params?.arguments ?? {};
        return respond(request.id, { record: { object_id: args.requestedId, body: args.body } });
      });
      vi.stubGlobal("fetch", createHandler);

      const cloneMint = await cloneMintStep({ targetProjectId: TARGET, intake: cloneIntake, design });
      const demandMint = await cloneMintStep({ targetProjectId: TARGET, intake: demandIntake, design });

      expect(demandMint.applied).toEqual(cloneMint.applied);
      expect(demandMint.rejected).toEqual(cloneMint.rejected);
      expect(demandMint.reused).toEqual(cloneMint.reused);
      expect(demandMint.substitutions).toEqual(cloneMint.substitutions);
      expect(cloneMint.applied).toHaveLength(1);
    });

    it("feeding the SAME theme proposal into theme_bind against each intake produces byte-identical applied/dropped tokens", async () => {
      const cloneIntake = await cloneIntakeStep({ targetProjectId: TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps());
      const demandIntake = await cloneIntakeStep({ targetProjectId: TARGET, structureBrief: brief() }, executionDeps());

      const themeProposal = { colors: { "brand-primary": "#ABCDEF", "brand-secondary": "#654321" }, fonts: { body: "Inter, sans-serif" } };

      const themeBindHandler = vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const name = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        if (name === "object_get" && args.object_type === "site") return respond(request.id, { record: { object_id: SITE_ID, body: { brandTokens: SITE_BRAND_TOKENS } } });
        if (name === "object_get" && args.object_type === "theme") return respond(request.id, { record: { object_id: THEME_ID, body: { tokens: {} } } });
        if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}`, recordVersion: 1 });
        if (name === "object_patch") return respond(request.id, {});
        if (name === "site_apply_theme") return respond(request.id, {});
        if (name === "object_checkin") return respond(request.id, {});
        throw new Error(`Unexpected verb reached transport during theme_bind convergence: ${name}`);
      });
      vi.stubGlobal("fetch", themeBindHandler);

      const cloneBind = await cloneThemeBindStep({ targetProjectId: TARGET, intake: cloneIntake, themeProposal });
      const demandBind = await cloneThemeBindStep({ targetProjectId: TARGET, intake: demandIntake, themeProposal });

      expect(demandBind.applied).toEqual(cloneBind.applied);
      expect(demandBind.dropped).toEqual(cloneBind.dropped);
      expect(demandBind.substitutions).toEqual(cloneBind.substitutions);
      expect(demandBind.siteId).toBe(cloneBind.siteId);
      expect(demandBind.themeId).toBe(cloneBind.themeId);
    });

    it("restamp and the terminal report converge too: both intakes name zero pages, so both produce an empty restamp and matching report ledgers", async () => {
      const cloneIntake = await cloneIntakeStep({ targetProjectId: TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps());
      const demandIntake = await cloneIntakeStep({ targetProjectId: TARGET, structureBrief: brief() }, executionDeps());

      const mintReport = { rejected: [], substitutions: [] };
      const cloneRestamp = await cloneRestampStep({ targetProjectId: TARGET, intake: cloneIntake, mint: mintReport as never });
      const demandRestamp = await cloneRestampStep({ targetProjectId: TARGET, intake: demandIntake, mint: mintReport as never });
      expect(demandRestamp.restamped).toEqual(cloneRestamp.restamped);
      expect(demandRestamp.skipped).toEqual(cloneRestamp.skipped);
      expect(demandRestamp.quarantined).toEqual(cloneRestamp.quarantined);
      expect(cloneRestamp.restamped).toEqual([]);

      const mint = { applied: [{ objectType: "section_template", objectId: "stpl_x" }], reused: [], rejected: [], substitutions: [] };
      const themeBind = { applied: { colors: {}, fonts: {} }, dropped: [], substitutions: [] };
      const restamp = { restamped: [], skipped: [], quarantined: [], appliedSubstitutions: [], substitutionRejections: [] };

      const cloneReport = buildCloneReportStep({ intake: cloneIntake, mint: mint as never, themeBind: themeBind as never, restamp: restamp as never });
      const demandReport = buildCloneReportStep({ intake: demandIntake, mint: mint as never, themeBind: themeBind as never, restamp: restamp as never });
      expect(demandReport.mint).toEqual(cloneReport.mint);
      expect(demandReport.theme).toEqual(cloneReport.theme);
      expect(demandReport.restamp).toEqual(cloneReport.restamp);
      expect(demandReport.substitutions).toEqual(cloneReport.substitutions);
      expect(demandReport.reviewQueue).toEqual(cloneReport.reviewQueue);
    });
  });
});
