import { describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { FORBIDDEN_PROJECT_VERBS } from "../../../src/agent/tools/forbiddenProjectVerbs.js";
import { SITE_CLIENT_MANAGER_TOOLS } from "../../../src/agent/capture/siteGenesis.js";

// ACCEPTANCE — W3.2.3 (2026-09-09). The last ungated door to a publish verb.
//
// AGENTS.md invariant 4 has named this in prose since it was written: the publish gates cover
// publishRun and the dispatch of publish-risk nodes; they do not cover `project_call_tool` on the
// wire, which "reaches release_to_production with no gate at all". FORBIDDEN_PROJECT_VERBS has
// guarded the model path since K-A10 and guards the engine path as of W3.2.1. This surface was the
// one caller still outside it.
//
// WHO THIS AFFECTS, checked rather than assumed: `project_call_tool` is NOT in
// SITE_CLIENT_MANAGER_TOOLS, so no tenant's scoped chat bearer can reach it and no admin-chat
// publishing path changes. It is a full-bearer (operator) surface, and an operator's sanctioned route
// to a publish is workflow_publish_run — gates, authority and the durable operator decision — or a run
// whose publish_executor / release_executor dispatch reaches the verb.

const callTool = () => createWorkspaceTools({}).find((tool) => tool.name === "project.call_tool")!;

type CallResult = { data: { call: { ok: boolean; tool: string; permission?: string; error?: string } } };

describe("W3.2.3 — project_call_tool refuses the publish verbs", () => {
  it("refuses every forbidden verb, before any transport", async () => {
    for (const verb of FORBIDDEN_PROJECT_VERBS) {
      const result = await callTool().execute({ projectId: "dr-lurie", tool: verb, arguments: {} }) as CallResult;
      expect(result.data.call.ok, `${verb} must be refused`).toBe(false);
      expect(result.data.call.permission).toBe("blocked");
      expect(result.data.call.error, `${verb}'s refusal must name it`).toContain(verb);
      expect(result.data.call.error).toContain("publish_verb_not_permitted");
    }
  });

  it("names the sanctioned route instead of only saying no", async () => {
    const result = await callTool().execute({ projectId: "dr-lurie", tool: "object_publish", arguments: {} }) as CallResult;
    expect(result.data.call.error).toContain("workflow_publish_run");
  });

  // No caller on this surface is exempt, and that is deliberate rather than an oversight: the two
  // exempt node ids are DISPATCHED nodes inside a run, which have already passed the publish-risk
  // gate, the controller decision and the operator decision. A hand-made wire call has passed none.
  it("exempts nobody — there is no node behind a wire call to exempt", async () => {
    for (const nodeIdShaped of ["publish_executor", "release_executor"]) {
      const result = await callTool().execute({ projectId: "dr-lurie", tool: "object_publish", arguments: { node_id: nodeIdShaped } }) as CallResult;
      expect(result.data.call.ok).toBe(false);
    }
  });

  it("leaves every non-publish verb on this surface alone", async () => {
    // A read verb still reaches the adapter and fails on the connection (no endpoint configured in a
    // test process) rather than on the new rule — the distinction that proves the rule is narrow.
    const result = await callTool().execute({ projectId: "dr-lurie", tool: "object_get", arguments: { object_id: "x" } }) as CallResult;
    expect(result.data.call.error ?? "").not.toContain("publish_verb_not_permitted");
  });

  it("changes nothing for a tenant's scoped chat bearer, which cannot reach this tool at all", () => {
    expect([...SITE_CLIENT_MANAGER_TOOLS]).not.toContain("project_call_tool");
  });
});
