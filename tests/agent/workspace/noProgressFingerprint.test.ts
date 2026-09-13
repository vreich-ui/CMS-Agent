import { describe, expect, it } from "vitest";
import {
  checkNoProgress,
  computeAttemptConditionsHash,
  computeAttemptFingerprint,
  normalizeFailureText,
  recordTerminalFailure,
  CAPABILITY_STATE_UNKNOWN,
  type AttemptConditions
} from "../../../src/agent/workspace/noProgressFingerprint.js";

const baseConditions = (overrides: Partial<AttemptConditions> = {}): AttemptConditions => ({
  workflowId: "publishing_conductor",
  nodeId: "input_triage",
  nodeDefinitionRevision: "2026-01-01T00:00:00.000Z",
  input: { a: 1, b: "x" },
  capabilityAvailability: undefined,
  ...overrides
});

describe("R2 — normalizeFailureText", () => {
  it("is stable across incidental differences: timestamps, run ids, request ids, uuids and opaque provider ids", () => {
    const a = normalizeFailureText("tool_failed", "call run_1787656120374_18bobg failed at 2026-09-04T12:00:00.123Z (req_publish_topic_20260904_01, id 550e8400-e29b-41d4-a716-446655440000, trace 9f8a7b6c5d4e3f201a0b1c2d3e4f5061)");
    const b = normalizeFailureText("tool_failed", "call run_zzzzzzzzzzzzzzzz failed at 2026-09-05T08:30:11.999Z (req_publish_topic_20260905_02, id 123e4567-e89b-12d3-a456-426614174000, trace 0011223344556677889900112233445566)");
    expect(a).toBe(b);
  });

  it("distinguishes a genuinely different message", () => {
    const a = normalizeFailureText("tool_failed", "the client rejected the payload: missing field 'title'");
    const b = normalizeFailureText("tool_failed", "the client rejected the payload: missing field 'body'");
    expect(a).not.toBe(b);
  });

  it("distinguishes a genuinely different code even with the same message", () => {
    const a = normalizeFailureText("model_error", "provider unavailable");
    const b = normalizeFailureText("timeout", "provider unavailable");
    expect(a).not.toBe(b);
  });

  it("collapses whitespace and case, so a reworded-but-identical model turn does not look new", () => {
    const a = normalizeFailureText("model_error", "Model   Timed  Out");
    const b = normalizeFailureText("model_error", "model timed out");
    expect(a).toBe(b);
  });

  it("is bounded in length regardless of how long the message is", () => {
    const huge = normalizeFailureText("model_error", "x".repeat(10_000));
    expect(huge.length).toBeLessThanOrEqual(500);
  });

  it("handles an absent message", () => {
    expect(normalizeFailureText("cancelled", undefined)).toBe("cancelled|");
  });
});

describe("R2 — computeAttemptConditionsHash / computeAttemptFingerprint", () => {
  it("is deterministic: identical conditions hash identically", () => {
    const one = computeAttemptConditionsHash(baseConditions());
    const two = computeAttemptConditionsHash(baseConditions());
    expect(one.conditionsHash).toBe(two.conditionsHash);
  });

  it("is order-independent over the input object's own keys", () => {
    const one = computeAttemptConditionsHash(baseConditions({ input: { a: 1, b: "x" } }));
    const two = computeAttemptConditionsHash(baseConditions({ input: { b: "x", a: 1 } }));
    expect(one.conditionsHash).toBe(two.conditionsHash);
  });

  it("changes when the input revision changes", () => {
    const one = computeAttemptConditionsHash(baseConditions({ input: { a: 1 } }));
    const two = computeAttemptConditionsHash(baseConditions({ input: { a: 2 } }));
    expect(one.conditionsHash).not.toBe(two.conditionsHash);
  });

  it("changes when the node definition revision changes (a relevant state revision)", () => {
    const one = computeAttemptConditionsHash(baseConditions({ nodeDefinitionRevision: "2026-01-01T00:00:00.000Z" }));
    const two = computeAttemptConditionsHash(baseConditions({ nodeDefinitionRevision: "2026-01-02T00:00:00.000Z" }));
    expect(one.conditionsHash).not.toBe(two.conditionsHash);
  });

  it("changes when capability availability changes, and reports the unknown sentinel when absent", () => {
    const unknown = computeAttemptConditionsHash(baseConditions({ capabilityAvailability: undefined }));
    expect(unknown.components.capabilityStateRevision).toBe(CAPABILITY_STATE_UNKNOWN);
    const known = computeAttemptConditionsHash(baseConditions({
      capabilityAvailability: { asset_search: { available: true, evidence: { capability: "asset_search" } } }
    }));
    expect(known.components.capabilityStateRevision).not.toBe(CAPABILITY_STATE_UNKNOWN);
    expect(unknown.conditionsHash).not.toBe(known.conditionsHash);
  });

  it("changes when the workflow or node id changes", () => {
    const one = computeAttemptConditionsHash(baseConditions({ nodeId: "input_triage" }));
    const two = computeAttemptConditionsHash(baseConditions({ nodeId: "draft_writer" }));
    expect(one.conditionsHash).not.toBe(two.conditionsHash);
  });

  it("computeAttemptFingerprint folds the normalized failure in on top of the conditions hash", () => {
    const one = computeAttemptFingerprint(baseConditions(), "model_error", "provider blip");
    const two = computeAttemptFingerprint(baseConditions(), "timeout", "provider blip");
    expect(one.conditionsHash).toBe(two.conditionsHash); // same conditions
    expect(one.fingerprint).not.toBe(two.fingerprint); // different outcome
  });
});

