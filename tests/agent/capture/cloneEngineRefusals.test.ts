import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloneIntakeStep,
  cloneRestampStep,
  cloneThemeBindStep,
  __test__ as cloneEngineTest,
  type CloneDeps
} from "../../../src/agent/capture/cloneEngine.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";

// T13.1 — the clone_conductor write laws that HARD RULES calls out by name, tested directly against
// cloneEngine.ts (mirroring the capture engine's own unit-level refusal coverage):
//   (f) FORBIDDEN_VERBS is refused BEFORE any wire call, for every clone stage — proven here at the
//       shared callProjectTool seam every write-capable stage goes through.
//   (g) theme_bind REFUSES, and does not partially execute, when the theme apply plan carries a
//       theme_not_total refusal.
// T13.2 (CLONE-INTAKE-FIX.md) adds the fetches the bounded briefing made necessary:
//   (h) intake object_gets the SITE (whose id must resolve to EXACTLY ONE active site object) and the
//       captured THEME, and publishes a briefing that reports its own true size.
//   (i) restamp object_gets each page body it is about to patch instead of reading it from the
//       envelope — and still SKIPS a page whole, never half-restamps it.
describe("clone_conductor pre-transport refusals", () => {
  it("(f) refuses a forbidden verb before any wire call — the project is never even looked up", async () => {
    for (const verb of ["object_publish", "release_to_production", "trigger_netlify_build", "deploy"]) {
      const getSpy = vi.fn();
      const deps: CloneDeps = { projectRepository: { get: getSpy } as unknown as ProjectRepository };
      await expect(cloneEngineTest.callProjectTool("some-target", verb, {}, deps)).rejects.toMatchObject({ code: "forbidden_verb" });
      expect(getSpy, `${verb} must never reach the project repository, let alone the wire`).not.toHaveBeenCalled();
    }
  });

  it("(f) every FORBIDDEN_VERBS member clone_conductor's contract names is covered", () => {
    expect([...cloneEngineTest.FORBIDDEN_VERBS].sort()).toEqual(["deploy", "object_publish", "release_to_production", "trigger_netlify_build"]);
  });
});

const TARGET = "theme-refusal-target";
const TARGET_ENDPOINT = "https://theme-refusal-target.example/mcp";
const SITE_ID = "site_x";
const THEME_ID = "thm_capture_x";
const CAPTURE_RUN_ID = "run_capture_1";

// T13.3(d) — copied from OpenAINodeRunner.ts line 16 (and the identical line in
// AnthropicNodeRunner.ts) — the executor's per-node prompt redactor. Any key at any depth of a
// node's input matching this pattern has its value silently replaced with "[REDACTED]" before the
// model ever sees it. `cloneIntakeStep` stamps a NON-SECRET POLICY VIEW (clonePolicyView,
// cloneEngine.ts) on top of the engine's own clone.mjs briefing — a surface clone.mjs's own guard
// test (clone.test.mjs) never sees — so it needs this check run against it separately.
const REDACTOR_KEY_RE = /api[_-]?key|authorization|bearer|jwt|cookie|token|secret|blob.*credential/i;

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type WireCall = { name: string; args: Record<string, unknown> };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

const SITE_BRAND_TOKENS = {
  colors: { "brand-primary": "#111111", "brand-secondary": "#222222" },
  fonts: { body: "Inter, sans-serif" }
};

// The T13.2 briefing shape: shapes, slots and vocabulary, with the site's palette and the captured
// theme's palette resolved ONCE at intake. No `schemaVersion`, no `source`, no `emitted`, no full page
// bodies — the deterministic stages fetch what they need.
// T13.3: the briefing fields are `site.palette`/`theme.palette`, not `site.brandTokens`/
// `theme.tokens` — the executor's per-node prompt redactor (`/token/i`, OpenAINodeRunner.ts) matched
// both old names and silently replaced the whole palette with "[REDACTED]" before a model saw it.
// The real platform fields these are read FROM (siteBody.brandTokens, theme body.tokens — see the
// object_get mocks below) are unchanged; only the outgoing briefing key names moved.
const briefing = (overrides: Record<string, unknown> = {}) => ({
  artifact: "clone_intake.v1",
  summary: "Bounded clone briefing for the fixture target.",
  captureRunId: CAPTURE_RUN_ID,
  target: TARGET,
  site: { objectId: SITE_ID, palette: SITE_BRAND_TOKENS },
  theme: { objectId: THEME_ID, name: "Captured theme", palette: { colors: {}, fonts: {} } },
  registry: { sectionTypes: {}, pageTypes: {} },
  pages: [],
  recipes: { section_template: [], template: [] },
  budget: { chars: 0, cap: 32000, truncated: [] },
  policy: {},
  ...overrides
});

