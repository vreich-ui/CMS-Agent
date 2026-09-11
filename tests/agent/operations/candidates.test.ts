import { describe, expect, it } from "vitest";
import { compileCandidate } from "../../../src/agent/operations/candidates.js";
import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import { buildZilbermanFixtureData, createInMemorySiteContextSource } from "./fixtures/inMemorySiteContextSource.js";

const OBJECT_TYPES = ["visual_standard", "image_model_config"];

async function zilbermanSnapshot() {
  const { source } = createInMemorySiteContextSource(buildZilbermanFixtureData());
  return captureSiteSnapshot(source, { tenantId: "zilberman-ff", objectTypes: OBJECT_TYPES });
}

describe("compileCandidate", () => {
  it("a visual-standard candidate compiles valid on the first attempt from a realistic fixture", async () => {
    const snapshot = await zilbermanSnapshot();
    const result = compileCandidate({
      snapshot,
      objectType: "visual_standard",
      intent: "Update the house palette for the new season",
      fields: {
        primaryColor: "#0b0f14",
        secondaryColor: "#d4af37",
        fontFamily: "Cormorant Garamond",
        logoAssetId: "asset_zilberman_logo_v3"
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.snapshotDigest).toBe(snapshot.digest);
      expect(result.candidate.revisionId).toBe(snapshot.revisionId);
      expect(result.candidate.objectType).toBe("visual_standard");
    }
  });

  it("a LoRA-style model-config candidate compiles valid on the first attempt from a realistic fixture", async () => {
    const snapshot = await zilbermanSnapshot();
    const result = compileCandidate({
      snapshot,
      objectType: "image_model_config",
      intent: "Register the new brand LoRA for product photography",
      fields: {
        baseModel: "sdxl-1.0",
        loraWeightsAssetId: "asset_zilberman_lora_v1",
        triggerWord: "zlbfilm",
        trainingSteps: 2000,
        loraWeight: 0.8
      }
    });
    expect(result.ok).toBe(true);
  });

  it("a missing required field produces a named, structured blocker — never a silent default", async () => {
    const snapshot = await zilbermanSnapshot();
    const result = compileCandidate({
      snapshot,
      objectType: "visual_standard",
      intent: "Update the palette",
      fields: { primaryColor: "#0b0f14", secondaryColor: "#d4af37", fontFamily: "Cormorant Garamond" } // logoAssetId omitted
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const blocker = result.blockers.find((b) => b.code === "required_field_missing");
      expect(blocker).toBeDefined();
      expect(blocker?.evidence?.field).toBe("logoAssetId");
      expect(blocker?.blocking).toBe(true);
      expect(blocker?.remedy).toMatch(/logoAssetId/);
    }
  });

  it("a field violating the contract's schema (not merely missing) is a distinct, named blocker", async () => {
    const snapshot = await zilbermanSnapshot();
    const result = compileCandidate({
      snapshot,
      objectType: "visual_standard",
      intent: "Update the palette",
      fields: { primaryColor: "not-a-hex-color", secondaryColor: "#d4af37", fontFamily: "Cormorant Garamond", logoAssetId: "asset_1" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.some((b) => b.code === "field_contract_violation")).toBe(true);
      expect(result.blockers.every((b) => b.blocking)).toBe(true);
    }
  });

  it("an object type with no contract in this snapshot is refused by name, never defaulted", async () => {
    const snapshot = await zilbermanSnapshot();
    const result = compileCandidate({ snapshot, objectType: "pdf_template", intent: "Design a template", fields: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers[0].code).toBe("object_contract_unavailable");
      expect(result.blockers[0].evidence?.objectType).toBe("pdf_template");
    }
  });
});
