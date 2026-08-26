import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCloneDelta } from "../../../src/agent/capture/engine/clone.mjs";
import type { CloneIntake } from "../../../src/agent/capture/engine/clone.mjs";
import { cloneThemeBindStep } from "../../../src/agent/capture/cloneEngine.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T2 (2026-08-26) — the delta comparison, and the boundary of what it is allowed to conclude.
//
// THE EVIDENCE. Two live runs (run_1787748666186_ammpuv, run_1787748899372_lbvqdz) re-derived a clone
// that was already published and released. Every content_revision came out identical — theme 2,
// site 3, home 69, partners 54, filmography 76, book-online 12. layout_restamp spent 30.6s rewriting
// four pages into the shape they already had; theme_bind re-applied a byte-identical palette, its own
// before and after blocks matching. $0.18 for a run of no-ops.
//
// THE THEME HALF IS A VERDICT and cloneThemeBindStep acts on it: both values are in the briefing
// already, so "would site_apply_theme write anything different" is total.
//
// THE PAGE HALF IS EVIDENCE, NOT A GATE, and the last describe block below is the test that PINS that
// distinction rather than merely documenting it — because the tempting version of this feature (skip
// the judgment nodes when every page's shape matches) is wrong, and was caught being wrong by
// determinismHarness.test.ts: a page can need a real restamp with its type sequence unchanged, since
// a restamp also re-points sections at a recipe minted this run and rewrites section data. A
// shapes-only briefing cannot see either.

const PALETTE = { colors: { "brand-primary": "#111111" }, fonts: { body: "Inter, sans-serif" } };

const intakeFixture = (overrides: Partial<CloneIntake> = {}): CloneIntake =>
  ({
    artifact: "clone_intake.v1",
    summary: "Fixture briefing.",
    entryMode: "clone",
    captureRunId: "run_capture_fixture",
    sourceUrl: null,
    target: "fixture-target",
    site: { objectId: "site_1", palette: PALETTE },
    theme: { objectId: "thm_1", name: "Captured", palette: PALETTE },
    registry: { sectionTypes: {}, pageTypes: {} },
    pages: [
      { pageRef: "page_home", objectId: "pg_home", route: "/", sourceShape: ["hero", "prose"], emittedShape: ["hero", "prose"], gaps: [], candidateIds: [] },
      { pageRef: "page_about", objectId: "pg_about", route: "/about", sourceShape: ["hero"], emittedShape: ["hero"], gaps: [], candidateIds: [] }
    ],
    recipes: { section_template: [], template: [] },
    budget: { chars: 0, cap: 48000, truncated: [] },
    ...overrides
  }) as unknown as CloneIntake;

const liveSections = (types: string[]) => types.map((type, index) => ({ id: `s_${index}`, type }));

describe("the theme half — the verdict theme_bind acts on", () => {
  it("reports the captured theme's tokens as ALREADY MATCHING the site's live palette", () => {
    const delta = applyCloneDelta(intakeFixture(), { pages: [] }).delta!;
    expect(delta.theme.changed).toBe(false);
    expect(delta.theme.reason).toBe("captured_theme_tokens_already_match_live_site_palette");
    expect(delta.theme.capturedThemeDigest).toBe(delta.theme.livePaletteDigest);
  });

  it("ignores KEY ORDER — a palette that round-tripped through a different serializer is the same palette", () => {
    const reordered = { fonts: { body: "Inter, sans-serif" }, colors: { "brand-primary": "#111111" } };
    const delta = applyCloneDelta(intakeFixture({ theme: { objectId: "thm_1", name: "Captured", palette: reordered } } as Partial<CloneIntake>), { pages: [] }).delta!;
    expect(delta.theme.changed).toBe(false);
  });

  it("reports a genuinely different token set as CHANGED", () => {
    const different = { colors: { "brand-primary": "#ff0000" }, fonts: { body: "Inter, sans-serif" } };
    const delta = applyCloneDelta(intakeFixture({ theme: { objectId: "thm_1", name: "Captured", palette: different } } as Partial<CloneIntake>), { pages: [] }).delta!;
    expect(delta.theme.changed).toBe(true);
    expect(delta.theme.reason).toBe("captured_theme_tokens_differ_from_live_site_palette");
  });

  it("treats an ABSENT captured theme as changed, never as already-current", () => {
    // theme_bind has its own named refusal (clone_theme_missing) for this, and the gate must not
    // pre-empt it by reporting a clean match against nothing.
    const delta = applyCloneDelta(intakeFixture({ theme: { objectId: null, name: null, palette: {} } } as Partial<CloneIntake>), { pages: [] }).delta!;
    expect(delta.theme.changed).toBe(true);
    expect(delta.theme.reason).toBe("no_captured_theme_to_compare");
    expect(delta.theme.capturedThemeDigest).toBeNull();
  });
});