const registerTarget = async (projectId: string, defaultToolPolicy: "allowed" | "blocked", envVar: string) =>
  createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId, name: `${projectId} acceptance target`, mcpEndpointEnvVar: envVar, authMode: "none", defaultToolPolicy })
  );

describe("clone_conductor theme_bind totality refusal", () => {
  let calledVerbs: string[];

  beforeEach(async () => {
    resetRepositoryManager();
    calledVerbs = [];
    process.env.THEME_REFUSAL_TARGET_MCP_ENDPOINT = TARGET_ENDPOINT;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const name = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        calledVerbs.push(name);
        if (name === "object_get" && args.object_type === "site") {
          return respond(request.id, { record: { object_id: SITE_ID, body: { brandTokens: SITE_BRAND_TOKENS } } });
        }
        if (name === "object_get" && args.object_type === "theme") {
          return respond(request.id, { record: { object_id: THEME_ID, body: { tokens: {} } } });
        }
        // A totality refusal must stop the stage before ANY of these are ever reached — checkout,
        // patch, checkin, or site_apply_theme reaching the transport is the "partially executed" bug
        // the contract forbids.
        throw new Error(`Unexpected verb reached transport during a theme_not_total refusal: ${name}`);
      })
    );

    await registerTarget(TARGET, "allowed", "THEME_REFUSAL_TARGET_MCP_ENDPOINT");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.THEME_REFUSAL_TARGET_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("(g) refuses without executing any step when the proposal covers only some of the site's color slots", async () => {
    // The BRIEFING is the single authority on the site's palette now (CLONE-INTAKE-FIX.md Defect A):
    // it declares TWO color slots (brand-primary, brand-secondary) and this proposal covers only one,
    // so validateThemeProposal's missingKeys is non-empty and buildThemeApplyPlan must refuse rather
    // than apply an exact-replace that would delete brand-secondary.
    const intake = briefing();
    const themeProposal = { colors: { "brand-primary": "#333333" }, fonts: {} };

    await expect(cloneThemeBindStep({ targetProjectId: TARGET, intake, themeProposal })).rejects.toMatchObject({ code: "theme_not_total" });

    // Belt-and-braces: nothing beyond the two read-only object_get calls (site + theme) ever reached
    // the wire — no checkout was taken (so nothing needed releasing), no patch, no site_apply_theme.
    expect(calledVerbs.sort()).toEqual(["object_get", "object_get"]);
  });

  it("refuses with the named policy reason, before any lock, when site_apply_theme is blocked by tool policy", async () => {
    await registerTarget(`${TARGET}-blocked`, "blocked", "THEME_REFUSAL_TARGET_MCP_ENDPOINT");
    const intake = briefing({ target: `${TARGET}-blocked` });
    const themeProposal = { colors: { "brand-primary": "#333333", "brand-secondary": "#444444" }, fonts: {} };

    await expect(cloneThemeBindStep({ targetProjectId: `${TARGET}-blocked`, intake, themeProposal })).rejects.toMatchObject({ code: "clone_theme_apply_policy_blocked" });
    // The policy gate runs BEFORE any object_get / checkout — nothing reached the wire at all.
    expect(calledVerbs).toEqual([]);
  });

  it("refuses when the briefing carries no captured theme objectId — the palette is never written blind", async () => {
    const intake = briefing({ theme: { objectId: null, name: null, palette: { colors: {}, fonts: {} } } });
    await expect(cloneThemeBindStep({ targetProjectId: TARGET, intake, themeProposal: { colors: {}, fonts: {} } })).rejects.toMatchObject({ code: "clone_theme_missing" });
    expect(calledVerbs).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T13.2 — the intake stage's own fetches.
const INTAKE_TARGET = "clone-intake-target";

const COMPONENT_REGISTRY = {
  definitions: [
    { type: "hero", data_schema: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } }, required: ["heading"] } }
  ]
};
const PAGE_TYPE_REGISTRY = { definitions: [{ id: "clone", allowedSections: "any", requiredSections: [] }] };

