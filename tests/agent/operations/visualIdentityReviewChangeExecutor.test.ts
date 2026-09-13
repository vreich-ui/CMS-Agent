import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  classifyImageEffect,
  inferBriefFromSiteContent,
  resolveRecordTarget,
  resolveVisualStandardTarget,
  runVisualIdentityReviewChange,
  type MaterializeVisualStandardResult,
  type ProposeVisualIdentityParams,
  type VisualIdentityReviewChangeDeps
} from "../../../src/agent/operations/visualIdentityReviewChangeExecutor.js";
import { compileCandidate } from "../../../src/agent/operations/candidates.js";
import { computeChangeSet, targetKey, type ChangeSet } from "../../../src/agent/operations/changeSet.js";
import type { ScopedApproval } from "../../../src/agent/operations/scopedApproval.js";
import { captureSiteSnapshot, type SiteContextObject, type SiteRegistries } from "../../../src/agent/operations/siteContext.js";
import {
  buildZilbermanFixtureData,
  createInMemorySiteContextSource,
  DEFAULT_REGISTRIES,
  VIS_ZILBERMAN_OBJECT,
  type FixtureTenantData
} from "./fixtures/inMemorySiteContextSource.js";

const TENANT_ID = "zilberman-ff";
const IMAGERY_OBJECT_TYPES = ["visual_standard", "image_model_config"];

let revCounter = 0;
// A fresh revisionId per call sidesteps runVisualIdentityReviewChange's own use of
// getSiteSnapshot's PROCESS-WIDE cache (siteContext.ts's defaultSiteSnapshotCache) — every test
// gets its own cache entry instead of colliding with another test's "zilberman-ff" data under the
// same key.
function fixture(overrides: Partial<FixtureTenantData> = {}): FixtureTenantData {
  return buildZilbermanFixtureData({ revisionId: `rev_test_${revCounter++}`, ...overrides });
}

function themeRecord(overrides: Partial<SiteContextObject> = {}): SiteContextObject {
  return {
    objectId: "theme_zilberman",
    objectType: "theme",
    status: "saved",
    version: 2,
    contentRevision: 1,
    publishedTime: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    fields: { primaryColor: "#101820", secondaryColor: "#c9a227" },
    ...overrides
  };
}

const VIS_ZILBERMAN_CAMPAIGN: SiteContextObject = {
  objectId: "vis_zilberman_campaign",
  objectType: "visual_standard",
  status: "saved",
  version: 1,
  contentRevision: 1,
  publishedTime: null,
  updatedAt: "2026-08-20T00:00:00.000Z",
  fields: { primaryColor: "#222222", secondaryColor: "#eeeeee", fontFamily: "Futura", logoAssetId: "asset_campaign_logo" }
};

const REGISTRIES_WITH_TEMPLATE: SiteRegistries = {
  ...DEFAULT_REGISTRIES,
  visualStandards: [...DEFAULT_REGISTRIES.visualStandards, { id: "vis_zilberman_campaign", kind: "template", label: "campaign" }]
};

const grantingApproval = (changeSet: ChangeSet): ScopedApproval => ({
  changeSetId: changeSet.changeSetId,
  revisionId: changeSet.revisionId,
  grantedEffects: changeSet.effects,
  grantedTargets: changeSet.affectedTargets.map(targetKey),
  grantedAtISO: "2026-09-11T12:00:00.000Z",
  grantedBy: "operator:vreich"
});

// Independently computes the SAME change set the executor's own buildImagerySection would compute
// for a "house"/"imagery"-focus request against `data` — used to mint a real ScopedApproval without
// duplicating the executor's own diff logic (reuses compileCandidate/computeChangeSet directly).
async function expectedVisualStandardChangeSet(data: FixtureTenantData, params: { objectId: string | null; fields: Record<string, unknown> }): Promise<ChangeSet> {
  const { source } = createInMemorySiteContextSource(data);
  const snapshot = await captureSiteSnapshot(source, { tenantId: data.tenantId, objectTypes: IMAGERY_OBJECT_TYPES });
  const compiled = compileCandidate({ snapshot, objectType: "visual_standard", objectId: params.objectId, intent: "visual_identity_review_change", fields: params.fields });
  if (!compiled.ok) throw new Error(`expected candidate to compile: ${JSON.stringify(compiled.blockers)}`);
  return computeChangeSet({ snapshot, candidate: compiled.candidate });
}