describe("R2 — recordTerminalFailure / checkNoProgress", () => {
  it("starts a fresh ledger entry at occurrences 1 when there is no prior entry", () => {
    const entry = recordTerminalFailure(undefined, baseConditions(), "max_turns_exceeded", "too many turns", "2026-01-01T00:00:00.000Z");
    expect(entry.occurrences).toBe(1);
    expect(entry.firstAttemptAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.lastAttemptAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("climbs occurrences and preserves firstAttemptAt when conditions repeat exactly", () => {
    const first = recordTerminalFailure(undefined, baseConditions(), "max_turns_exceeded", "too many turns", "2026-01-01T00:00:00.000Z");
    const second = recordTerminalFailure(first, baseConditions(), "max_turns_exceeded", "too many turns", "2026-01-02T00:00:00.000Z");
    expect(second.occurrences).toBe(2);
    expect(second.firstAttemptAt).toBe("2026-01-01T00:00:00.000Z");
    expect(second.lastAttemptAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("resets occurrences to 1 when conditions genuinely changed, even if the failure looks the same", () => {
    const first = recordTerminalFailure(undefined, baseConditions({ input: { a: 1 } }), "max_turns_exceeded", "too many turns", "2026-01-01T00:00:00.000Z");
    const second = recordTerminalFailure(first, baseConditions({ input: { a: 2 } }), "max_turns_exceeded", "too many turns", "2026-01-02T00:00:00.000Z");
    expect(second.occurrences).toBe(1);
    expect(second.firstAttemptAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("checkNoProgress allows a dispatch with no prior ledger entry", () => {
    expect(checkNoProgress(undefined, baseConditions())).toEqual({ blocked: false });
  });

  it("checkNoProgress blocks a dispatch whose conditions match the stored entry", () => {
    const entry = recordTerminalFailure(undefined, baseConditions(), "max_turns_exceeded", "too many turns", "2026-01-01T00:00:00.000Z");
    const result = checkNoProgress(entry, baseConditions());
    expect(result.blocked).toBe(true);
  });

  it("checkNoProgress allows a dispatch whose conditions differ from the stored entry", () => {
    const entry = recordTerminalFailure(undefined, baseConditions({ input: { a: 1 } }), "max_turns_exceeded", "too many turns", "2026-01-01T00:00:00.000Z");
    const result = checkNoProgress(entry, baseConditions({ input: { a: 2 } }));
    expect(result.blocked).toBe(false);
  });

  it("records an override justification on the ledger entry when supplied", () => {
    const entry = recordTerminalFailure(undefined, baseConditions(), "max_turns_exceeded", "too many turns", "2026-01-01T00:00:00.000Z", "operator rotated a credential");
    expect(entry.lastOverrideJustification).toBe("operator rotated a credential");
  });
});
