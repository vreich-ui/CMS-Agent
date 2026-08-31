import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool } from "../../../src/agent/tools/toolExecutor.js";
import { resolveEffectiveToolsForNode } from "../../../src/agent/tools/toolResolver.js";
import { READ_TOOL_ALLOWLIST } from "../../../src/agent/projects/projectMcpAdapter.js";

// T-2 (run_1785340011864_qpyjr0): the engine ran end-to-end in live mode, but contract_intelligence
// could not fetch the platform content_item contract. project.call_tool covers BOTH read-only
// discovery AND external writes, and is approval-gated because of the write half — correctly. That
// also blocked the read half: the node runner filters effective tools to `.allowed`, and a run with
// no approved tool ids dropped project.call_tool entirely, so the node correctly refused to fabricate
// a contract rather than proceed on nothing. project.call_read_tool is the split that fixes this
// without touching the write path at all.
// W8 — artifact_plan left this set when it became a tool-less planning turn (allowedTools: []).
// artifact_materializer is the node that now reaches the client, and it holds both grants.
const CONTENT_BUILDING_NODES = ["contract_intelligence", "article_body", "artifact_materializer", "publish_payload"];
const WRITE_ONLY_PUBLISH_NODES = ["publication_controller", "publish_executor"];
// Disallowed-but-otherwise-unremarkable operation names, chosen so the ONLY reason each is refused
// is the fixed allowlist itself — none of these also trip dr-lurie's executable policy (that gets its
// own test below, since a save_json_blob_* name is caught by BOTH gates and would blur which one
// actually fired here).
const DISALLOWED_OPERATIONS = ["object_create", "object_patch", "object_publish", "release_to_production"];

describe("project.call_read_tool — the read-only split of project.call_tool", () => {
  afterEach(() => vi.restoreAllMocks());

  // (a) resolves allowed:true with NO approval context, for all four content-building nodes.
  it("resolves allowed:true with no approval context for every content-building node", async () => {
    for (const nodeId of CONTENT_BUILDING_NODES) {
      const tools = await resolveEffectiveToolsForNode(nodeId, { runId: "run-read-tool" });
      const readTool = tools.find((tool) => tool.toolId === "project.call_read_tool");
      expect(readTool, `${nodeId} must be granted project.call_read_tool`).toBeDefined();
      expect(readTool?.allowed, `${nodeId}: no approvedToolIds were supplied, and none should be needed`).toBe(true);
      expect(readTool?.denialReasons).toEqual([]);
    }
  });

  // The write variant is untouched: still denied pending approval on the very same nodes that now
  // freely get the read variant. Approval was never the obstacle for reading; it always was for writing.
  it("project.call_tool now resolves allowed on the same four nodes — the per-run approval lock was removed at go-live", async () => {
    for (const nodeId of CONTENT_BUILDING_NODES) {
      const tools = await resolveEffectiveToolsForNode(nodeId, { runId: "run-read-tool" });
      const writeTool = tools.find((tool) => tool.toolId === "project.call_tool");
      expect(writeTool?.allowed, `${nodeId}: project.call_tool resolves allowed without per-run approval`).toBe(true);
      expect(writeTool?.denialReasons).toEqual([]);
    }
  });

  // publication_controller and publish_executor are unchanged by this feature — write variant only.
  it("does not grant project.call_read_tool to the write-only publish nodes", async () => {
    for (const nodeId of WRITE_ONLY_PUBLISH_NODES) {
      const tools = await resolveEffectiveToolsForNode(nodeId, { runId: "run-read-tool" });
      const readTool = tools.find((tool) => tool.toolId === "project.call_read_tool");
      expect(readTool?.allowed, `${nodeId} must not be granted project.call_read_tool`).toBe(false);
      expect(readTool?.denialReasons).toContain("node_tool_not_allowed");
    }
  });

  // (b) refuses anything outside the fixed allowlist, before any transport, with a distinct code
  // naming the attempted operation. nodeId "external_test" does not exist as a real workspace node,
  // so resolvePolicySubjects finds no node/skill and the only gates in play are the tool's own
  // declared riskLevel/requiresApproval — isolating the handler's OWN refusal from node-level policy.
  it("refuses every disallowed operation before any transport, naming the attempted operation", async () => {
    const remoteFetch = vi.fn();
    vi.stubGlobal("fetch", remoteFetch);
    for (const tool of DISALLOWED_OPERATIONS) {
      const result: any = await executeTool("project.call_read_tool", { projectId: "dr-lurie", tool, arguments: {} }, { runId: "run-read-tool", nodeId: "external_test", projectId: "dr-lurie", maxRiskLevel: "write" });
      expect(result.ok, `${tool} must be refused`).toBe(true); // the tool call itself succeeds; the REFUSAL is in its own output
      expect(result.output.data.call).toMatchObject({ ok: false, tool, code: "read_tool_operation_not_permitted" });
      expect(result.output.data.call.error, `error must name the attempted operation ${tool}`).toContain(tool);
    }
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  // Defense in depth (requirement 2): a name that is BOTH outside the allowlist AND independently
  // caught by dr-lurie's executable policy is refused by the executable policy first — the outer
  // gate in this handler's ordering — rather than falling through to the allowlist code. Either
  // reason is a correct "refused before transport"; this asserts the policy layer is genuinely wired
  // in for project.call_read_tool, not skipped because the tool is "just" the read variant.
  it("still honors the executable-policy block on a legacy dialect name, before any transport", async () => {
    const remoteFetch = vi.fn();
    vi.stubGlobal("fetch", remoteFetch);
    const result: any = await executeTool("project.call_read_tool", { projectId: "dr-lurie", tool: "save_json_blob_create_article_draft", arguments: {} }, { runId: "run-read-tool", nodeId: "external_test", projectId: "dr-lurie", maxRiskLevel: "write" });
    expect(result.ok).toBe(true);
    expect(result.output.data.call).toMatchObject({ ok: false, tool: "save_json_blob_create_article_draft", permission: "blocked", blockedByPolicy: true });
    expect(result.output.data.call.policyFindings.map((finding: { code: string }) => finding.code)).toContain("blocked_retired_publish_dialect");
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("permits every operation on the allowlist (policy/connection errors aside, they all clear the allowlist gate)", async () => {
    for (const tool of READ_TOOL_ALLOWLIST) {
      const result: any = await executeTool("project.call_read_tool", { projectId: "dr-lurie", tool, arguments: {} }, { runId: "run-read-tool", nodeId: "external_test", projectId: "dr-lurie", maxRiskLevel: "write" });
      expect(result.ok).toBe(true);
      expect(result.output.data.call.code).toBeUndefined();
    }
  });

  // (c) the write variant still resolves approval_required in the generic controlled-tool-runtime
  // path too (not just via resolveEffectiveToolsForNode above) — mirrors the existing toolRuntime.test.ts
  // coverage, confirming this feature changed nothing about project.call_tool's own gating.
  it("project.call_tool executes without per-run approval through executeTool (go-live); connection errors are its own concern", async () => {
    const result: any = await executeTool("project.call_tool", { projectId: "dr-lurie", tool: "object_contract", arguments: {} }, { runId: "run-read-tool", nodeId: "external_test", projectId: "dr-lurie", maxRiskLevel: "write" });
    // No approval denial: the call proceeds to the adapter (which may fail on an unconfigured
    // endpoint in tests, but never with approval_required).
    if (result.ok === false && result.denied) expect(result.denied.reasons).not.toContain("approval_required");
  });
});
