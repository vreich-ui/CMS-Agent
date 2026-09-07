import { describe, expect, it } from "vitest";
import { executeTool } from "../../../src/agent/tools/toolExecutor.js";
import { FORBIDDEN_PROJECT_VERBS, PROJECT_VERB_AUTHORIZED_NODE_IDS } from "../../../src/agent/tools/forbiddenProjectVerbs.js";

// K-A10 — canonical publishing_conductor grants project.call_tool to contract_intelligence,
// artifact_materializer, article_body and publish_payload, all riskLevel "write". article_body is a
// model turn. Nothing verb-level stopped its model from naming object_publish in the arguments: the
// publish-risk dispatch gate only covers publish/admin nodes, and composeWorkflowNodes' structural
// refusal only inspects controlled tool ids in allowedTools, never a call's arguments.
const BUILDER_NODES = ["contract_intelligence", "article_body", "artifact_materializer", "publish_payload"];
const call = (nodeId: string, tool: string) =>
  executeTool("project.call_tool", { projectId: "dr-lurie", tool, arguments: {} }, { runId: "run-verb-denylist", nodeId, projectId: "dr-lurie", maxRiskLevel: "write" }) as Promise<any>;

describe("project.call_tool verb denylist on the node path", () => {
  it("refuses every forbidden verb for every builder node, before any transport", async () => {
    for (const nodeId of BUILDER_NODES) {
      for (const verb of FORBIDDEN_PROJECT_VERBS) {
        const result = await call(nodeId, verb);
        expect(result.ok, `${nodeId} must not be able to call ${verb}`).toBe(false);
        expect(JSON.stringify(result)).toContain("publish_verb_not_permitted");
      }
    }
  });

  it("names the node and the verb in the refusal so the failure is legible in the run record", async () => {
    const result = await call("article_body", "object_publish");
    expect(JSON.stringify(result)).toContain("article_body");
    expect(JSON.stringify(result)).toContain("object_publish");
  });

  it("does not refuse a verb that is not on the list", async () => {
    const result = await call("article_body", "object_get");
    expect(JSON.stringify(result)).not.toContain("publish_verb_not_permitted");
  });

  it("exempts exactly the two nodes whose purpose is the verb", () => {
    expect([...PROJECT_VERB_AUTHORIZED_NODE_IDS].sort()).toEqual(["publish_executor", "release_executor"]);
  });
});