const captureRunFixture = () => ({
  runId: CAPTURE_RUN_ID,
  projectId: INTAKE_TARGET,
  stageOutputs: {
    capture_crawl: { snapshot: { schemaVersion: "capture-snapshot.v1", pages: [] } },
    capture_map: {
      mapping: {
        schemaVersion: "capture-map.v1",
        pages: [
          {
            pageRef: "page_home",
            pageBody: { route: "/", sections: [{ type: "hero" }] },
            candidates: [{ candidateId: "cand_1", sectionType: "hero" }],
            blockAccounting: [{ status: "mapped", candidateId: "cand_1" }],
            gaps: []
          }
        ]
      }
    },
    capture_theme: { theme: { name: "Captured draft", tokens: { colors: { "brand-primary": "#111111" }, fonts: {} } } },
    capture_emit_live: {
      report: {
        creates: [
          { objectType: "page", pageRef: "page_home", requestedId: "pg_home", body: { route: "/", sections: [{ type: "hero" }] } },
          { objectType: "theme", requestedId: THEME_ID }
        ],
        createdObjects: [
          { objectType: "page", objectId: "pg_home" },
          { objectType: "theme", objectId: THEME_ID }
        ],
        reusedObjects: []
      }
    }
  }
});

const executionDeps = (): CloneDeps => ({
  executionRepository: { getRun: async () => captureRunFixture() } as unknown as ExecutionRepository
});

