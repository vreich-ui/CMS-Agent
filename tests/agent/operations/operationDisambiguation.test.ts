import { describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { disambiguateOperation } from "../../../src/agent/operations/operationDisambiguation.js";

describe("disambiguateOperation", () => {
  it("a bare 'template' request with no surface signal returns the web and PDF alternatives, sorted", () => {
    const result = disambiguateOperation("I want to revise a template");
    expect("alternatives" in result).toBe(true);
    if ("alternatives" in result) {
      const ids = result.alternatives.map((d) => d.operationId);
      expect(ids).toEqual([...ids].sort());
      expect(ids).toContain("image_template_revision");
      expect(ids).toContain("pdf_template_family");
      expect(ids).toHaveLength(2);
    }
  });

  it("the same request with an explicit pdf surface signal resolves to the PDF operation with no alternatives", () => {
    const result = disambiguateOperation("I want to revise a template", { surface: "pdf" });
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) expect(result.resolved.operationId).toBe("pdf_template_family");
    expect("alternatives" in result).toBe(false);
  });

  it("the same request with an explicit web surface signal resolves to the web operation with no alternatives", () => {
    const result = disambiguateOperation("I want to revise a template", { surface: "web" });
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) expect(result.resolved.operationId).toBe("image_template_revision");
  });

  it("a PDF-bound TemplateRef in context resolves to the PDF operation with no alternatives", () => {
    const result = disambiguateOperation("I want to revise a template", {
      refs: [{ surface: "pdf", templateId: "tmpl_1", tenantId: "dr-lurie" }]
    });
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) expect(result.resolved.operationId).toBe("pdf_template_family");
  });

  it("a PDF-bound AssetRef in context resolves to the PDF operation, exactly as a PDF-bound TemplateRef does", () => {
    const result = disambiguateOperation("I want to revise a template", {
      refs: [{ kind: "stored_media", assetId: "asset_1", tenantId: "dr-lurie", surface: "pdf" }]
    });
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) expect(result.resolved.operationId).toBe("pdf_template_family");
  });

  it("a web-bound AssetRef in context resolves to the web operation with no alternatives", () => {
    const result = disambiguateOperation("I want to revise a template", {
      refs: [{ kind: "stored_media", assetId: "asset_1", tenantId: "dr-lurie", surface: "web" }]
    });
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) expect(result.resolved.operationId).toBe("image_template_revision");
  });

  it("an AssetRef with no declared surface contributes no signal, same as before this field existed", () => {
    const result = disambiguateOperation("I want to revise a template", {
      refs: [{ kind: "stored_media", assetId: "asset_1", tenantId: "dr-lurie" }]
    });
    expect("alternatives" in result).toBe(true);
    if ("alternatives" in result) expect(result.alternatives.map((d) => d.operationId)).toEqual(["image_template_revision", "pdf_template_family"]);
  });

  it("identical input produces identical output across repeated calls (pure, no clock, no randomness)", () => {
    const first = disambiguateOperation("I want to revise a template");
    const second = disambiguateOperation("I want to revise a template");
    expect(first).toEqual(second);

    const firstScoped = disambiguateOperation("I want to revise a template", { surface: "pdf" });
    const secondScoped = disambiguateOperation("I want to revise a template", { surface: "pdf" });
    expect(firstScoped).toEqual(secondScoped);
  });

  it("an intent matching exactly one operation's keywords resolves directly", () => {
    const result = disambiguateOperation("find an image to reuse");
    expect("resolved" in result).toBe(true);
    if ("resolved" in result) expect(result.resolved.operationId).toBe("asset_lookup_adopt");
  });

  it("an intent matching no operation's keywords returns an empty alternatives list, not a throw", () => {
    const result = disambiguateOperation("completely unrelated gibberish about nothing in the catalog");
    expect(result).toEqual({ alternatives: [] });
  });
});