describe("runVisualIdentityReviewChange — coordinator acceptance criteria", () => {
  it("reports the live vis_zilberman shape as saved-not-applied, never inferring applied from version/content_revision", async () => {
    const data = fixture();
    const { source } = createInMemorySiteContextSource(data);
    const deps: VisualIdentityReviewChangeDeps = { siteContextSource: source };

    const report = await runVisualIdentityReviewChange({ tenantId: TENANT_ID, focus: "imagery", mode: "house" }, deps);

    expect(report.sections.imagery?.existing).toEqual({
      objectId: "vis_zilberman",
      exists: true,
      state: "saved",
      version: 4,
      contentRevision: 2,
      publishedTime: null
    });
    expect(report.sections.imagery?.applied).toBe(false);
    expect(report.sections.imagery?.saved).toBe(false);
    expect(report.sections.imagery?.released).toBe(false);
    expect(report.blockers).toEqual([]);
  });

  it("an inflated version/content_revision still cannot flip applied to true — applied is never derived from save counters", async () => {
    const data = fixture({ objectsByType: { visual_standard: [{ ...VIS_ZILBERMAN_OBJECT, version: 999, contentRevision: 999 }] } });
    const { source } = createInMemorySiteContextSource(data);
    const report = await runVisualIdentityReviewChange({ tenantId: TENANT_ID, focus: "imagery", mode: "house" }, { siteContextSource: source });
    expect(report.sections.imagery?.applied).toBe(false);
  });

  it("an empty standard (no house record at all) is a valid initial state, not an error", async () => {
    const data = fixture({ objectsByType: { visual_standard: [] }, registries: { ...DEFAULT_REGISTRIES, visualStandards: [] } });
    const { source } = createInMemorySiteContextSource(data);
    const proposal = {
      visualStandardFields: { primaryColor: "#0b0f14", secondaryColor: "#d4af37", fontFamily: "Cormorant Garamond", logoAssetId: "asset_new" }
    };
    const proposeVisualIdentity = vi.fn(async () => proposal);

    const report = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", brief: "Start the house look" },
      { siteContextSource: source, proposeVisualIdentity }
    );

    expect(report.blockers.filter((b) => b.blocking)).toEqual([]);
    expect(report.sections.imagery?.existing).toMatchObject({ exists: false, state: "empty", objectId: null });
    const changeSet = report.sections.imagery?.changeSets[0];
    expect(changeSet?.objectId).toBeNull();
    expect(changeSet?.diffs.every((d) => d.op === "add")).toBe(true);
    expect(report.sections.imagery?.imageEffect).toEqual({ demonstrated: true, reason: "visual_standard_fields_changed" });
  });

  it("a preview creates nothing — save and apply are never invoked even when approvals and apply:true are supplied", async () => {
    const data = fixture();
    const { source } = createInMemorySiteContextSource(data);
    const proposeVisualIdentity = vi.fn(async () => ({
      visualStandardFields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#ffbf00" }
    }));
    const materializeVisualStandard = vi.fn(async (): Promise<MaterializeVisualStandardResult> => {
      throw new Error("must never be called from a preview");
    });
    const saveImageModelConfig = vi.fn(async () => {
      throw new Error("must never be called from a preview");
    });

    const report = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", brief: "Refresh the accent", preview: true, apply: true, approvals: [] },
      { siteContextSource: source, proposeVisualIdentity, materializeVisualStandard, saveImageModelConfig }
    );

    expect(materializeVisualStandard).not.toHaveBeenCalled();
    expect(saveImageModelConfig).not.toHaveBeenCalled();
    expect(report.preview).toBe(true);
    // A preview still SHOWS the proposal and its exact diff — that's the whole point.
    expect(report.sections.imagery?.proposal).toBeDefined();
    expect(report.sections.imagery?.changeSets.length).toBe(1);
    expect(report.sections.imagery?.saved).toBe(false);
    expect(report.sections.imagery?.applied).toBe(false);
  });

  it("LoRA registration alone is never reported as a demonstrated image effect", async () => {
    const data = fixture();
    const { source } = createInMemorySiteContextSource(data);
    const proposeVisualIdentity = vi.fn(async () => ({
      imageModelConfigFields: { baseModel: "sdxl-1.0", loraWeightsAssetId: "asset_lora_v2", triggerWord: "zlbfilm", trainingSteps: 2200 }
    }));

    const report = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", brief: "Register the refreshed LoRA" },
      { siteContextSource: source, proposeVisualIdentity }
    );

    expect(report.sections.imagery?.imageEffect).toEqual({ demonstrated: false, reason: "lora_registration_only" });
    expect(report.sections.imagery?.changeSets.length).toBe(1);
    expect(report.sections.imagery?.changeSets[0].objectType).toBe("image_model_config");
  });

  it("a visual_standard field change is demonstrated even alongside a simultaneous LoRA registration", async () => {
    const data = fixture();
    const { source } = createInMemorySiteContextSource(data);
    const proposeVisualIdentity = vi.fn(async () => ({
      visualStandardFields: { ...VIS_ZILBERMAN_OBJECT.fields, primaryColor: "#000000" },
      imageModelConfigFields: { baseModel: "sdxl-1.0", loraWeightsAssetId: "asset_lora_v2", triggerWord: "zlbfilm", trainingSteps: 2200 }
    }));

    const report = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", brief: "New palette plus a LoRA refresh" },
      { siteContextSource: source, proposeVisualIdentity }
    );

    expect(report.sections.imagery?.imageEffect).toEqual({ demonstrated: true, reason: "visual_standard_fields_changed" });
    expect(report.sections.imagery?.changeSets.length).toBe(2);
  });

  it("no-board: works from the tenant's own site content when instructed, and never raises a missing-input blocker", async () => {
    const data = fixture({
      objectsByType: {
        visual_standard: [{ ...VIS_ZILBERMAN_OBJECT, fields: { ...VIS_ZILBERMAN_OBJECT.fields, whenToUse: "Editorial features on Zilberman Film Foundation retrospectives." } }]
      }
    });
    const { source } = createInMemorySiteContextSource(data);
    let capturedBrief = "";
    const proposeVisualIdentity = vi.fn(async (params: ProposeVisualIdentityParams) => {
      capturedBrief = params.brief;
      return { visualStandardFields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#a1a1a1" } };
    });

    const report = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", workFromSiteContent: true },
      { siteContextSource: source, proposeVisualIdentity }
    );

    expect(report.blockers.some((b) => b.code.includes("missing"))).toBe(false);
    expect(capturedBrief.length).toBeGreaterThan(0);
    expect(capturedBrief).toContain("Zilberman Film Foundation retrospectives");
    expect(report.sections.imagery?.changeSets.length).toBe(1);
  });

  it("a review with neither a board, a brief, nor workFromSiteContent is a complete read-only report — not an error", async () => {
    const data = fixture();
    const { source } = createInMemorySiteContextSource(data);
    const proposeVisualIdentity = vi.fn(async () => ({ visualStandardFields: {} }));
    const report = await runVisualIdentityReviewChange({ tenantId: TENANT_ID, focus: "imagery", mode: "house" }, { siteContextSource: source, proposeVisualIdentity });
    expect(proposeVisualIdentity).not.toHaveBeenCalled();
    expect(report.blockers).toEqual([]);
    expect(report.sections.imagery?.existing.exists).toBe(true);
  });

  it("house and named (template) standards are resolved to distinct records and never conflated", async () => {
    const dataHouse = fixture({
      objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT, VIS_ZILBERMAN_CAMPAIGN] },
      registries: REGISTRIES_WITH_TEMPLATE
    });
    const { source: houseSource } = createInMemorySiteContextSource(dataHouse);
    const houseReport = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", brief: "House refresh" },
      { siteContextSource: houseSource, proposeVisualIdentity: async () => ({ visualStandardFields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#111111" } }) }
    );
    expect(houseReport.sections.imagery?.existing.objectId).toBe("vis_zilberman");
    expect(houseReport.sections.imagery?.kind).toBe("house");
    const houseDiff = houseReport.sections.imagery?.changeSets[0].diffs.find((d) => d.field === "secondaryColor");
    expect(houseDiff?.before).toBe(VIS_ZILBERMAN_OBJECT.fields.secondaryColor);

    const dataTemplate = fixture({
      objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT, VIS_ZILBERMAN_CAMPAIGN] },
      registries: REGISTRIES_WITH_TEMPLATE
    });
    const { source: templateSource } = createInMemorySiteContextSource(dataTemplate);
    const templateReport = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "template", templateSlug: "campaign", brief: "Campaign refresh" },
      { siteContextSource: templateSource, proposeVisualIdentity: async () => ({ visualStandardFields: { ...VIS_ZILBERMAN_CAMPAIGN.fields, secondaryColor: "#333333" } }) }
    );
    expect(templateReport.sections.imagery?.existing.objectId).toBe("vis_zilberman_campaign");
    expect(templateReport.sections.imagery?.kind).toBe("template");
    const templateDiff = templateReport.sections.imagery?.changeSets[0].diffs.find((d) => d.field === "secondaryColor");
    expect(templateDiff?.before).toBe(VIS_ZILBERMAN_CAMPAIGN.fields.secondaryColor);
    expect(templateDiff?.before).not.toBe(houseDiff?.before);
  });

  it("theme ids resolve only from real records — an explicit id names a real record, or resolves to nothing, never invented", async () => {
    const dataWithTheme = fixture({ objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT], theme: [themeRecord()] } });
    const { source: goodIdSource } = createInMemorySiteContextSource(dataWithTheme);
    const goodReport = await runVisualIdentityReviewChange({ tenantId: TENANT_ID, focus: "theme", themeId: "theme_zilberman" }, { siteContextSource: goodIdSource });
    expect(goodReport.sections.theme?.objectId).toBe("theme_zilberman");
    expect(goodReport.sections.theme?.exists).toBe(true);
    expect(goodReport.blockers).toEqual([]);

    const dataWithTheme2 = fixture({ objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT], theme: [themeRecord()] } });
    const { source: badIdSource } = createInMemorySiteContextSource(dataWithTheme2);
    const badReport = await runVisualIdentityReviewChange({ tenantId: TENANT_ID, focus: "theme", themeId: "theme_totally_made_up" }, { siteContextSource: badIdSource });
    expect(badReport.sections.theme?.objectId).toBeNull();
    expect(badReport.sections.theme?.exists).toBe(false);
    expect(badReport.blockers.some((b) => b.code === "theme_id_not_found" && !b.blocking)).toBe(true);

    const dataWithTheme3 = fixture({ objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT], theme: [themeRecord()] } });
    const { source: autoSource } = createInMemorySiteContextSource(dataWithTheme3);
    const autoReport = await runVisualIdentityReviewChange({ tenantId: TENANT_ID, focus: "theme" }, { siteContextSource: autoSource });
    expect(autoReport.sections.theme?.objectId).toBe("theme_zilberman");
  });

  it("theme released is read verbatim off publishedTime, never inferred from version/content_revision", async () => {
    const publishedData = fixture({ objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT], theme: [themeRecord({ publishedTime: "2026-08-01T00:00:00.000Z" })] } });
    const { source: publishedSource } = createInMemorySiteContextSource(publishedData);
    const publishedReport = await runVisualIdentityReviewChange({ tenantId: TENANT_ID, focus: "theme" }, { siteContextSource: publishedSource });
    expect(publishedReport.sections.theme?.released).toBe(true);

    const unpublishedData = fixture({ objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT], theme: [themeRecord({ publishedTime: null, version: 50, contentRevision: 50 })] } });
    const { source: unpublishedSource } = createInMemorySiteContextSource(unpublishedData);
    const unpublishedReport = await runVisualIdentityReviewChange({ tenantId: TENANT_ID, focus: "theme" }, { siteContextSource: unpublishedSource });
    expect(unpublishedReport.sections.theme?.released).toBe(false);
  });

  it("a combined (full_review) request produces one report covering imagery, theme and PDF templates — not an inventory-only partial success", async () => {
    const data = fixture({ objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT], theme: [themeRecord({ publishedTime: "2026-08-01T00:00:00.000Z" })] } });
    const { source } = createInMemorySiteContextSource(data);
    const proposeVisualIdentity = vi.fn(async () => ({ visualStandardFields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#f0f0f0" } }));

    const report = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, mode: "house", brief: "Full review of imagery, theme and PDFs" },
      { siteContextSource: source, proposeVisualIdentity }
    );

    expect(report.focus).toBe("full_review");
    // Imagery: not just an inventory — a real proposal and diff are present.
    expect(report.sections.imagery?.proposal).toBeDefined();
    expect(report.sections.imagery?.changeSets.length).toBeGreaterThan(0);
    // Theme: present and correctly resolved from the record.
    expect(report.sections.theme?.objectId).toBe("theme_zilberman");
    expect(report.sections.theme?.released).toBe(true);
    // PDFs: present.
    expect(report.sections.pdfTemplates?.templates.length).toBeGreaterThan(0);
  });
});