describe("the page half — drift evidence, stated per page", () => {
  it("names a page whose live shape already matches its briefing and its source", () => {
    const gated = applyCloneDelta(intakeFixture(), {
      pages: [
        { objectId: "pg_home", sections: liveSections(["hero", "prose"]) },
        { objectId: "pg_about", sections: liveSections(["hero"]) }
      ]
    });
    expect(gated.delta!.comparedPages).toBe(2);
    expect(gated.delta!.pagesWithShapeDrift).toBe(0);
    expect(gated.delta!.pages.map((entry) => entry.shapeDrift)).toEqual(["none", "none"]);
    expect(gated.delta!.pages[0].liveShape).toEqual(["hero", "prose"]);
  });

  it("names a page whose LIVE shape has drifted from the briefing", () => {
    const gated = applyCloneDelta(intakeFixture(), {
      pages: [
        { objectId: "pg_home", sections: liveSections(["hero"]) },
        { objectId: "pg_about", sections: liveSections(["hero"]) }
      ]
    });
    expect(gated.delta!.pagesWithShapeDrift).toBe(1);
    expect(gated.delta!.pages[0].shapeDrift).toBe("live_shape_differs_from_briefing");
    expect(gated.delta!.pages[1].shapeDrift).toBe("none");
  });

  it("names a page whose EMITTED shape never matched its source in the first place", () => {
    const intake = intakeFixture({
      pages: [{ pageRef: "page_home", objectId: "pg_home", route: "/", sourceShape: ["hero", "prose"], emittedShape: ["hero"], gaps: [], candidateIds: [] }]
    } as Partial<CloneIntake>);
    const gated = applyCloneDelta(intake, { pages: [{ objectId: "pg_home", sections: liveSections(["hero"]) }] });
    expect(gated.delta!.pages[0].shapeDrift).toBe("emitted_shape_differs_from_source");
  });

  it("records an unreadable live body as unreadable — never as already-current", () => {
    const gated = applyCloneDelta(intakeFixture(), { pages: [{ objectId: "pg_home", sections: liveSections(["hero", "prose"]) }] });
    expect(gated.delta!.pages[1].shapeDrift).toBe("live_body_unreadable");
    expect(gated.delta!.pages[1].liveShape).toBeNull();
  });
});

