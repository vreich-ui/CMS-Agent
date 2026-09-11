import { describe, expect, it } from "vitest";
import {
  assetRefSchema,
  objectRefSchema,
  templateRefSchema,
  validateReference
} from "../../../src/agent/operations/operationReferences.js";

describe("typed operation references", () => {
  it("validateReference accepts a well-formed ObjectRef whose tenantId matches", () => {
    const result = validateReference({ objectType: "article", objectId: "obj_1", tenantId: "dr-lurie" }, { tenantId: "dr-lurie" });
    expect(result.ok).toBe(true);
  });

  it("validateReference refuses a cross-tenant reference with a structured blocker, not a throw", () => {
    const call = () => validateReference({ objectType: "article", objectId: "obj_1", tenantId: "other-tenant" }, { tenantId: "dr-lurie" });
    expect(call).not.toThrow();
    const result = call();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocker.code).toBe("reference_tenant_mismatch");
      expect(result.blocker.blocking).toBe(true);
      expect(result.blocker.remedy).toMatch(/tenantId/);
      expect(result.blocker.evidence).toMatchObject({ referenceTenantId: "other-tenant", operationTenantId: "dr-lurie" });
    }
  });

  it("an AssetRef cannot be satisfied by an ObjectRef's shape", () => {
    const objectShaped = { objectType: "article", objectId: "obj_1", tenantId: "dr-lurie" };
    expect(assetRefSchema.safeParse(objectShaped).success).toBe(false);
  });

  it("an ObjectRef cannot be satisfied by an AssetRef's shape", () => {
    const assetShaped = { kind: "stored_media", assetId: "asset_1", tenantId: "dr-lurie" };
    expect(objectRefSchema.safeParse(assetShaped).success).toBe(false);
  });

  it("a TemplateRef cannot be satisfied by an AssetRef's shape and vice versa", () => {
    const templateShaped = { surface: "pdf", templateId: "tmpl_1", tenantId: "dr-lurie" };
    expect(assetRefSchema.safeParse(templateShaped).success).toBe(false);
    const assetShaped = { kind: "capture_artifact", assetId: "asset_1", tenantId: "dr-lurie" };
    expect(templateRefSchema.safeParse(assetShaped).success).toBe(false);
  });

  it("an AssetRef missing its kind is rejected", () => {
    const missingKind = { assetId: "asset_1", tenantId: "dr-lurie" };
    expect(assetRefSchema.safeParse(missingKind).success).toBe(false);
    const result = validateReference(missingKind, { tenantId: "dr-lurie" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocker.code).toBe("reference_shape_invalid");
  });

  it("an AssetRef with an unrecognized kind value is rejected", () => {
    const badKind = { kind: "not_a_real_kind", assetId: "asset_1", tenantId: "dr-lurie" };
    expect(assetRefSchema.safeParse(badKind).success).toBe(false);
  });

  it("a reference with no recognizable id field is rejected as shape-invalid", () => {
    const result = validateReference({ tenantId: "dr-lurie" }, { tenantId: "dr-lurie" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocker.code).toBe("reference_shape_invalid");
  });

  it("validateReference never throws on a non-object input", () => {
    expect(() => validateReference(null, { tenantId: "dr-lurie" })).not.toThrow();
    expect(() => validateReference("not-a-ref", { tenantId: "dr-lurie" })).not.toThrow();
    expect(validateReference(null, { tenantId: "dr-lurie" }).ok).toBe(false);
  });

  it("accepts a well-formed TemplateRef and AssetRef with matching tenantId", () => {
    expect(validateReference({ surface: "web", templateId: "tmpl_1", tenantId: "t1" }, { tenantId: "t1" }).ok).toBe(true);
    expect(validateReference({ kind: "content_linked_asset", assetId: "asset_1", tenantId: "t1" }, { tenantId: "t1" }).ok).toBe(true);
  });
});