describe("applied imagery hash verification (authorized save/apply)", () => {
  const proposedFields = { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#ffbf00" };

  async function reportWithApproval(data: FixtureTenantData, materializeVisualStandard: VisualIdentityReviewChangeDeps["materializeVisualStandard"]) {
    const expectedChangeSet = await expectedVisualStandardChangeSet(data, { objectId: "vis_zilberman", fields: proposedFields });
    const { source } = createInMemorySiteContextSource(data);
    return runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", brief: "Refresh the accent", apply: true, approvals: [grantingApproval(expectedChangeSet)] },
      { siteContextSource: source, proposeVisualIdentity: async () => ({ visualStandardFields: proposedFields }), materializeVisualStandard }
    );
  }

  it("reports applied:true only when the materializer's own post-apply readback hashes identically to what was proposed", async () => {
    const data = fixture();
    const report = await reportWithApproval(data, async () => ({
      visualStandardId: "vis_zilberman",
      created: false,
      status: "active",
      applied: true,
      appliedFieldsReadback: { ...proposedFields } // a fresh object, same content — hash must still match
    }));
    expect(report.sections.imagery?.saved).toBe(true);
    expect(report.sections.imagery?.applied).toBe(true);
    expect(report.sections.imagery?.applyReason).toBeUndefined();
  });

  it("never reports applied:true when the readback's hash does not match what was proposed, even though the materializer claims applied", async () => {
    const data = fixture();
    const report = await reportWithApproval(data, async () => ({
      visualStandardId: "vis_zilberman",
      created: false,
      status: "active",
      applied: true,
      appliedFieldsReadback: { ...proposedFields, secondaryColor: "#000000" } // drifted from what was proposed
    }));
    expect(report.sections.imagery?.saved).toBe(true);
    expect(report.sections.imagery?.applied).toBe(false);
    expect(report.sections.imagery?.applyReason).toBe("apply_hash_mismatch");
  });

  it("never reports applied:true when the materializer claims applied but supplies no readback to verify against", async () => {
    const data = fixture();
    const report = await reportWithApproval(data, async () => ({ visualStandardId: "vis_zilberman", created: false, status: "active", applied: true }));
    expect(report.sections.imagery?.applied).toBe(false);
    expect(report.sections.imagery?.applyReason).toBe("apply_hash_unverifiable_no_readback");
  });

  it("passes through a refused apply's own named reason, saved:true, applied:false", async () => {
    const data = fixture();
    const report = await reportWithApproval(data, async () => ({
      visualStandardId: "vis_zilberman",
      created: false,
      status: "draft",
      applied: false,
      reason: "apply_policy_needs_approval"
    }));
    expect(report.sections.imagery?.saved).toBe(true);
    expect(report.sections.imagery?.applied).toBe(false);
    expect(report.sections.imagery?.applyReason).toBe("apply_policy_needs_approval");
  });

  it("never invokes the materializer at all when no approval authorizes the save", async () => {
    const data = fixture();
    const { source } = createInMemorySiteContextSource(data);
    const materializeVisualStandard = vi.fn(async (): Promise<MaterializeVisualStandardResult> => {
      throw new Error("must never be called without an authorizing approval");
    });
    const report = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", brief: "Refresh the accent", apply: true },
      { siteContextSource: source, proposeVisualIdentity: async () => ({ visualStandardFields: proposedFields }), materializeVisualStandard }
    );
    expect(materializeVisualStandard).not.toHaveBeenCalled();
    expect(report.sections.imagery?.saved).toBe(false);
    expect(report.sections.imagery?.applied).toBe(false);
  });
});

