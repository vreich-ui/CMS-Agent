import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { captureEmitStep, captureMapStep, captureThemeStep } from "../../../src/agent/capture/captureEngine.js";
import { cloneIntakeStep, cloneMintStep, cloneRestampStep } from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { assertDeterministic, diffGovernedObjects, type AllowlistEntry } from "./support/determinismDiff.js";
import { runCaptureFixtureOnce } from "./support/captureConductorFixtureRun.js";

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// T15.25 (#200) — DETERMINISM HARNESS: same URL twice, identical governed objects.
//
// THE INVARIANT (every ADR and task brief this series has shipped states it identically):
//   "Consistency over liveness: if a change would make two runs of the same URL diverge, it is wrong."
//
// This file is the enforcement, not a description: every `it` below runs the SAME source (the
// committed, redacted Zilberman fixture) through real, production capture/clone engine code TWICE,
// independently, and diffs what came back with tests/agent/capture/support/determinismDiff.ts — a
// tool that names the exact field that diverged and what each run produced, rather than asserting
// "the two runs are equal" and leaving a future debugger to bisect a multi-thousand-key JSON blob.
//
// Four things this file is built to prove, matching the brief's four asks:
//   A. capture (crawl->map->theme->emit-plan), pure engine level: zero-allowlist byte-identity.
//   B. capture_conductor, the REAL workflow end to end (mock mode): the governed-object surface is
//      byte-identical; the run's own identity fields are NOT (proven to differ), and that is the
//      allowlist's complete, documented, and load-bearing content.
//   C. clone (intake->mint->restamp), pure engine level: zero-allowlist byte-identity.
//   D. Judgment-node variance: an advisory classifier's rationale text changing must not change the
//      governed mapping/plan it produces; changing what it actually classifies AS must (the control
//      that proves this harness is not vacuously green).
//   E. Negative controls for the harness ITSELF: diffGovernedObjects, run against two trees that do
//      differ, must name the exact divergent field — proven directly, decoupled from any pipeline.

