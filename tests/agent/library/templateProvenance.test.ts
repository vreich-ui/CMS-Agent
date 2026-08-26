import { describe, expect, it } from "vitest";
import { buildCaptureEngineHashes, STANDARDS_PACK_VERSION, validateTemplateProvenance } from "../../../src/agent/library/templateProvenance.js";
import { CAPTURE_ENGINE_FILES } from "../../../src/agent/capture/provenance.js";

describe("buildCaptureEngineHashes", () => {
  it("is a pure, synchronous read of provenance.ts's own pinned vendoredSha256 values", () => {
    const hashes = buildCaptureEngineHashes();
    expect(Object.keys(hashes).sort()).toEqual(CAPTURE_ENGINE_FILES.map((entry) => entry.file).sort());
    for (const entry of CAPTURE_ENGINE_FILES) expect(hashes[entry.file]).toBe(entry.vendoredSha256);
  });

  it("is deterministic across calls", () => {
    expect(buildCaptureEngineHashes()).toEqual(buildCaptureEngineHashes());
  });
});

const validInput = () => ({
  sourceUrl: "https://example.com/",
  captureRunId: "run_capture_1",
  driven: "clone" as const,
  engineHashes: buildCaptureEngineHashes(),
  standardsPack: STANDARDS_PACK_VERSION
});

describe("validateTemplateProvenance", () => {
  it("accepts a fully-stated clone-driven provenance", () => {
    const result = validateTemplateProvenance(validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.provenance).toEqual({
      sourceUrl: "https://example.com/",
      captureRunId: "run_capture_1",
      engineHashes: buildCaptureEngineHashes(),
      standardsPack: STANDARDS_PACK_VERSION
    });
  });

  it("refuses with a NAMED reason when sourceUrl is missing", () => {
    const result = validateTemplateProvenance({ ...validInput(), sourceUrl: undefined });
    expect(result).toMatchObject({ ok: false, code: "template_provenance_unstateable" });
  });

  it("refuses with a NAMED reason when sourceUrl is not HTTPS", () => {
    const result = validateTemplateProvenance({ ...validInput(), sourceUrl: "http://example.com/" });
    expect(result).toMatchObject({ ok: false, code: "template_provenance_unstateable" });
  });

  it("refuses with a NAMED reason when sourceUrl is not a parseable URL", () => {
    const result = validateTemplateProvenance({ ...validInput(), sourceUrl: "not a url" });
    expect(result).toMatchObject({ ok: false, code: "template_provenance_unstateable" });
  });

  it("refuses a clone-driven template with no captureRunId", () => {
    const result = validateTemplateProvenance({ ...validInput(), captureRunId: undefined });
    expect(result).toMatchObject({ ok: false, code: "template_provenance_unstateable" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("captureRunId");
  });

  it("does NOT require captureRunId for a demand-driven template", () => {
    const result = validateTemplateProvenance({ ...validInput(), driven: "demand", captureRunId: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.provenance.captureRunId).toBeUndefined();
  });

  it("refuses when engineHashes is empty", () => {
    const result = validateTemplateProvenance({ ...validInput(), engineHashes: {} });
    expect(result).toMatchObject({ ok: false, code: "template_provenance_unstateable" });
  });

  it("refuses when standardsPack is empty", () => {
    const result = validateTemplateProvenance({ ...validInput(), standardsPack: "" });
    expect(result).toMatchObject({ ok: false, code: "template_provenance_unstateable" });
  });
});
