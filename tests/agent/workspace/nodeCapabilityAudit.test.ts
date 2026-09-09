import { describe, expect, it } from "vitest";
import { auditNodeCapabilities, summarizeCapabilityAudit } from "../../../src/agent/workspace/nodeCapabilityAudit.js";
import { ROUTE_MANIFESTS } from "../../../src/agent/workspace/routeRegistry.js";
import { __test__ } from "../../../src/agent/workspace/executor.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// ACCEPTANCE — W3.1 (static-guesses brief §5, 2026-09-09).
//
// Two unrelated things are called "tool". A node's `allowedTools` names CONTROLLED REGISTRY tools,
// which a model turn reaches through a policy check, a risk check and the tool execution ledger. A
// DETERMINISTIC route reaches TENANT MCP VERBS through ProjectMcpAdapter directly — no grant, no risk
// check, no ledger. This audit is what makes the gap answerable from the workspace surface instead of
// from a document.
//
// Read-only by construction: nothing in this wave routes a call differently or blocks one.

const node = (over: Partial<WorkspaceNode>): WorkspaceNode => ({
  id: "n", name: "n", kind: "executor", description: "", prompt: "",
  inputSchema: {}, outputSchema: {}, allowedTools: [], produces: [], dependsOn: [],
  ...over
} as unknown as WorkspaceNode);

describe("W3.1 — a deterministic node's grants can never fire, and the audit says so", () => {
  it("moves a deterministic node's grants to deadGrants and names the finding", () => {
    const audit = auditNodeCapabilities(node({
      id: "capture_crawl",
      metadata: { captureStageDeterministic: "crawl" },
      allowedTools: ["capture.crawl", "stage.get_output", "stage.list_outputs"]
    }));
    expect(audit.executionKind).toBe("deterministic");
    expect(audit.routeId).toBe("capture_stage");
    expect(audit.modelGrants).toEqual([]);
    expect(audit.deadGrants).toEqual(["capture.crawl", "stage.get_output", "stage.list_outputs"]);
    expect(audit.findings.map((finding) => finding.code)).toContain("grants_never_fire");
  });

  it("leaves a model node's grants live", () => {
    const audit = auditNodeCapabilities(node({ id: "article_body", allowedTools: ["project.call_tool"] }));
    expect(audit.executionKind).toBe("model");
    expect(audit.modelGrants).toEqual(["project.call_tool"]);
    expect(audit.deadGrants).toEqual([]);
    expect(audit.findings).toEqual([]);
  });
});

