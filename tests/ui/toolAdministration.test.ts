import { describe, expect, it } from "vitest";
import {
  buildDriftRows,
  buildRegistryRows,
  buildUsedByRows,
  summarizeDrift,
  summarizeRegistryRows,
  usedByEmptyReason
} from "../../ui/src/toolAdministration.js";

// ACCEPTANCE (model half) — W4.2. The decisions the tool-administration surface renders, tested
// where they live rather than through the DOM: pure logic in a framework-free module, the discipline
// nodeInspector.ts already follows and the reason a `.tsx` file root tests do not cover still has its
// judgements covered.

describe("W4.2 — registry reachability", () => {
  const tools = [
    { toolId: "capture.crawl", name: "capture.crawl", category: "capture", riskLevel: "write", reachability: { grantedBy: ["capture_crawl"], reachableFrom: [], dead: true } },
    { toolId: "stage.get_output", name: "stage.get_output", category: "workspace", riskLevel: "read", reachability: { grantedBy: ["article_body"], reachableFrom: ["article_body"], dead: false } },
    { toolId: "files.read", name: "files.read", category: "files", riskLevel: "read", reachability: { grantedBy: [], reachableFrom: [], dead: false } }
  ];

  // THE DISTINCTION THE WHOLE COLUMN EXISTS FOR, and the one the original brief got wrong: "granted
  // but nothing can call it" is a finding; "granted by nobody" is not. The second set is legitimately
  // reached from the improvement judge, admin chat and tool.test — none of which is a conductor node
  // — so reporting it as dead would be an accusation the data does not support.
  it("separates a dead grant from a tool no conductor node grants", () => {
    const rows = buildRegistryRows(tools);
    const byId = new Map(rows.map((row) => [row.toolId, row]));
    expect(byId.get("capture.crawl")!.dead).toBe(true);
    expect(byId.get("capture.crawl")!.ungranted).toBe(false);
    expect(byId.get("files.read")!.dead).toBe(false);
    expect(byId.get("files.read")!.ungranted).toBe(true);
  });

  it("counts each state separately so a summary cannot blur the two", () => {
    expect(summarizeRegistryRows(buildRegistryRows(tools))).toEqual({ total: 3, dead: 1, ungranted: 1, live: 1 });
  });

  it("derives reachability when the server sent none, rather than defaulting to alarming", () => {
    const [row] = buildRegistryRows([{ toolId: "x", name: "x" }]);
    expect(row.dead).toBe(false);
    expect(row.ungranted).toBe(true);
    expect(row.riskLevel).toBe("read");
  });
});

describe("W4.2 — who has reached a tenant", () => {
  it("marks a node that reached the tenant from engine code, past every grant and risk check", () => {
    const rows = buildUsedByRows({
      sampledCalls: 3, sampleLimit: 500,
      nodes: [
        { nodeId: "publish_executor", calls: 2, callers: ["engine"], routeIds: [], verbs: ["object_publish"], lastAt: "2026-09-09T10:00:00.000Z" },
        { nodeId: "article_body", calls: 1, callers: ["model"], routeIds: [], verbs: ["object_get"], lastAt: null }
      ]
    });
    expect(rows.find((row) => row.nodeId === "publish_executor")!.engineReached).toBe(true);
    expect(rows.find((row) => row.nodeId === "article_body")!.engineReached).toBe(false);
  });

  // An empty ledger is a real and common state — the ledger is new — and rendering it as "nothing
  // uses this tenant" would be a false statement on the page an operator uses to decide what to
  // block. It says which of the two it means.
  it("distinguishes an empty ledger from an unreadable one, and neither from 'nothing uses this'", () => {
    expect(usedByEmptyReason({ sampledCalls: 0, sampleLimit: 500, nodes: [] })).toContain("not that nothing uses this project");
    expect(usedByEmptyReason(null)).toContain("could not be read");
    expect(usedByEmptyReason({ sampledCalls: 1, sampleLimit: 500, nodes: [{ nodeId: "n", calls: 1, callers: ["model"], routeIds: [], verbs: ["object_get"], lastAt: null }] })).toBeNull();
  });
});

describe("W4.2 — capability drift", () => {
  const audits = [
    {
      nodeId: "capture_crawl", executionKind: "deterministic" as const, deadGrants: ["capture.crawl"], engineRequiredTools: [],
      findings: [{ code: "grants_never_fire", detail: "…", grants: ["capture.crawl"] }]
    },
    {
      nodeId: "visual_standard_materializer", executionKind: "deterministic" as const, deadGrants: [], engineRequiredTools: [],
      findings: [
        { code: "engine_tenant_calls_unlisted", detail: "…", verbs: ["object_create"] },
        { code: "high_risk_engine_verb", detail: "…", verbs: ["site_apply_brand_imagery"] }
      ]
    }
  ];

  // Severity is by CODE, not by count: one admin-risk verb reached past every check outranks twenty
  // dead grants, which are untidy rather than dangerous. A list sorted by volume would bury it.
  it("sorts the dangerous finding above the untidy ones", () => {
    const rows = buildDriftRows(audits);
    expect(rows[0].code).toBe("high_risk_engine_verb");
    expect(rows[0].severity).toBe("high");
    expect(rows.slice(1).every((row) => row.severity === "medium")).toBe(true);
  });

  it("summarizes by node and by severity, not by raw count alone", () => {
    expect(summarizeDrift(buildDriftRows(audits))).toEqual({
      total: 3, high: 1, nodes: ["capture_crawl", "visual_standard_materializer"]
    });
  });

  it("reports no drift as no drift, rather than as an unread state", () => {
    expect(buildDriftRows([])).toEqual([]);
    expect(buildDriftRows(null)).toEqual([]);
  });
});
