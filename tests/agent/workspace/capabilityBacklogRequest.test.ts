import { describe, expect, it } from "vitest";
import { buildCapabilityRequests } from "../../../src/agent/workspace/capabilityBacklogRequest.js";

// T15.33 (#209; ADR-2026-08-25-structure-studio §6.3) — the capability-backlog loop's structured
// request: steps 1 ("the unmet need recorded with evidence") and 2 ("a structured capability request
// naming the proposed section type, its fields, and the evidence") of the ADR's four-step loop.

const backlog = () => ({
  booking_widget: [
    { sectionType: "booking_widget", pageRef: "page_home", why: "no registered type performs live availability booking", proposedFields: ["serviceId", "date", "slots[]"] },
    { sectionType: "booking_widget", pageRef: "page_services", why: "same gap on the services page", proposedFields: ["serviceId", "cta"] }
  ],
  pricing_table: [
    { sectionType: "pricing_table", pageRef: "page_pricing", why: "tiered pricing has no registered shape" }
  ]
});

describe("buildCapabilityRequests", () => {
  it("groups by section type, sorted alphabetically", () => {
    const requests = buildCapabilityRequests(backlog());
    expect(requests.map((r) => r.sectionType)).toEqual(["booking_widget", "pricing_table"]);
  });

  it("records one evidence row per occurrence, with pageRef and why", () => {
    const requests = buildCapabilityRequests(backlog(), { sourceUrl: "https://example.com/", runId: "run_1" });
    const booking = requests.find((r) => r.sectionType === "booking_widget")!;
    expect(booking.occurrences).toBe(2);
    expect(booking.evidence).toEqual([
      { pageRef: "page_home", why: "no registered type performs live availability booking", sourceUrl: "https://example.com/", runId: "run_1" },
      { pageRef: "page_services", why: "same gap on the services page", sourceUrl: "https://example.com/", runId: "run_1" }
    ]);
  });

  it("unions and alphabetizes proposedFields across occurrences, deduplicated", () => {
    const requests = buildCapabilityRequests(backlog());
    const booking = requests.find((r) => r.sectionType === "booking_widget")!;
    expect(booking.proposedFields).toEqual(["cta", "date", "serviceId", "slots[]"]);
  });

  it("an occurrence with no proposedFields contributes none — never fabricated", () => {
    const requests = buildCapabilityRequests(backlog());
    const pricing = requests.find((r) => r.sectionType === "pricing_table")!;
    expect(pricing.proposedFields).toEqual([]);
    expect(pricing.evidence).toEqual([{ pageRef: "page_pricing", why: "tiered pricing has no registered shape", sourceUrl: null, runId: null }]);
  });

  it("context sourceUrl/runId default to null when the caller states none — never a guessed value", () => {
    const requests = buildCapabilityRequests(backlog());
    for (const request of requests) for (const row of request.evidence) {
      expect(row.sourceUrl).toBeNull();
      expect(row.runId).toBeNull();
    }
  });

  it("falls back to `rationale` when `why` is absent (the mismatch-ledger shape)", () => {
    const requests = buildCapabilityRequests({ video_embed: [{ sectionType: "video_embed", rationale: "no video embed type exists" }] });
    expect(requests[0].evidence[0].why).toBe("no video embed type exists");
  });

  it("skips a malformed (non-object) entry without dropping the rest of the batch", () => {
    const requests = buildCapabilityRequests({ x: [null, "not an object", { sectionType: "x", pageRef: "p1" }] });
    expect(requests[0].occurrences).toBe(1);
    expect(requests[0].evidence).toEqual([{ pageRef: "p1", why: null, sourceUrl: null, runId: null }]);
  });

  it("an empty capabilityBacklog produces an empty (honest) result", () => {
    expect(buildCapabilityRequests({})).toEqual([]);
  });

  it("groups an 'unknown' key (an unmet need with no stated sectionType) like any other key", () => {
    const requests = buildCapabilityRequests({ unknown: [{ why: "shape unclear" }] });
    expect(requests).toEqual([{ sectionType: "unknown", occurrences: 1, proposedFields: [], evidence: [{ pageRef: null, why: "shape unclear", sourceUrl: null, runId: null }] }]);
  });

  it("is DETERMINISTIC: identical input always produces an identical (deep-equal) result", () => {
    const first = buildCapabilityRequests(backlog(), { sourceUrl: "https://example.com/", runId: "run_1" });
    const second = buildCapabilityRequests(backlog(), { sourceUrl: "https://example.com/", runId: "run_1" });
    expect(first).toEqual(second);
  });

  it("is a pure function of its input — never mutates the capabilityBacklog argument", () => {
    const input = backlog();
    const snapshot = JSON.parse(JSON.stringify(input));
    buildCapabilityRequests(input, { sourceUrl: "https://example.com/" });
    expect(input).toEqual(snapshot);
  });
});
