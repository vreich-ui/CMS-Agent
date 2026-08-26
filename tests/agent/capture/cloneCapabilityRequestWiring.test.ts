import { describe, expect, it } from "vitest";
import {
  buildCloneReportStep,
  CLONE_ARTIFACTS,
  type CloneIntakeEnvelope,
  type CloneMintEnvelope,
  type CloneRestampEnvelope,
  type CloneThemeBindEnvelope
} from "../../../src/agent/capture/cloneEngine.js";

// T15.33 (#209; ADR-2026-08-25-structure-studio §6.3) — clone_report's terminal envelope now carries
// `capabilityRequests`, derived (pure, deterministic — buildCloneReportStep does no wire calls) from
// the SAME unmetNeeds recipe_designer reported and clone_report's own `capabilityBacklog` groups.

const TARGET = "capability-request-wiring-target";

const intake = (overrides: Partial<CloneIntakeEnvelope> = {}): CloneIntakeEnvelope =>
  ({
    artifact: CLONE_ARTIFACTS.intake,
    summary: "fixture",
    captureRunId: "run_cap_1",
    target: TARGET,
    site: { objectId: "site_1", palette: { colors: {}, fonts: {} } },
    theme: { objectId: "theme_1", name: "Captured theme", palette: { colors: {}, fonts: {} } },
    registry: { sectionTypes: {}, pageTypes: {} },
    pages: [],
    recipes: { section_template: [], template: [] },
    budget: { chars: 0, cap: 32000, truncated: [] },
    policy: {},
    ...overrides
  }) as unknown as CloneIntakeEnvelope;

const mintEnvelope = (): CloneMintEnvelope =>
  ({
    artifact: CLONE_ARTIFACTS.mint,
    summary: "fixture mint",
    plan: { schemaVersion: "clone-mint-plan.v1", target: TARGET, creates: [], rejected: [], reused: [], substitutions: [], forbiddenVerbs: [] },
    report: { createdObjects: [] },
    applied: [],
    rejected: [],
    reused: [],
    substitutions: [],
    policy: { defaultToolPolicy: "allowed", toolPolicies: {}, allowedTools: [] }
  }) as unknown as CloneMintEnvelope;

const themeBindEnvelope = (): CloneThemeBindEnvelope =>
  ({
    artifact: CLONE_ARTIFACTS.themeBind,
    summary: "fixture theme bind",
    siteId: "site_1",
    themeId: "theme_1",
    applied: { colors: {}, fonts: {} },
    dropped: [],
    before: {},
    after: { colors: {}, fonts: {} },
    substitutions: [],
    published: false,
    policy: { defaultToolPolicy: "allowed", toolPolicies: {}, allowedTools: [] }
  }) as unknown as CloneThemeBindEnvelope;

const restampEnvelope = (): CloneRestampEnvelope =>
  ({
    artifact: CLONE_ARTIFACTS.restamp,
    summary: "fixture restamp",
    restamped: [],
    skipped: [],
    quarantined: [],
    appliedSubstitutions: [],
    substitutionRejections: [],
    policy: {}
  }) as unknown as CloneRestampEnvelope;

const design = (unmetNeeds: unknown[]) => ({
  artifact: "clone_recipe_design.v1",
  summary: "fixture design",
  sectionTemplates: [],
  templates: [],
  reused: [],
  unmetNeeds
});

describe("buildCloneReportStep — capabilityRequests wiring", () => {
  it("is absent (empty) when recipe_designer reported no unmet needs", () => {
    const output = buildCloneReportStep({ intake: intake(), mint: mintEnvelope(), themeBind: themeBindEnvelope(), restamp: restampEnvelope(), design: design([]) });
    expect(output.capabilityRequests).toEqual([]);
    expect(output.capabilityBacklog).toEqual({});
  });

  it("turns recipe_designer's unmetNeeds into a structured, evidenced request per section type", () => {
    const output = buildCloneReportStep({
      intake: intake(),
      mint: mintEnvelope(),
      themeBind: themeBindEnvelope(),
      restamp: restampEnvelope(),
      design: design([
        { sectionType: "booking_widget", pageRef: "page_services", why: "no registered type books an appointment slot", proposedFields: ["serviceId", "slots[]"] }
      ]),
      runId: "run_report_1"
    });

    expect(output.capabilityBacklog).toHaveProperty("booking_widget");
    expect(output.capabilityRequests).toEqual([
      {
        sectionType: "booking_widget",
        occurrences: 1,
        proposedFields: ["serviceId", "slots[]"],
        evidence: [{ pageRef: "page_services", why: "no registered type books an appointment slot", sourceUrl: null, runId: "run_report_1" }]
      }
    ]);
  });

  it("states intake's own sourceUrl on every evidence row of a demand-driven run", () => {
    const output = buildCloneReportStep({
      intake: intake({ sourceUrl: "https://client.example/" }),
      mint: mintEnvelope(),
      themeBind: themeBindEnvelope(),
      restamp: restampEnvelope(),
      design: design([{ sectionType: "video_embed", pageRef: "page_home", why: "no video embed type" }])
    });
    expect(output.capabilityRequests[0].evidence[0].sourceUrl).toBe("https://client.example/");
  });

  it("is a pure function: byte-identical design input produces byte-identical capabilityRequests across two calls", () => {
    const buildInput = () => ({
      intake: intake(),
      mint: mintEnvelope(),
      themeBind: themeBindEnvelope(),
      restamp: restampEnvelope(),
      design: design([{ sectionType: "pricing_table", pageRef: "page_pricing", why: "tiered pricing" }]),
      runId: "run_determinism"
    });
    const first = buildCloneReportStep(buildInput());
    const second = buildCloneReportStep(buildInput());
    expect(first.capabilityRequests).toEqual(second.capabilityRequests);
  });
});
