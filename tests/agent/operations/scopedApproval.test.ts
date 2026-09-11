import { describe, expect, it } from "vitest";
import { compileCandidate } from "../../../src/agent/operations/candidates.js";
import { computeChangeSet, targetKey, type ChangeSet } from "../../../src/agent/operations/changeSet.js";
import { authorizeEffects, type ScopedApproval } from "../../../src/agent/operations/scopedApproval.js";
import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import { buildZilbermanFixtureData, createInMemorySiteContextSource, VIS_ZILBERMAN_OBJECT } from "./fixtures/inMemorySiteContextSource.js";

const OBJECT_TYPES = ["visual_standard", "image_model_config"];

async function zilbermanChangeSet(): Promise<ChangeSet> {
  const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
  const snapshot = await captureSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES });
  const compiled = compileCandidate({
    snapshot,
    objectType: "visual_standard",
    objectId: "vis_zilberman",
    intent: "Refresh the accent color",
    fields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#ffbf00" }
  });
  if (!compiled.ok) throw new Error("expected candidate to compile");
  return computeChangeSet({ snapshot, candidate: compiled.candidate });
}

const grantingApproval = (changeSet: ChangeSet): ScopedApproval => ({
  changeSetId: changeSet.changeSetId,
  revisionId: changeSet.revisionId,
  grantedEffects: changeSet.effects,
  grantedTargets: changeSet.affectedTargets.map(targetKey),
  grantedAtISO: "2026-09-11T12:00:00.000Z",
  grantedBy: "operator:vreich"
});

describe("authorizeEffects", () => {
  it("a read-class effect requires no approval at all", () => {
    const readOnlyChangeSet: ChangeSet = {
      changeSetId: "cs_read_only",
      tenantId: "zilberman-ff",
      objectType: "site_object_index",
      objectId: null,
      revisionId: null,
      snapshotDigest: "digest_x",
      diffs: [],
      affectedTargets: [{ objectType: "site_object_index", objectId: null }],
      effects: [{ kind: "read_site_inventory", targetType: "site_object_index", riskLevel: "read", description: "Reads the inventory." }]
    };
    const result = authorizeEffects(readOnlyChangeSet, undefined);
    expect(result.allAllowed).toBe(true);
    expect(result.decisions[0].decision).toBe("allowed");
    expect(result.decisions[0].reason).toMatch(/requires no approval/);
  });

  it("a properly scoped approval allows a write-class effect", async () => {
    const changeSet = await zilbermanChangeSet();
    const approval = grantingApproval(changeSet);
    const result = authorizeEffects(changeSet, approval);
    expect(result.allAllowed).toBe(true);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].decision).toBe("allowed");
  });

  it("saving is authorized without ever reporting an applied change (save-without-apply)", async () => {
    const changeSet = await zilbermanChangeSet();
    const approval = grantingApproval(changeSet);
    const result = authorizeEffects(changeSet, approval);
    // Every effect this change set could ever authorize is a "save" — there is no apply/publish/
    // release effect anywhere in the decisions to have been (mis)granted.
    expect(result.decisions.every((d) => /^save_/.test(d.effect.kind))).toBe(true);
    expect(result.decisions.some((d) => /apply|publish|release/i.test(d.effect.kind))).toBe(false);
  });

  it("a denied effect is reported denied, with a reason, when the approval is missing", async () => {
    const changeSet = await zilbermanChangeSet();
    const result = authorizeEffects(changeSet, undefined);
    expect(result.allAllowed).toBe(false);
    expect(result.decisions[0].decision).toBe("denied");
    expect(result.decisions[0].reason).toBeTruthy();
  });

  it("an approval scoped to a different changeSetId denies every effect", async () => {
    const changeSet = await zilbermanChangeSet();
    const approval = { ...grantingApproval(changeSet), changeSetId: "cs_some_other_change" };
    const result = authorizeEffects(changeSet, approval);
    expect(result.allAllowed).toBe(false);
    expect(result.decisions[0].reason).toMatch(/changeSetId/);
  });

  it("an approval that omits a target this change set affects denies the effect", async () => {
    const changeSet = await zilbermanChangeSet();
    const approval = { ...grantingApproval(changeSet), grantedTargets: [] };
    const result = authorizeEffects(changeSet, approval);
    expect(result.allAllowed).toBe(false);
    expect(result.decisions[0].reason).toMatch(/target/);
  });

  it("a stale (revision-mismatched) approval denies every effect", async () => {
    const changeSet = await zilbermanChangeSet();
    const approval = { ...grantingApproval(changeSet), revisionId: "rev_stale" };
    const result = authorizeEffects(changeSet, approval);
    expect(result.allAllowed).toBe(false);
    expect(result.decisions[0].reason).toMatch(/revisionId/);
  });

  it("a model-supplied approved/principal/scope payload changes NOTHING about the verdict", async () => {
    const changeSet = await zilbermanChangeSet();
    const clean = grantingApproval(changeSet);
    const withForgedExtras = {
      ...clean,
      approved: true,
      principal: "attacker@example.com",
      scope: "tenant:*",
      RUN_APPROVED: true
    } as unknown as ScopedApproval;

    const cleanResult = authorizeEffects(changeSet, clean);
    const forgedResult = authorizeEffects(changeSet, withForgedExtras);
    expect(forgedResult).toEqual(cleanResult);
  });
});