describe("W3.1 — the tenant verbs a route reaches without any grant", () => {
  // The sharpest case in the audit, and the reason this file exists: riskLevel `admin`,
  // allowedTools: [], six tenant verbs — one of which restyles the entire site.
  it("reports visual_standard_materializer's six engine verbs against its empty grant list", () => {
    const audit = auditNodeCapabilities(node({
      id: "visual_standard_materializer",
      riskLevel: "admin",
      metadata: { visualStandardMaterializerDeterministic: true },
      allowedTools: []
    }));
    expect(audit.deadGrants).toEqual([]);
    expect(audit.engineRequiredTools.map((tool) => tool.verb)).toEqual([
      "object_create", "object_checkout", "object_patch", "object_checkin", "object_get", "site_apply_brand_imagery"
    ]);
    const highRisk = audit.findings.find((finding) => finding.code === "high_risk_engine_verb");
    expect(highRisk).toBeDefined();
    expect((highRisk as { verbs: string[] }).verbs).toEqual(["site_apply_brand_imagery"]);
    expect(highRisk!.detail).toContain("while declaring no tools at all");
  });

  it("names release_to_production as the publish-risk verb release_executor reaches", () => {
    const audit = auditNodeCapabilities(node({
      id: "release_executor",
      riskLevel: "publish",
      metadata: { releaseExecutorDeterministic: true },
      allowedTools: ["project.call_tool"]
    }));
    expect((audit.findings.find((finding) => finding.code === "high_risk_engine_verb") as { verbs: string[] }).verbs).toEqual(["release_to_production"]);
  });

  // THE REGRESSION THE PER-STAGE MODEL EXISTS FOR. capture and clone are one stage per dispatch and
  // their stages are not alike. A route-level verb list would report clone_intake — which only reads —
  // as reaching site_apply_theme, an admin verb that restyles the whole site. An audit that overstates
  // what a node can do is not a safer audit; it is a wrong one, and it trains its reader to ignore it.
  it("attributes a staged route's verbs to the STAGE, not to every node on the route", () => {
    const intake = auditNodeCapabilities(node({ id: "clone_intake", metadata: { cloneStageDeterministic: "intake" }, allowedTools: ["clone.intake"] }));
    const themeBind = auditNodeCapabilities(node({ id: "theme_bind", metadata: { cloneStageDeterministic: "theme_bind" }, allowedTools: ["clone.theme_bind"] }));

    expect(intake.engineRequiredTools.map((tool) => tool.verb)).toEqual(["object_get", "object_inventory", "registry_get"]);
    expect(intake.findings.map((finding) => finding.code)).not.toContain("high_risk_engine_verb");
    expect(themeBind.engineRequiredTools.map((tool) => tool.verb)).toContain("site_apply_theme");
    expect(themeBind.findings.map((finding) => finding.code)).toContain("high_risk_engine_verb");
  });

  // "We did not establish this" and "this calls nothing" must not read the same. capture_emit_live
  // certainly reaches the tenant — it creates objects and ingests every asset on the target site —
  // and an empty list would have asserted the opposite.
  it("says so when a stage's verbs are not attributed, rather than reporting none", () => {
    const emitLive = auditNodeCapabilities(node({ id: "capture_emit_live", metadata: { captureStageDeterministic: "emit_live" } }));
    expect(emitLive.engineToolsUnverified).toBe(true);
    expect(emitLive.engineRequiredTools).toEqual([]);
    expect(emitLive.findings.map((finding) => finding.code)).toContain("engine_tenant_calls_unlisted");
    expect(emitLive.findings.find((finding) => finding.code === "engine_tenant_calls_unlisted")!.detail).toContain("not yet attributed");

    // ...and a stage that genuinely calls nothing says THAT, with no finding at all.
    const map = auditNodeCapabilities(node({ id: "capture_map", metadata: { captureStageDeterministic: "map" } }));
    expect(map.engineToolsUnverified).toBeUndefined();
    expect(map.engineRequiredTools).toEqual([]);
    expect(map.findings).toEqual([]);
  });

  it("a model node reaches nothing from engine code", () => {
    expect(auditNodeCapabilities(node({ id: "draft_writer" })).engineRequiredTools).toEqual([]);
  });

  it("every declared tenant verb carries a risk, so nothing is audited as risk-unknown", () => {
    for (const manifest of ROUTE_MANIFESTS) {
      for (const tool of manifest.requiredTools ?? []) {
        expect(["read", "write", "publish", "admin"], `${manifest.id}:${tool.verb}`).toContain(tool.risk);
        expect(tool.description.length, `${manifest.id}:${tool.verb}`).toBeGreaterThan(0);
      }
    }
  });
});

// The whole-graph numbers, taken from the REAL node set rather than fixtures. These are the figures
// §5 asserted in prose; pinning them here means the next person to widen the hole fails a test rather
// than writing another brief about it.
describe("W3.1 — the audit over the live graph", () => {
  it("counts the deterministic nodes whose grants cannot fire, across every conductor workflow", async () => {
    const seen = new Map<string, WorkspaceNode>();
    for (const workflowId of ["publishing_conductor", "capture_conductor", "clone_conductor", "visual_identity"]) {
      for (const resolved of await __test__.resolveConductorNodes(undefined, workflowId)) {
        if (!seen.has(resolved.id)) seen.set(resolved.id, resolved);
      }
    }
    const summary = summarizeCapabilityAudit([...seen.values()]);

    expect(summary.nodeCount).toBe(51);
    expect(summary.deterministicNodes).toBe(23);
    expect(summary.modelNodes).toBe(28);
    // 22 of the 23 carry grants; visual_standard_materializer is the one that declares none.
    expect(summary.nodesWithDeadGrants).toBe(22);
    expect(summary.deadGrantCount).toBeGreaterThan(60);
    // Every node that reaches a publish- or admin-risk tenant verb from engine code, by name.
    expect(summary.nodesReachingHighRiskVerbs).toEqual(["release_executor", "theme_bind", "visual_standard_materializer"]);
  });
});