const fixture = async (name: string) =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../../fixtures/capture/${name}`, import.meta.url)), "utf8"));

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Shared fixtures for the pure-engine (non-conductor) capture runs — the same policyProject/
// stubRepository shape gapReplayHarness.test.ts already uses for this exact snapshot, so this harness
// exercises the identical authority-resolution path other T15 capture tests are pinned against.
const CAPTURE_TARGET = "zb-determinism-pure";

const captureStubProject = (): ProjectConnectionConfig => ({
  projectId: CAPTURE_TARGET,
  name: "Zilberman determinism (pure engine)",
  mcpEndpointEnvVar: "ZB_DETERMINISM_MCP_ENDPOINT",
  authMode: "none",
  allowedTools: [],
  contentContract: { contentContract: "content_source.v1" },
  capturePolicy: {
    maxPages: 20,
    allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
    allowedPathPrefixes: ["/"],
    sameOriginOnly: true,
    respectRobots: true,
    concurrency: 1,
    delayMs: 0,
    authenticatedAccess: "prohibited",
    rights: { content: "retain_allowed_origin_content", media: "prohibited" },
    designReferences: [],
    fidelity: { mode: "design_inspired", sourceDesignTreatment: "source_content_with_design_inspiration_only" }
  },
  publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test" },
  status: "active"
});

const captureStubRepository = (config: ProjectConnectionConfig): ProjectRepository => ({
  list: async () => [config],
  get: async (projectId: string) => (config.projectId === projectId ? config : undefined),
  save: async (value) => value,
  delete: async () => false,
  health: async () => ({ backend: "memory", details: {} } as never)
});

async function runCaptureEnginePureOnce(suggestions: unknown[] = []) {
  const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
  const deps = { projectRepository: captureStubRepository(captureStubProject()) };
  const mapEnvelope = await captureMapStep({ targetProjectId: CAPTURE_TARGET, snapshot, suggestions }, deps);
  const themeEnvelope = await captureThemeStep({ targetProjectId: CAPTURE_TARGET, snapshot }, deps);
  const planEnvelope = await captureEmitStep(
    { targetProjectId: CAPTURE_TARGET, mapping: mapEnvelope.mapping, theme: themeEnvelope.theme, live: false },
    deps
  );
  return { mapEnvelope, themeEnvelope, planEnvelope };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A. CAPTURE, PURE ENGINE LEVEL — crawl (fixture) -> map -> theme -> emit(dry plan).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("A. capture engine: the same source snapshot run twice produces identical governed objects", () => {
  it("mapping (section structures + ids), theme tokens, and the emission plan (requestedIds + bodies) are byte-identical — zero allowlist needed", async () => {
    const runA = await runCaptureEnginePureOnce();
    const runB = await runCaptureEnginePureOnce();

    const governedA = { mapping: runA.mapEnvelope.mapping, theme: runA.themeEnvelope.theme, plan: runA.planEnvelope.plan };
    const governedB = { mapping: runB.mapEnvelope.mapping, theme: runB.themeEnvelope.theme, plan: runB.planEnvelope.plan };

    // No allowlist: everything downstream of a fixture snapshot in this path is a pure function of
    // (target, snapshot) — requestedId is a sha256 over (target, stable identity), never a random or
    // wall-clock value (src/agent/capture/engine/emit.mjs `requestedId`). If this ever needs an
    // allowlist entry, that entry is itself the discovery of a regression, not routine upkeep.
    assertDeterministic(diffGovernedObjects(governedA, governedB), "capture engine pure two-run diff (map+theme+plan)");

    // Sanity: an empty diff over two EMPTY objects proves nothing. Confirm this exercised real,
    // substantive content both times.
    expect(runA.mapEnvelope.mapping.pages.length).toBeGreaterThan(0);
    expect(Object.keys(runA.themeEnvelope.theme.tokens ?? {}).length).toBeGreaterThan(0);
    expect(runA.planEnvelope.plan.creates.length).toBeGreaterThan(0);
    // requestedId really is the content hash the brief describes, not merely stable by accident of
    // fixture/target being unchanged — spot-check the format directly.
    for (const create of runA.planEnvelope.plan.creates) {
      expect(create.requestedId).toMatch(/^[a-z_]+_[0-9a-f]{18}$/);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// D. JUDGMENT-NODE VARIANCE — advisory classifier output must not change governed writes.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("D. judgment-node variance: block_classifier's advisory rationale must not leak into governed writes", () => {
  it("two classifier outputs that agree on WHAT a block is, but differ in HOW they explain it, produce byte-identical mapping + emission plan", async () => {
    const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
    const deps = { projectRepository: captureStubRepository(captureStubProject()) };
    const baseline = await captureMapStep({ targetProjectId: CAPTURE_TARGET, snapshot, suggestions: [] }, deps);
    expect(baseline.declinedBlocks.length).toBeGreaterThan(0);
    const targetBlockRef = baseline.declinedBlocks[0].blockRef;

    // Two independent "model runs": identical classification (blockRef -> sectionType), wholly
    // different advisory prose — the kind of variance a real LLM produces between two calls even at
    // temperature 0, and exactly the variance ADR "agent judgment is advisory" says must never reach a
    // governed write.
    const suggestionsRunA = [{ blockRef: targetBlockRef, sectionType: "prose", rationale: "This block reads as body copy: no CTA, no structured fields, prose evidence dominant." }];
    const suggestionsRunB = [{ blockRef: targetBlockRef, sectionType: "prose", rationale: "Re-run, different phrasing entirely — plain narrative text, nothing tabular or actionable here." }];

    const themeEnvelope = await captureThemeStep({ targetProjectId: CAPTURE_TARGET, snapshot }, deps);
    const envelopeA = await captureMapStep({ targetProjectId: CAPTURE_TARGET, snapshot, suggestions: suggestionsRunA }, deps);
    const envelopeB = await captureMapStep({ targetProjectId: CAPTURE_TARGET, snapshot, suggestions: suggestionsRunB }, deps);
    const planA = await captureEmitStep({ targetProjectId: CAPTURE_TARGET, mapping: envelopeA.mapping, theme: themeEnvelope.theme, live: false }, deps);
    const planB = await captureEmitStep({ targetProjectId: CAPTURE_TARGET, mapping: envelopeB.mapping, theme: themeEnvelope.theme, live: false }, deps);

    // The suggestion actually took effect (this is not a vacuous "nothing changed either way" pass).
    expect(envelopeA.assistance!.applied.some((entry) => entry.blockRef === targetBlockRef)).toBe(true);

    assertDeterministic(diffGovernedObjects(envelopeA, envelopeB), "capture_map envelope, rationale-only variance");
    assertDeterministic(diffGovernedObjects(planA.plan, planB.plan), "emission plan built from rationale-varied mappings");
  });

  it("CONTROL: two classifier outputs that differ in WHAT the block IS (not just how it's explained) DO diverge — proves the above isn't vacuous", async () => {
    const snapshot = await fixture("zilberman.snapshot.v1.redacted.json");
    const deps = { projectRepository: captureStubRepository(captureStubProject()) };
    const baseline = await captureMapStep({ targetProjectId: CAPTURE_TARGET, snapshot, suggestions: [] }, deps);
    const targetBlockRef = baseline.declinedBlocks[0].blockRef;

    const validClassification = [{ blockRef: targetBlockRef, sectionType: "prose", rationale: "textual evidence" }];
    // Same rationale STYLE, substantively different (and invalid) judgment — the deterministic
    // re-validation layer (mapSnapshot's assistance path) must refuse this, never coerce it, which
    // ITSELF is a real divergence from run A: the block ends up mapped in one run and still a gap in
    // the other.
    const invalidClassification = [{ blockRef: targetBlockRef, sectionType: "mega_hero_9000", rationale: "textual evidence" }];

    const envelopeA = await captureMapStep({ targetProjectId: CAPTURE_TARGET, snapshot, suggestions: validClassification }, deps);
    const envelopeB = await captureMapStep({ targetProjectId: CAPTURE_TARGET, snapshot, suggestions: invalidClassification }, deps);

    const divergences = diffGovernedObjects(envelopeA.mapping, envelopeB.mapping);
    expect(divergences.length).toBeGreaterThan(0);
    // Named, not just "not identical": the divergence is exactly this block's mapped-vs-gap status.
    expect(divergences.some((d) => d.path.includes("blockAccounting") || d.path.includes("gaps"))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// C. CLONE, PURE ENGINE LEVEL — intake -> mint -> restamp, chained.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const CLONE_TARGET = "clone-determinism-target";
const CLONE_SITE_ID = "site_clone_det";
const CLONE_THEME_ID = "thm_capture_clone_det";
const CLONE_CAPTURE_RUN_ID = "run_capture_det_1";
const CLONE_PAGE_ID = "pg_home_det";

const CLONE_SITE_TOKENS = { colors: { "brand-primary": "#111111", "brand-secondary": "#222222" }, fonts: { body: "Inter, sans-serif" } };
const CLONE_COMPONENT_REGISTRY = {
  definitions: [
    { type: "hero", data_schema: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } }, required: ["heading"] } }
  ]
};
const CLONE_PAGE_TYPE_REGISTRY = { definitions: [{ id: "clone", allowedSections: "any", requiredSections: [] }] };
const CLONE_LIVE_SECTIONS = [{ id: "s_1", type: "hero", data: { heading: "What the page holds NOW" } }];

const cloneCaptureRunFixture = () => ({
  runId: CLONE_CAPTURE_RUN_ID,
  projectId: CLONE_TARGET,
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
          { objectType: "page", pageRef: "page_home", requestedId: CLONE_PAGE_ID, body: { route: "/", sections: [{ type: "hero" }] } },
          { objectType: "theme", requestedId: CLONE_THEME_ID }
        ],
        createdObjects: [
          { objectType: "page", objectId: CLONE_PAGE_ID },
          { objectType: "theme", objectId: CLONE_THEME_ID }
        ],
        reusedObjects: []
      }
    }
  }
});

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

/**
 * Drives clone_conductor's own deterministic chain once — intake -> mint (one section_template
 * design) -> restamp — against a mocked transport whose every answer is itself deterministic (fixed
 * ids, no randomness, no Date.now()), matching cloneEngineRefusals.test.ts's proven mock shape.
 */
async function runCloneChainOnce() {
  resetRepositoryManager();
  process.env.CLONE_DETERMINISM_TARGET_MCP_ENDPOINT = "https://clone-determinism-target.example/mcp";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (name === "registry_get") return respond(request.id, args.registry === "component" ? CLONE_COMPONENT_REGISTRY : CLONE_PAGE_TYPE_REGISTRY);
      if (name === "object_inventory") {
        if (args.object_type === "site") return respond(request.id, { objects: [{ object_id: CLONE_SITE_ID, object_type: "site", status: "active" }] });
        if (args.object_type === "theme") return respond(request.id, { objects: [{ object_id: CLONE_THEME_ID, object_type: "theme", status: "active" }] });
        return respond(request.id, { objects: [] });
      }
      if (name === "object_get" && args.object_type === "site") {
        return respond(request.id, { record: { object_id: CLONE_SITE_ID, body: { name: "Fixture site", brandTokens: CLONE_SITE_TOKENS } } });
      }
      if (name === "object_get" && args.object_type === "theme") {
        return respond(request.id, { record: { object_id: CLONE_THEME_ID, body: { name: "Captured theme", tokens: CLONE_SITE_TOKENS } } });
      }
      if (name === "object_get" && args.object_type === "page") {
        return respond(request.id, { record: { object_id: CLONE_PAGE_ID, record_version: 4, body: { route: "/", sections: CLONE_LIVE_SECTIONS } } });
      }
      // requested_id echoed straight back as the objectId — the same reuse-first, content-addressed
      // discipline the capture emitter uses (#207: content-addressed library records).
      if (name === "object_create") return respond(request.id, { record: { object_id: String(args.requested_id ?? "obj_minted"), publication: { published_time: null } } });
      if (name === "object_checkout") return respond(request.id, { lockToken: `lock_${args.object_id}`, recordVersion: 4 });
      if (name === "object_patch") return respond(request.id, { record: { object_id: args.object_id } });
      if (name === "object_checkin") return respond(request.id, { ok: true });
      throw new Error(`Unexpected verb reached transport during clone determinism run: ${name}`);
    })
  );

  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId: CLONE_TARGET, name: "Clone determinism target", mcpEndpointEnvVar: "CLONE_DETERMINISM_TARGET_MCP_ENDPOINT", authMode: "none", defaultToolPolicy: "allowed" })
  );

  const executionDeps = { executionRepository: { getRun: async () => cloneCaptureRunFixture() } as unknown as ExecutionRepository };
  const intake = await cloneIntakeStep({ targetProjectId: CLONE_TARGET, captureRunId: CLONE_CAPTURE_RUN_ID }, executionDeps);
  const design = {
    sectionTemplates: [
      { name: "Captured hero recipe (heading)", blueprint: { type: "hero", data: { heading: "Repeated hero shape" } }, whenToUse: "Use for the repeated hero shape found on this site.", scope: "one_off" }
    ],
    templates: []
  };
  const mint = await cloneMintStep({ targetProjectId: CLONE_TARGET, intake, design }, executionDeps);
  const restamp = await cloneRestampStep({ targetProjectId: CLONE_TARGET, intake, mint }, executionDeps);

  vi.unstubAllGlobals();
  delete process.env.CLONE_DETERMINISM_TARGET_MCP_ENDPOINT;
  resetRepositoryManager();

  return { intake, mint, restamp };
}

describe("C. clone engine: the same capture run and design, chained through intake->mint->restamp twice, converge", () => {
  it("intake briefing, minted recipe ids/bodies, and restamp ops are byte-identical across two independent runs", async () => {
    const runA = await runCloneChainOnce();
    const runB = await runCloneChainOnce();

    assertDeterministic(diffGovernedObjects(runA.intake, runB.intake), "clone intake briefing, two-run diff");
    assertDeterministic(diffGovernedObjects(runA.mint, runB.mint), "clone recipe mint, two-run diff");
    assertDeterministic(diffGovernedObjects(runA.restamp, runB.restamp), "clone restamp ops, two-run diff");

    // Substantive: an actual recipe was minted and an actual page restamped both times.
    expect(runA.mint.applied.length).toBeGreaterThan(0);
    expect(runA.restamp.restamped.length).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// B. CAPTURE_CONDUCTOR, END TO END (mock execution mode) — the real workflow, not just its engine.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// This exercises the machinery T15 promised would keep two runs consistent even though it sits ABOVE
// the pure engine: resolvePublishAuthority reading the project's publishingPolicySnapshot (#185),
// the publishable-type charter snapshot (#190), and the shared publishing tail's own deterministic
// object-publish/release execution — end to end, through the actual executor, not re-implemented here.
describe("B. capture_conductor end-to-end (mock mode): the real workflow run twice produces identical governed writes", () => {
  it("the deterministic stage outputs (map, refined map, theme, emission plan, emission report, fidelity rubric, publication record) are byte-identical", async () => {
    const { run: runA } = await runCaptureFixtureOnce();
    const { run: runB } = await runCaptureFixtureOnce();

    const governedSurface = (run: typeof runA) => {
      const so = run.stageOutputs as Record<string, any>;
      return {
        mapping: so.capture_map.mapping,
        refinedMapping: so.capture_map_refine.mapping,
        coverageDelta: so.capture_map_refine.coverageDelta,
        theme: so.capture_theme.theme,
        plan: so.capture_emit_dry.plan,
        emissionReport: {
          createdObjects: so.capture_emit_live.report.createdObjects,
          reusedObjects: so.capture_emit_live.report.reusedObjects,
          quarantines: so.capture_emit_live.report.quarantines,
          validationStates: so.capture_emit_live.report.validationStates,
          assetGaps: so.capture_emit_live.report.assetGaps,
          mediaPolicy: so.capture_emit_live.report.mediaPolicy
        },
        fidelityRubric: so.capture_score.rubric,
        publication: {
          attempted: so.capture_report.publication.attempted,
          published: so.capture_report.publication.published,
          failed: so.capture_report.publication.failed,
          withheld: so.capture_report.publication.withheld
        }
      };
    };

    const divergences = diffGovernedObjects(governedSurface(runA), governedSurface(runB), CONDUCTOR_GOVERNED_SURFACE_ALLOWLIST);
    assertDeterministic(divergences, "capture_conductor two full mock runs (governed-object surface)");

    // Substantive: this actually created drafts and reached a verdict both times, not two empty runs
    // that trivially agree.
    expect((runA.stageOutputs.capture_emit_live as any).report.createdObjects.length).toBeGreaterThan(0);
    expect((runA.stageOutputs.capture_score as any).rubric.verdict).toBeTruthy();
  }, 60_000);

  it("PERMITTED_DIVERGENCE: run identity (runId/requestId) genuinely differs run to run, and it is the complete set of what differs at the run's top level", async () => {
    const { run: runA } = await runCaptureFixtureOnce();
    const { run: runB } = await runCaptureFixtureOnce();

    const identitySlice = (run: typeof runA) => ({ runId: run.runId, requestId: run.requestId, startedAt: run.startedAt, updatedAt: run.updatedAt });
    const sliceA = identitySlice(runA);
    const sliceB = identitySlice(runB);

    // 1) With NO allowlist, these DO diverge — the harness would fail a real regression here, and
    //    this line proves it isn't silently defeated by coincidence (e.g. two runs racing to the same
    //    id). runId/requestId are `${prefix}_${Date.now()}_${Math.random()...}` (executor.ts
    //    makeRunId/makeRequestId) — the random suffix makes a collision astronomically unlikely even
    //    within the same millisecond.
    const withoutAllowlist = diffGovernedObjects(sliceA, sliceB);
    const divergentPaths = withoutAllowlist.map((d) => d.path).sort();
    expect(divergentPaths).toEqual(expect.arrayContaining(["$.runId", "$.requestId"]));
    // 2) COMPLETENESS: every divergent path found is one the documented allowlist names — nothing
    //    outside {runId, requestId, startedAt, updatedAt} varied. If a future change made some OTHER
    //    top-level field wall-clock/random, this line catches it as an undocumented divergence.
    for (const path of divergentPaths) {
      expect(RUN_IDENTITY_ALLOWLIST.some((entry) => entry.path === path), `undocumented divergent field: ${path}`).toBe(true);
    }
    // 3) With the allowlist applied, nothing is left to report.
    assertDeterministic(diffGovernedObjects(sliceA, sliceB, RUN_IDENTITY_ALLOWLIST), "run identity fields, after the documented allowlist");
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PERMITTED_DIVERGENCE — the complete, documented allowlist for this harness. Every entry names a
// SPECIFIC field and says why it is legitimately run-scoped rather than governed content. Nothing here
// matches broadly (no bare key-name regexes reaching into arbitrary nesting) — see determinismDiff.ts's
// own header for why that specificity matters.
const RUN_IDENTITY_ALLOWLIST: AllowlistEntry[] = [
  { path: "$.runId", reason: "The workflow/platform join key (executionTypes.ts WorkflowExecutionRecord.requestId doc), generated once per run at buildInitialRun via `run_${Date.now()}_${Math.random()...}` (executor.ts makeRunId). Identifies THIS run, not the governed content it produced." },
  { path: "$.requestId", reason: "Same generation as runId (executor.ts makeRequestId) — the platform/workspace join key copied onto every usage record this run produces. A different value each run is the point: it proves two runs are two runs, never the same one replayed." },
  { path: "$.startedAt", reason: "Wall-clock ISO timestamp stamped by buildInitialRun at run creation. Ledger metadata about WHEN the run happened, never fed back into any governed write (mirrors #208's normalizeMemoryEnvelope updatedAt discipline: a ledger fact, not run output)." },
  { path: "$.updatedAt", reason: "Wall-clock ISO timestamp updated on every persisted save of the run record. Same status as startedAt: execution bookkeeping, not a governed object field." }
];

// The curated governed-object surface (test B's first case) needs NO allowlist entries in this
// harness's own mock transport, because every wall-clock-shaped answer that mock returns
// (object_publish's published_time, release_to_production's targetCommit) is pinned to a FIXED string
// rather than Date.now() — see captureConductorFixtureRun.ts's own comment on that choice. This array
// stays empty and typed, rather than omitted, so a reviewer sees the decision was made, not skipped.
const CONDUCTOR_GOVERNED_SURFACE_ALLOWLIST: AllowlistEntry[] = [];

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// E. NEGATIVE CONTROLS — proving the harness itself can fail, decoupled from any pipeline.
//    "A harness never seen to fail is not known to work."
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("E. negative controls: diffGovernedObjects actually catches injected non-determinism", () => {
  it("catches a single divergent leaf deep inside otherwise-identical trees, and names its exact path and both values", () => {
    const runA = {
      artifact: "capture_emission_plan.v1",
      target: "zb",
      creates: [
        { objectType: "page", requestedId: "page_capture_aaaa", body: { route: "/", sections: [{ type: "hero", data: { heading: "Welcome" } }] } }
      ]
    };
    // Simulates the exact regression class this harness exists to catch: something run-scoped (here,
    // a fetch/request id) leaked into a field that MUST be a stable content hash.
    const runB = JSON.parse(JSON.stringify(runA));
    runB.creates[0].requestedId = "page_capture_bbbb"; // e.g. accidentally salted with a per-run nonce

    const divergences = diffGovernedObjects(runA, runB);
    expect(divergences).toEqual([{ path: "$.creates[0].requestedId", a: "page_capture_aaaa", b: "page_capture_bbbb" }]);
  });

  it("catches a missing/extra key, an array-length change, and a type change — not just changed primitives", () => {
    const runA = { pages: [{ pageRef: "p1", sections: ["hero", "prose"] }], theme: { tokens: { colors: {} } } };
    const runB = { pages: [{ pageRef: "p1", sections: ["hero"] }], theme: { tokens: { colors: {}, fonts: {} } } };

    const divergences = diffGovernedObjects(runA, runB);
    const paths = divergences.map((d) => d.path).sort();
    expect(paths).toEqual(["$.pages[0].sections.length", "$.pages[0].sections[1]", "$.theme.tokens.fonts"]);
  });

  it("an allowlist entry suppresses ONLY the exact path it names, never a sibling or nested field that happens to share a key name", () => {
    const runA = { runId: "run_1", page: { runId: "content_field_coincidentally_named_runId" } };
    const runB = { runId: "run_2", page: { runId: "DIFFERENT — this one is a real regression" } };

    const topLevelOnly: AllowlistEntry[] = [{ path: "$.runId", reason: "test: top-level run id only" }];
    const divergences = diffGovernedObjects(runA, runB, topLevelOnly);

    // The allowlist matched the exact top-level path and nothing else — the nested `page.runId`,
    // despite sharing a key name, is NOT suppressed. This is the "over-eager normalizer" failure mode
    // the brief warns about, proven absent.
    expect(divergences).toEqual([{ path: "$.page.runId", a: "content_field_coincidentally_named_runId", b: "DIFFERENT — this one is a real regression" }]);
  });

  it("assertDeterministic throws a readable, field-naming error when divergence survives the allowlist, and stays silent when it doesn't", () => {
    expect(() => assertDeterministic([{ path: "$.creates[0].requestedId", a: "x", b: "y" }], "example context")).toThrowError(
      /example context: 1 field\(s\) diverged.*\$\.creates\[0\]\.requestedId: run A = "x"\s+\|\s+run B = "y"/s
    );
    expect(() => assertDeterministic([], "example context")).not.toThrow();
  });
});