describe("clone_conductor intake fetches the site and theme bodies", () => {
  let calls: WireCall[];
  let siteRows: Array<Record<string, unknown>>;

  const objectGets = () => calls.filter((call) => call.name === "object_get").map((call) => ({ object_type: call.args.object_type, object_id: call.args.object_id }));

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    siteRows = [{ object_id: SITE_ID, object_type: "site", status: "active" }];
    process.env.CLONE_INTAKE_TARGET_MCP_ENDPOINT = "https://clone-intake-target.example/mcp";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
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
          return respond(request.id, { record: { object_id: THEME_ID, body: { name: "Captured theme", tokens: { colors: { "brand-primary": "#111111" }, fonts: { body: "Inter, sans-serif" } } } } });
        }
        // T2 (2026-08-26): intake now also reads each briefed page's LIVE body, to state what it
        // compared. The live shape here MATCHES the briefing's emitted shape, so the ledger below
        // reports no drift for this page.
        if (name === "object_get" && args.object_type === "page") {
          return respond(request.id, { record: { object_id: String(args.object_id), body: { route: "/", sections: [{ type: "hero" }] } } });
        }
        throw new Error(`Unexpected verb reached transport during clone intake: ${name}`);
      })
    );

    await registerTarget(INTAKE_TARGET, "allowed", "CLONE_INTAKE_TARGET_MCP_ENDPOINT");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLONE_INTAKE_TARGET_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("(h) object_gets exactly the site body, the captured theme record, and each briefed page's live body", async () => {
    const envelope = await cloneIntakeStep({ targetProjectId: INTAKE_TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps());

    // T2 (2026-08-26): the page read is NEW and it is deliberate — the delta ledger below is what
    // lets a run say what it compared. It is not new spend at the run level: cloneRestampStep already
    // fetches every briefed page's body, so intake reads the objects this run was always going to
    // read, early enough that what it learns can be reported.
    expect(objectGets()).toEqual([
      { object_type: "site", object_id: SITE_ID },
      { object_type: "theme", object_id: THEME_ID },
      { object_type: "page", object_id: "pg_home" }
    ]);
    // Defect A: the site's palette comes from the object_get BODY. An object_inventory row has none,
    // which is what left the live run's theme_reconciler with no slots to enumerate.
    // T13.3: the briefing key is `palette`, not `brandTokens` — see the comment above `briefing()`.
    expect(envelope.site).toEqual({ objectId: SITE_ID, palette: SITE_BRAND_TOKENS });
    expect(envelope.theme.objectId).toBe(THEME_ID);
    expect(envelope.theme.palette).toEqual({ colors: { "brand-primary": "#111111" }, fonts: { body: "Inter, sans-serif" } });
    expect(envelope.pages).toEqual([
      { pageRef: "page_home", objectId: "pg_home", route: "/", sourceShape: ["hero"], emittedShape: ["hero"], gaps: [], candidateIds: ["cand_1"] }
    ]);
    // Field NAMES, never the 32KB of Zod-derived JSON Schema that was 68% of the old budget.
    expect(envelope.registry.sectionTypes.hero).toEqual({ fields: ["body", "heading"], required: ["heading"] });
  });

  it("(h) the envelope is a BRIEFING: no schemaVersion, no snapshot/mapping bus, and budget.chars is the truth", async () => {
    const envelope = await cloneIntakeStep({ targetProjectId: INTAKE_TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps());

    expect(envelope.artifact).toBe("clone_intake.v1");
    expect(envelope).not.toHaveProperty("schemaVersion");
    expect(envelope).not.toHaveProperty("source");
    expect(envelope).not.toHaveProperty("emitted");
    expect(envelope).not.toHaveProperty("inventory");
    // The stage stamps its policy view ON TOP of the engine's briefing, so budget.chars is re-settled
    // against what actually travels — a briefing that under-reports its own size is the exact defect
    // CLONE-INTAKE-FIX.md exists to make unreachable.
    expect(envelope.policy).toBeDefined();
    expect(envelope.budget.chars).toBe(JSON.stringify(envelope).length);
    expect(envelope.budget.chars).toBeLessThanOrEqual(envelope.budget.cap);
  });

  it("(h) refuses when the target exposes ZERO active site objects — nothing is fetched or guessed", async () => {
    siteRows = [];
    await expect(cloneIntakeStep({ targetProjectId: INTAKE_TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps())).rejects.toMatchObject({ code: "clone_site_not_unique" });
    expect(objectGets()).toEqual([]);
  });

  it("(h) refuses when the target exposes MORE THAN ONE active site object — a clone writes onto one site", async () => {
    siteRows = [
      { object_id: SITE_ID, object_type: "site", status: "active" },
      { object_id: "site_second", object_type: "site", status: "active" }
    ];
    await expect(cloneIntakeStep({ targetProjectId: INTAKE_TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps())).rejects.toMatchObject({ code: "clone_site_not_unique" });
    expect(objectGets()).toEqual([]);
  });

  it("(h) a RETIRED site does not count toward the one active site the briefing requires", async () => {
    siteRows = [
      { object_id: SITE_ID, object_type: "site", status: "active" },
      { object_id: "site_old", object_type: "site", status: "retired" }
    ];
    const envelope = await cloneIntakeStep({ targetProjectId: INTAKE_TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps());
    expect(envelope.site.objectId).toBe(SITE_ID);
  });

  it("(policy, T13.3d) the intake STAGE's own policy.toolPolicies carries no key colliding with the credential redactor", async () => {
    // clonePolicyView (cloneEngine.ts) stamps this project's EFFECTIVE tool-permission map onto the
    // envelope; it is a surface clone.mjs's own briefing (and clone.mjs's own guard test) never sees,
    // so it needs checking separately. A realistic project's toolPolicies: every remote verb this
    // workflow's own stages call (registry_get, object_inventory/get/checkout/checkin/patch/create/
    // validate, the FORBIDDEN_VERBS, site_apply_theme) plus a broad sample of the platform's wider
    // remote tool surface a real project might also gate (commerce/membership/PDF/media tools) — tool
    // NAMES are fine to appear here; it is the KEYS of this map the redactor would ever act on.
    const REALISTIC_TOOL_POLICIES: Record<string, "allowed" | "blocked" | "needs_approval"> = {
      registry_get: "allowed",
      object_inventory: "allowed",
      object_get: "allowed",
      object_checkout: "allowed",
      object_checkin: "allowed",
      object_patch: "allowed",
      object_create: "allowed",
      object_create_variant: "allowed",
      object_validate: "allowed",
      object_list: "allowed",
      object_contract: "allowed",
      object_discard: "allowed",
      object_refresh_lock: "allowed",
      object_retire: "blocked",
      object_review_decide: "needs_approval",
      object_submit_review: "allowed",
      object_instantiate_template: "allowed",
      object_instantiate_section_template: "allowed",
      object_publish: "blocked",
      release_to_production: "blocked",
      trigger_netlify_build: "blocked",
      deploy: "blocked",
      site_apply_theme: "allowed",
      commerce_orders: "allowed",
      product_set_price: "needs_approval",
      order_reissue: "needs_approval",
      ownership_transfer: "blocked",
      membership_policy_get: "allowed",
      membership_policy_set: "needs_approval",
      membership_contract: "allowed",
      invitation_resend: "allowed",
      invitation_revoke: "needs_approval",
      publish_pdf_template: "blocked",
      validate_pdf_template: "allowed",
      create_pdf_template: "allowed",
      delete_pdf_template: "blocked",
      search_artifacts: "allowed",
      search_images: "allowed",
      set_image_model_policy: "allowed",
      set_image_search_policy: "allowed",
      update_image_search_candidate: "allowed",
      registry_search: "allowed",
      ping: "allowed"
    };
    await updateProject(repositoryManager.getProjectRepository(), INTAKE_TARGET, { toolPolicies: REALISTIC_TOOL_POLICIES });

    const envelope = await cloneIntakeStep({ targetProjectId: INTAKE_TARGET, captureRunId: CAPTURE_RUN_ID }, executionDeps());

    // Sanity: the fixture actually landed, so a passing assertion below means something.
    expect(Object.keys(envelope.policy.toolPolicies).length).toBe(Object.keys(REALISTIC_TOOL_POLICIES).length);

    const offenders = Object.keys(envelope.policy.toolPolicies).filter((key) => REDACTOR_KEY_RE.test(key));
    expect(offenders, `policy.toolPolicies key(s) collide with the executor credential redactor and would reach the model as "[REDACTED]": ${offenders.join(", ")}`).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T13.2 — the restamp stage's own fetches.
const RESTAMP_TARGET = "clone-restamp-target";
const PAGE_ID = "pg_home";
const LIVE_SECTIONS = [{ id: "s_1", type: "hero", data: { heading: "What the page holds NOW" } }];

describe("clone_conductor restamp fetches each page body", () => {
  let calls: WireCall[];

  const intake = (candidateIds: string[] = ["cand_1"]) =>
    briefing({
      target: RESTAMP_TARGET,
      pages: [{ pageRef: "page_home", objectId: PAGE_ID, route: "/", sourceShape: ["hero"], emittedShape: ["hero"], gaps: [], candidateIds }]
    });

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    process.env.CLONE_RESTAMP_TARGET_MCP_ENDPOINT = "https://clone-restamp-target.example/mcp";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const name = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        calls.push({ name, args });
        if (name === "object_get" && args.object_type === "page") {
          return respond(request.id, { record: { object_id: PAGE_ID, record_version: 4, body: { route: "/", sections: LIVE_SECTIONS } } });
        }
        if (name === "object_checkout") return respond(request.id, { lock_token: "lk_1", record_version: 4 });
        if (name === "object_patch") return respond(request.id, { record: { object_id: PAGE_ID } });
        if (name === "object_checkin") return respond(request.id, { ok: true });
        throw new Error(`Unexpected verb reached transport during restamp: ${name}`);
      })
    );

    await registerTarget(RESTAMP_TARGET, "allowed", "CLONE_RESTAMP_TARGET_MCP_ENDPOINT");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLONE_RESTAMP_TARGET_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("(i) object_gets the page body and restamps from THAT body, not from the envelope", async () => {
    const envelope = await cloneRestampStep({ targetProjectId: RESTAMP_TARGET, intake: intake(), mint: { artifact: "clone_recipe_mint.v1", rejected: [] } });

    expect(calls.map((call) => call.name)).toEqual(["object_get", "object_checkout", "object_patch", "object_checkin"]);
    expect(calls[0].args).toMatchObject({ object_type: "page", object_id: PAGE_ID });
    // The ops carry the sections the LIVE body holds — the briefing only ever named their types.
    const patch = calls.find((call) => call.name === "object_patch")!;
    expect(patch.args.ops).toEqual([{ op: "upsert_section", section: LIVE_SECTIONS[0], position: 0 }]);
    // Every checkout is paired with a checkin, in a finally.
    expect(calls[3].args).toMatchObject({ object_type: "page", object_id: PAGE_ID, lock_token: "lk_1" });
    expect(envelope.restamped.map((entry) => entry.objectId)).toEqual([PAGE_ID]);
    expect(envelope.skipped).toEqual([]);
    expect(envelope.quarantined).toEqual([]);
  });

  it("(i) SKIPS a page whose recipe was rejected at mint — fetched, then left untouched, never half-restamped", async () => {
    const envelope = await cloneRestampStep({
      targetProjectId: RESTAMP_TARGET,
      intake: intake(),
      mint: { artifact: "clone_recipe_mint.v1", rejected: [{ kind: "section_template", name: "x", reason: "unknown_section_type", sourceCandidateIds: ["cand_1"] }] }
    });

    // The body is still FETCHED: buildRestampOps checks "no body supplied" before it checks the
    // rejection, so withholding the fetch would relabel this skip as `source_page_missing`.
    expect(calls.map((call) => call.name)).toEqual(["object_get"]);
    expect(envelope.skipped).toEqual([{ objectId: PAGE_ID, reason: "recipe_rejected_at_mint" }]);
    expect(envelope.restamped).toEqual([]);
  });
});