describe("the boundary — the page ledger never narrows the run", () => {
  // THIS IS THE TEST THAT PINS THE DESIGN, not a coverage filler. The obvious version of T2 skips the
  // judgment nodes when every page's shape matches, and it is WRONG: layout_restamp also re-points
  // sections at a recipe minted this run and rewrites section data, so a page can need a substantive
  // restamp with an unchanged type sequence. If a future change makes `pages` narrow on shape, this
  // fails — which is the whole point.
  it("leaves intake.pages byte-identical, however clean the comparison comes out", () => {
    const intake = intakeFixture();
    const before = JSON.stringify(intake.pages);
    const gated = applyCloneDelta(intake, {
      pages: [
        { objectId: "pg_home", sections: liveSections(["hero", "prose"]) },
        { objectId: "pg_about", sections: liveSections(["hero"]) }
      ]
    });
    expect(JSON.stringify(gated.pages)).toBe(before);
    expect(gated.pages).toHaveLength(2);
    // No field that a skip predicate could key off exists on the ledger at all.
    expect(gated.delta).not.toHaveProperty("shortCircuit");
    expect(gated.delta).not.toHaveProperty("skip");
  });

  it("is PURE — the same intake and the same live bodies produce a byte-identical envelope", () => {
    const live = { pages: [{ objectId: "pg_home", sections: liveSections(["hero", "prose"]) }, { objectId: "pg_about", sections: liveSections(["hero"]) }] };
    expect(JSON.stringify(applyCloneDelta(intakeFixture(), live))).toBe(JSON.stringify(applyCloneDelta(intakeFixture(), live)));
  });

  it("restates budget.chars against the envelope that now contains the ledger", () => {
    const gated = applyCloneDelta(intakeFixture(), { pages: [{ objectId: "pg_home", sections: liveSections(["hero", "prose"]) }] });
    expect(gated.budget.chars).toBe(JSON.stringify(gated).length);
  });

  it("never throws — a briefing with no pages at all is a clean comparison, not a refusal", () => {
    const gated = applyCloneDelta(intakeFixture({ pages: [] } as Partial<CloneIntake>), {});
    expect(gated.delta!.comparedPages).toBe(0);
    expect(gated.delta!.theme.changed).toBe(false);
  });
});

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("theme_bind honors the verdict: a byte-identical palette is never re-applied", () => {
  const TARGET = "clone-delta-theme-target";
  let calls: string[];

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    process.env.CLONE_DELTA_THEME_MCP_ENDPOINT = "https://clone-delta-theme.example/mcp";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        const name = request.params?.name ?? "";
        if (request.method === "tools/call") calls.push(name);
        const record =
          name === "object_get"
            ? { record: { object_id: "site_1", body: { name: "Site", brandTokens: PALETTE, tokens: PALETTE } } }
            : {};
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { data: record } } }) } as unknown as Response;
      })
    );
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({ projectId: TARGET, name: "Clone delta theme fixture", mcpEndpointEnvVar: "CLONE_DELTA_THEME_MCP_ENDPOINT", authMode: "none", defaultToolPolicy: "allowed" })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLONE_DELTA_THEME_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const gatedIntake = (themePalette: Record<string, unknown>) =>
    applyCloneDelta(
      intakeFixture({ target: TARGET, pages: [], theme: { objectId: "thm_1", name: "Captured", palette: themePalette } } as Partial<CloneIntake>),
      { pages: [] }
    );

  it("makes NO site_apply_theme call when the delta says the tokens already match", async () => {
    const envelope = await cloneThemeBindStep({ targetProjectId: TARGET, intake: gatedIntake(PALETTE), themeProposal: undefined });

    expect(calls).not.toContain("site_apply_theme");
    // ...and it still STATES the bound theme rather than going silent: publish_payload reads this
    // envelope by artifact and refuses on a missing one, which is why this is a no-op and not a skip.
    expect(envelope.artifact).toBe("clone_theme_bind.v1");
    expect(envelope.siteId).toBe("site_1");
    expect(envelope.themeId).toBe("thm_1");
    expect(envelope.applied).toEqual(PALETTE);
    expect(envelope.before).toEqual(envelope.after);
    expect(envelope.dropped).toEqual([]);
    expect(envelope.substitutions).toEqual([]);
    expect(envelope.published).toBe(false);
    expect(envelope.summary).toContain("already byte-identical");
  });

  it("still writes when the tokens genuinely differ — the gate narrows nothing it has not compared", async () => {
    const different = { colors: { "brand-primary": "#ff0000" }, fonts: { body: "Inter, sans-serif" } };
    // No proposal supplied, so this run refuses at validateThemeProposal rather than writing — the
    // point being that it gets THERE at all, i.e. the delta branch did not swallow it.
    await expect(cloneThemeBindStep({ targetProjectId: TARGET, intake: gatedIntake(different), themeProposal: undefined })).rejects.toThrow();
    expect(calls).not.toContain("site_apply_theme");
  });
});
