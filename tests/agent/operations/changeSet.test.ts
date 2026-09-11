import { describe, expect, it } from "vitest";
import { compileCandidate } from "../../../src/agent/operations/candidates.js";
import { computeChangeSet, isChangeSetStale } from "../../../src/agent/operations/changeSet.js";
import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import { buildZilbermanFixtureData, createInMemorySiteContextSource, VIS_ZILBERMAN_OBJECT } from "./fixtures/inMemorySiteContextSource.js";

const OBJECT_TYPES = ["visual_standard", "image_model_config"];

async function zilbermanSnapshot(overrides: Parameters<typeof buildZilbermanFixtureData>[0] = {}) {
  const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData(overrides));
  return captureSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES });
}

describe("computeChangeSet", () => {
  it("produces an exact field-level diff and affected-target list against the object's CURRENT state", async () => {
    const snapshot = await zilbermanSnapshot();
    const compiled = compileCandidate({
      snapshot,
      objectType: "visual_standard",
      objectId: "vis_zilberman",
      intent: "Refresh the accent color only",
      fields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#ffbf00" }
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const changeSet = computeChangeSet({ snapshot, candidate: compiled.candidate });
    expect(changeSet.diffs).toEqual([{ field: "secondaryColor", op: "replace", before: "#c9a227", after: "#ffbf00" }]);
    expect(changeSet.affectedTargets).toEqual([{ objectType: "visual_standard", objectId: "vis_zilberman" }]);
    expect(changeSet.revisionId).toBe(snapshot.revisionId);
    expect(changeSet.snapshotDigest).toBe(snapshot.digest);
  });

  it("a candidate with no objectId diffs against nothing: every field is an addition, target objectId is null", async () => {
    const snapshot = await zilbermanSnapshot();
    const compiled = compileCandidate({
      snapshot,
      objectType: "image_model_config",
      intent: "Register a new LoRA",
      fields: { baseModel: "sdxl-1.0", loraWeightsAssetId: "asset_lora_2", triggerWord: "zlbfilm2", trainingSteps: 1500 }
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const changeSet = computeChangeSet({ snapshot, candidate: compiled.candidate });
    expect(changeSet.diffs.every((d) => d.op === "add")).toBe(true);
    expect(changeSet.diffs.map((d) => d.field).sort()).toEqual(["baseModel", "loraWeightsAssetId", "trainingSteps", "triggerWord"]);
    expect(changeSet.affectedTargets).toEqual([{ objectType: "image_model_config", objectId: null }]);
  });

  it("recomputing from the same snapshot and candidate keeps the same changeSetId (unchanged retry, no new identity)", async () => {
    const snapshot = await zilbermanSnapshot();
    const compiled = compileCandidate({
      snapshot,
      objectType: "visual_standard",
      objectId: "vis_zilberman",
      intent: "Refresh the accent color only",
      fields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#ffbf00" }
    });
    if (!compiled.ok) throw new Error("expected candidate to compile");

    const first = computeChangeSet({ snapshot, candidate: compiled.candidate });
    const second = computeChangeSet({ snapshot, candidate: compiled.candidate });
    expect(second.changeSetId).toBe(first.changeSetId);
  });

  it("a genuinely different diff gets a different changeSetId", async () => {
    const snapshot = await zilbermanSnapshot();
    const compiledA = compileCandidate({
      snapshot,
      objectType: "visual_standard",
      objectId: "vis_zilberman",
      intent: "Refresh the accent color",
      fields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#ffbf00" }
    });
    const compiledB = compileCandidate({
      snapshot,
      objectType: "visual_standard",
      objectId: "vis_zilberman",
      intent: "Refresh the accent color, differently",
      fields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#00ffbf" }
    });
    if (!compiledA.ok || !compiledB.ok) throw new Error("expected both candidates to compile");
    const changeSetA = computeChangeSet({ snapshot, candidate: compiledA.candidate });
    const changeSetB = computeChangeSet({ snapshot, candidate: compiledB.candidate });
    expect(changeSetA.changeSetId).not.toBe(changeSetB.changeSetId);
  });

  it("declares exactly one 'save' effect — never an implied apply/publish/release effect (the Zilberman case)", async () => {
    const snapshot = await zilbermanSnapshot();
    const compiled = compileCandidate({
      snapshot,
      objectType: "visual_standard",
      objectId: "vis_zilberman",
      intent: "Save a palette tweak",
      fields: { ...VIS_ZILBERMAN_OBJECT.fields, secondaryColor: "#ffbf00" }
    });
    if (!compiled.ok) throw new Error("expected candidate to compile");
    const changeSet = computeChangeSet({ snapshot, candidate: compiled.candidate });

    expect(changeSet.effects).toHaveLength(1);
    expect(changeSet.effects[0].kind).toMatch(/^save_/);
    expect(changeSet.effects.some((e) => /apply|publish|release/i.test(e.kind))).toBe(false);
    // The object this diffs against is itself the live example: saved repeatedly, never applied.
    expect(VIS_ZILBERMAN_OBJECT.version).toBe(4);
    expect(VIS_ZILBERMAN_OBJECT.contentRevision).toBe(2);
    expect(VIS_ZILBERMAN_OBJECT.publishedTime).toBeNull();
  });
});

describe("isChangeSetStale", () => {
  it("is false when the current snapshot's revision matches the one the change set was computed from", async () => {
    const snapshot = await zilbermanSnapshot();
    const compiled = compileCandidate({ snapshot, objectType: "visual_standard", objectId: "vis_zilberman", intent: "x", fields: VIS_ZILBERMAN_OBJECT.fields });
    if (!compiled.ok) throw new Error("expected candidate to compile");
    const changeSet = computeChangeSet({ snapshot, candidate: compiled.candidate });
    expect(isChangeSetStale(changeSet, snapshot)).toBe(false);
  });

  it("is true once the underlying revision has moved — a stale change set invalidates its approval", async () => {
    const snapshot = await zilbermanSnapshot();
    const compiled = compileCandidate({ snapshot, objectType: "visual_standard", objectId: "vis_zilberman", intent: "x", fields: VIS_ZILBERMAN_OBJECT.fields });
    if (!compiled.ok) throw new Error("expected candidate to compile");
    const changeSet = computeChangeSet({ snapshot, candidate: compiled.candidate });

    const movedSnapshot = await zilbermanSnapshot({ revisionId: "rev_2026_09_12_01" });
    expect(isChangeSetStale(changeSet, movedSnapshot)).toBe(true);
  });
});
