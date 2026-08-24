import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCloneReportStep,
  cloneRestampStep,
  CLONE_ARTIFACTS,
  type CloneMintEnvelope,
  type CloneThemeBindEnvelope
} from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T13.4 PART C — THE END-TO-END WIRING TEST.
//
// Both halves of this feature passed their own unit tests while nothing connected them: clone.mjs's
// resolveSectionTypeSubstitutions had its own coverage, cloneRestampStep's lock/wire discipline had
// its own coverage, and neither test suite ever handed a REAL fit_adjudicator envelope through the
// REAL cloneEngine.ts stage functions and checked what actually reached the wire. This test does
// exactly that: a valid adjudicated choice — `hero` wanted, not usable, `lede` chosen (same
// `intro_banner` compatibility class, engine/clone.mjs's own table) — goes in as a
// clone_fit_adjudication.v1 envelope, and the section's TYPE on the actual object_patch WIRE CALL
// comes out retyped from `hero` to `lede`. It then carries the same run's mint/restamp output through
// buildCloneReportStep (pure, no wire) and checks the RE-VALIDATED choice — not the model's raw claim
// — is what lands in the terminal report's substitutions[] ledger.
const TARGET = "adjudication-wiring-target";
const SITE_ID = "site_adj";
const THEME_ID = "thm_adj";
const PAGE_ID = "pg_adj";

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type WireCall = { name: string; args: Record<string, unknown> };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

const intake = () => ({
  artifact: "clone_intake.v1" as const,
  summary: "fixture",
  captureRunId: "run_1",
  target: TARGET,
  site: { objectId: SITE_ID, palette: { colors: {}, fonts: {} } },
  theme: { objectId: THEME_ID, name: "Captured theme", palette: { colors: {}, fonts: {} } },
  registry: { sectionTypes: {}, pageTypes: {} },
  pages: [{ pageRef: "page_home", objectId: PAGE_ID, route: "/", sourceShape: ["hero"], emittedShape: ["hero"], gaps: [], candidateIds: ["cand_1"] }],
  recipes: { section_template: [], template: [] },
  budget: { chars: 0, cap: 32000, truncated: [] },
  policy: {}
});

// The mint envelope's `substitutions[]` — exactly the shape buildRecipeMintPlan's substitutionEntry
// constructs for an `unknown_section_type` rejection: `hero` was wanted, could not be used, and
// `lede` is a live, same-class candidate the engine itself enumerated.
const MINT_SUBSTITUTION = {
  kind: "section_type" as const,
  wanted: "hero",
  chosen: null,
  reason: "unknown_section_type",
  basis: "1 live, allowed section type(s) share \"hero\"'s compatibility class",
  fidelityCost: "minor" as const,
  substitutable: true,
  candidates: ["lede"]
};

const mintEnvelope = (): CloneMintEnvelope => ({
  artifact: CLONE_ARTIFACTS.mint,
  summary: "fixture mint",
  plan: { schemaVersion: "clone-mint-plan.v1", target: TARGET, creates: [], rejected: [], reused: [], substitutions: [MINT_SUBSTITUTION], forbiddenVerbs: [] },
  report: { createdObjects: [] },
  applied: [],
  rejected: [],
  reused: [],
  substitutions: [MINT_SUBSTITUTION],
  policy: { defaultToolPolicy: "allowed", toolPolicies: {}, allowedTools: [] }
});

const themeBindEnvelope = (): CloneThemeBindEnvelope => ({
  artifact: CLONE_ARTIFACTS.themeBind,
  summary: "fixture theme bind",
  siteId: SITE_ID,
  themeId: THEME_ID,
  applied: { colors: {}, fonts: {} },
  dropped: [],
  before: {},
  after: { colors: {}, fonts: {} },
  substitutions: [],
  published: false,
  policy: { defaultToolPolicy: "allowed", toolPolicies: {}, allowedTools: [] }
});

// `fit_adjudicator`'s OWN output — the model's claim, not yet re-validated by anything.
const ADJUDICATION = {
  artifact: "clone_fit_adjudication.v1",
  summary: "1 choice, 0 declined",
  choices: [{ kind: "section_type", wanted: "hero", chosen: "lede", basis: "same intro_banner class; hero unavailable here", fidelityCost: "minor" }],
  declined: []
};

const registerTarget = async (projectId: string, envVar: string) =>
  createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({ projectId, name: `${projectId} adjudication-wiring fixture`, mcpEndpointEnvVar: envVar, authMode: "none", defaultToolPolicy: "allowed" })
  );