describe("no generic publish of visual_standard — saving is not applying, applying is not releasing", () => {
  it("visual_standard's released is always false and every computed effect is save-kind, never publish/apply/release-shaped", async () => {
    const data = fixture();
    const { source } = createInMemorySiteContextSource(data);
    const report = await runVisualIdentityReviewChange(
      { tenantId: TENANT_ID, focus: "imagery", mode: "house", brief: "Refresh", apply: true },
      { siteContextSource: source, proposeVisualIdentity: async () => ({ visualStandardFields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#ffbf00" } }) }
    );
    expect(report.sections.imagery?.released).toBe(false);
    for (const changeSet of report.sections.imagery?.changeSets ?? []) {
      for (const effect of changeSet.effects) expect(effect.kind.startsWith("save_")).toBe(true);
    }
  });

  it("the executor module's own source never invokes object_publish or release_to_production (comments describing what it never does are fine)", () => {
    const modulePath = fileURLToPath(new URL("../../../src/agent/operations/visualIdentityReviewChangeExecutor.ts", import.meta.url));
    const codeOnly = readFileSync(modulePath, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/object_publish/);
    expect(codeOnly).not.toMatch(/release_to_production/);
  });
});

describe("pure helper functions", () => {
  it("classifyImageEffect: no diffs on either change set reports no_change", () => {
    expect(classifyImageEffect({})).toEqual({ demonstrated: false, reason: "no_change" });
  });

  it("resolveVisualStandardTarget: an unverified explicit visualStandardId is never treated as real", async () => {
    const data = fixture();
    const { source } = createInMemorySiteContextSource(data);
    const snapshot = await captureSiteSnapshot(source, { tenantId: TENANT_ID, objectTypes: IMAGERY_OBJECT_TYPES });
    const result = resolveVisualStandardTarget(snapshot, { mode: "house", visualStandardId: "vis_totally_made_up" });
    // Falls through to the normal house resolution rather than trusting the fabricated id.
    expect(result.objectId).toBe("vis_zilberman");
  });

  it("resolveRecordTarget: zero or multiple candidate records resolve to nothing rather than guessing", async () => {
    const data = fixture({ objectsByType: { visual_standard: [VIS_ZILBERMAN_OBJECT], theme: [] } });
    const { source } = createInMemorySiteContextSource(data);
    const snapshot = await captureSiteSnapshot(source, { tenantId: TENANT_ID, objectTypes: [...IMAGERY_OBJECT_TYPES, "theme"] });
    expect(resolveRecordTarget(snapshot, "theme").objectId).toBeNull();
  });

  it("inferBriefFromSiteContent: a tenant with no existing standard states that plainly, never fabricating content", async () => {
    const data = fixture({ objectsByType: { visual_standard: [] }, registries: { ...DEFAULT_REGISTRIES, visualStandards: [] } });
    const { source } = createInMemorySiteContextSource(data);
    const snapshot = await captureSiteSnapshot(source, { tenantId: TENANT_ID, objectTypes: IMAGERY_OBJECT_TYPES });
    const brief = inferBriefFromSiteContent(snapshot, { kind: "house" });
    expect(brief).toContain("No existing house visual standard");
    expect(brief).toContain(TENANT_ID);
  });
});
