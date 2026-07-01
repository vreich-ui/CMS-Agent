import { describe, expect, it } from "vitest";
import { memoryEnvelopeSchema } from "../../../src/agent/memory/memoryEnvelope.js";

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
});