describe("clone_conductor — a valid adjudicated choice survives the whole stage path end to end", () => {
  let calls: WireCall[];

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    process.env.ADJUDICATION_WIRING_TARGET_MCP_ENDPOINT = "https://adjudication-wiring-target.example/mcp";
    await registerTarget(TARGET, "ADJUDICATION_WIRING_TARGET_MCP_ENDPOINT");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        if (request.method !== "tools/call") return respond(request.id, {});
        const name = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        calls.push({ name, args });
        if (name === "object_get") {
          // The captured page carries a `hero` section — the substitution's own `wanted`.
          return respond(request.id, { record: { object_id: PAGE_ID, body: { route: "/", sections: [{ id: "s_1", type: "hero", data: { heading: "Welcome" } }] } } });
        }
        if (name === "object_checkout") return respond(request.id, { lockToken: "lk_adj", recordVersion: 3 });
        if (name === "object_patch") return respond(request.id, { record: { object_id: PAGE_ID } });
        if (name === "object_checkin") return respond(request.id, { ok: true });
        throw new Error(`Unexpected verb reached transport: ${name}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ADJUDICATION_WIRING_TARGET_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("cloneRestampStep: envelope in, section retyped on the WIRE object_patch call", async () => {
    const restampEnvelope = await cloneRestampStep({ targetProjectId: TARGET, intake: intake(), mint: mintEnvelope(), adjudication: ADJUDICATION });

    // THE ASSERTION THAT MATTERS: the actual wire-level object_patch args carry the RETYPED section —
    // not the mock's internal state, the literal RPC arguments that would have gone to the platform.
    const patchCall = calls.find((call) => call.name === "object_patch")!;
    expect(patchCall, "object_patch must have reached the wire").toBeDefined();
    expect(patchCall.args.ops).toEqual([{ op: "upsert_section", section: { id: "s_1", type: "lede", data: { heading: "Welcome" } }, position: 0 }]);

    // The stage's own ledger reports the swap it validated and applied.
    expect(restampEnvelope.appliedSubstitutions).toEqual([{ wanted: "hero", chosen: "lede" }]);
    expect(restampEnvelope.substitutionRejections).toEqual([]);
    expect(restampEnvelope.restamped.map((entry) => entry.objectId)).toEqual([PAGE_ID]);
    expect(restampEnvelope.quarantined).toEqual([]);

    // buildCloneReportStep — pure, no wire — folds mint's + restamp's ledgers into ONE report, using
    // the RE-VALIDATED chosen (restamp's appliedSubstitutions), not adjudication's raw claim a second
    // time.
    const report = buildCloneReportStep({
      intake: intake() as any,
      mint: mintEnvelope(),
      themeBind: themeBindEnvelope(),
      restamp: restampEnvelope,
      design: {},
      adjudication: ADJUDICATION
    });

    const heroEntry = (report.substitutions as Array<Record<string, unknown>>).find((entry) => entry.kind === "section_type" && entry.wanted === "hero");
    expect(heroEntry, "the section_type substitution must appear in the terminal report's ledger").toBeDefined();
    expect(heroEntry).toMatchObject({ kind: "section_type", wanted: "hero", chosen: "lede", fidelityCost: "minor" });
    // Nothing was rejected: the model's choice was legal (same compatibility class, and literally one
    // of this engine's own candidates), so no substitution_not_in_candidates entry exists.
    expect((report.substitutions as Array<Record<string, unknown>>).some((entry) => entry.reason === "substitution_not_in_candidates")).toBe(false);
  });

  it("an ILLEGAL adjudicated choice (not in the engine's own candidates) is never applied to the wire, and is reported as a rejection", async () => {
    const illegalAdjudication = {
      artifact: "clone_fit_adjudication.v1",
      summary: "1 choice",
      // "prose" is a DIFFERENT compatibility class (narrative_text) from "hero" (intro_banner) — an
      // illegal cross-class swap the model should never have proposed, and even if it were same-class
      // it is not among the engine's own `candidates: ["lede"]` for this `wanted`.
      choices: [{ kind: "section_type", wanted: "hero", chosen: "prose", basis: "model over-reached", fidelityCost: "minor" }],
      declined: []
    };

    const restampEnvelope = await cloneRestampStep({ targetProjectId: TARGET, intake: intake(), mint: mintEnvelope(), adjudication: illegalAdjudication });

    const patchCall = calls.find((call) => call.name === "object_patch")!;
    // The section keeps its ORIGINAL, uncoerced type — the illegal choice was never applied.
    expect((patchCall.args.ops as Array<Record<string, unknown>>)[0]).toMatchObject({ section: { type: "hero" } });
    expect(restampEnvelope.appliedSubstitutions).toEqual([]);
    expect(restampEnvelope.substitutionRejections).toHaveLength(1);
    expect(restampEnvelope.substitutionRejections[0]).toMatchObject({ wanted: "hero", chosen: null, reason: "substitution_not_in_candidates" });
  });
});
