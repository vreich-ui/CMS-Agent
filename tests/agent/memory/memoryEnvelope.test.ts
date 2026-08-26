import { describe, expect, it } from "vitest";
import { buildTemplateArtifactId, memoryEnvelopeSchema, templateArtifactValueSchema } from "../../../src/agent/memory/memoryEnvelope.js";

const validEnvelope = {
  schemaVersion: "agent.memory.v1",
  facts: [{ key: "audience", value: "operators", confidence: 0.9, source: "user" }],
  preferences: { tone: "practical" },
  openLoops: [{ id: "loop-1", status: "open", description: "Confirm SME quote" }],
  artifacts: [{ id: "draft-1", type: "draft", value: "# Draft" }]
};

describe("memoryEnvelopeSchema", () => {
  it("parses valid envelopes", () => {
    expect(memoryEnvelopeSchema.parse(validEnvelope)).toMatchObject(validEnvelope);
  });

  it("fails for invalid schemaVersion", () => {
    expect(() => memoryEnvelopeSchema.parse({ ...validEnvelope, schemaVersion: "v2" })).toThrow();
  });

  it("fails for invalid fact confidence", () => {
    expect(() => memoryEnvelopeSchema.parse({ ...validEnvelope, facts: [{ key: "x", value: "y", confidence: 1.1, source: "user" }] })).toThrow();
  });

  it("fails for invalid artifact type", () => {
    expect(() => memoryEnvelopeSchema.parse({ ...validEnvelope, artifacts: [{ id: "bad", type: "video" }] })).toThrow();
  });

  // T15.32 (#208; ADR-2026-08-25-structure-studio §5.1) — "template" artifacts.
  it("accepts a 'template' artifact carrying the ADR §5.1 shape", () => {
    const templateArtifact = {
      id: "zilberman::section_template::req_hero@1",
      type: "template",
      value: {
        templateId: "zilberman::section_template::req_hero",
        version: 1,
        objectType: "section_template",
        instantiatedObjectId: "tmpl_hero_1",
        provenance: { sourceUrl: "https://zilberman.example/", captureRunId: "run_1", engineHashes: { "clone.mjs": "abc" }, standardsPack: "2026.08" }
      }
    };
    const parsed = memoryEnvelopeSchema.parse({ ...validEnvelope, artifacts: [...validEnvelope.artifacts, templateArtifact] });
    expect(parsed.artifacts).toContainEqual(templateArtifact);
  });

  it("no existing consumer breaks: pre-existing artifact types still parse unchanged alongside the new enum member", () => {
    expect(memoryEnvelopeSchema.parse(validEnvelope)).toMatchObject(validEnvelope);
  });
});

describe("templateArtifactValueSchema", () => {
  const value = () => ({
    templateId: "zilberman::section_template::req_hero",
    version: 1,
    objectType: "section_template" as const,
    instantiatedObjectId: "tmpl_hero_1",
    provenance: { sourceUrl: "https://zilberman.example/", captureRunId: "run_1", engineHashes: { "clone.mjs": "abc" }, standardsPack: "2026.08" }
  });

  it("parses a well-formed template record", () => {
    expect(templateArtifactValueSchema.parse(value())).toEqual(value());
  });

  it("accepts objectType pdf_template (ADR §7)", () => {
    expect(templateArtifactValueSchema.parse({ ...value(), objectType: "pdf_template" }).objectType).toBe("pdf_template");
  });

  it("allows captureRunId to be absent (a demand-driven template has none)", () => {
    const { provenance, ...rest } = value();
    const { captureRunId, ...provenanceWithoutRun } = provenance;
    expect(() => templateArtifactValueSchema.parse({ ...rest, provenance: provenanceWithoutRun })).not.toThrow();
  });

  it("rejects a non-positive version", () => {
    expect(() => templateArtifactValueSchema.parse({ ...value(), version: 0 })).toThrow();
  });

  it("rejects a missing provenance.sourceUrl", () => {
    const { provenance, ...rest } = value();
    const { sourceUrl, ...provenanceWithoutUrl } = provenance;
    expect(() => templateArtifactValueSchema.parse({ ...rest, provenance: provenanceWithoutUrl })).toThrow();
  });
});

describe("buildTemplateArtifactId", () => {
  it("joins templateId and version with '@', matching ADR §5.1's `<templateId>@<version>`", () => {
    expect(buildTemplateArtifactId("zilberman::section_template::req_hero", 3)).toBe("zilberman::section_template::req_hero@3");
  });
});
