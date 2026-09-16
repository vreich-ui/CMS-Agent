// ACCEPTANCE — W5 T5 (2026-09-16). `npm run nodes:apply` gains a model_config op.
//
// docs/plan/2026-09-budget-node-ops.md raises two node budget ceilings and, until this change, could
// not be applied by the one script that exists to apply node-ops docs: its own note said so and told
// the reader to run the calls by hand. Hand-run MCP calls are the undiffable, un-idempotent chore
// this script was written to end, and the alternative an operator reaches for instead — editing the
// node literals — puts the store and canonical out of sync, which is the drift store:check exists to
// catch.
//
// The op MERGES, because the verb does (workspace.update_node_model_config, deepMergeRecords in
// mcp/workspace/tools.ts). That single fact drives every assertion below: keys the patch omits
// survive, a re-run is a no-op, and the chain-drift rule that governs every replacing op cannot apply.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOpsDoc, planApply } from "../../../scripts/applyNodeOps.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

const BUDGET_DOC = fileURLToPath(new URL("../../../docs/plan/2026-09-budget-node-ops.md", import.meta.url));

const makeNode = (id: string, modelConfig?: Record<string, unknown>): WorkspaceNode => ({
  id, name: id, kind: "test", description: "", prompt: "p",
  inputSchema: { type: "object" }, outputSchema: { type: "object" },
  allowedTools: [], assignedSkills: [], requiredInputs: [], produces: [],
  riskLevel: "read", dependsOn: [], status: "active", position: { x: 0, y: 0 },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...(modelConfig ? { modelConfig } : {})
});

describe("W5 T5 — the budget doc parses", () => {
  it("lists its two ops, against the real file rather than a transcription of it", async () => {
    const ops = parseOpsDoc(await readFile(BUDGET_DOC, "utf8"));
    expect(ops.map((op) => [op.index, op.tool, op.nodeId, op.kind])).toEqual([
      [1, "workspace_update_node_model_config", "narrative_movement", "model_config"],
      [2, "workspace_update_node_model_config", "reader_simulation", "model_config"]
    ]);
    // The doc prints the WHOLE call argument, {"id", "patch": {"modelConfig"}} — the parser unwraps
    // it rather than storing `id` and `patch` as two junk modelConfig keys.
    expect(ops[0].modelConfigPatch).toEqual({ budgetUsd: 0.3 });
    expect(ops[1].modelConfigPatch).toEqual({ budgetUsd: 0.4 });
  });

  it("refuses a wrapper whose id contradicts its heading, like create_node already does", () => {
    const doc = "### 1. `workspace_update_node_model_config` — node `narrative_movement`\n\n```json\n{ \"id\": \"article_body\", \"patch\": { \"modelConfig\": { \"budgetUsd\": 1 } } }\n```\n";
    expect(() => parseOpsDoc(doc)).toThrow(/heading names node "narrative_movement"/);
  });

  it("also accepts the bare inner object, which the metadata ops one heading up are written as", () => {
    const doc = "### 1. `workspace_update_node_model_config` — node `narrative_movement`\n\n```json\n{ \"budgetUsd\": 0.3 }\n```\n";
    expect(parseOpsDoc(doc)[0].modelConfigPatch).toEqual({ budgetUsd: 0.3 });
  });
});

describe("W5 T5 — it plans a MERGE, not a replace", () => {
  const ops = () => parseOpsDoc(
    "### 1. `workspace_update_node_model_config` — node `narrative_movement`\n\n```json\n{ \"id\": \"narrative_movement\", \"patch\": { \"modelConfig\": { \"budgetUsd\": 0.3 } } }\n```\n"
  );

  it("preserves every key the patch omits — the whole reason the verb merges", () => {
    const plan = planApply(ops(), [makeNode("narrative_movement", { model: "gpt-x", maxOutputTokens: 3500, budgetUsd: 0.15 })]);
    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]).toMatchObject({ nodeId: "narrative_movement", field: "modelConfig", kind: "update" });
    expect(plan.writes[0].afterValue).toEqual({ model: "gpt-x", maxOutputTokens: 3500, budgetUsd: 0.3 });
  });

  it("merges nested objects key by key, and replaces anything that is not one", () => {
    const nested = parseOpsDoc(
      "### 1. `workspace_update_node_model_config` — node `n`\n\n```json\n{ \"limits\": { \"b\": 2 }, \"stops\": [\"x\"] }\n```\n"
    );
    const plan = planApply(nested, [makeNode("n", { limits: { a: 1, b: 1 }, stops: ["y", "z"] })]);
    expect(plan.writes[0].afterValue).toEqual({ limits: { a: 1, b: 2 }, stops: ["x"] });
  });

  it("is idempotent: a second run against an applied store reports up to date and writes nothing", () => {
    const plan = planApply(ops(), [makeNode("narrative_movement", { model: "gpt-x", budgetUsd: 0.3 })]);
    expect(plan.writes).toEqual([]);
    expect(plan.upToDate).toEqual([{ opIndex: 1, nodeId: "narrative_movement", field: "modelConfig" }]);
  });

  it("does NOT refuse a store whose other keys differ from the doc author's — a merge has no base to expect", () => {
    // The chain-drift rule that governs a replacing op would fire here, and it would be wrong: the
    // same patch applied to two different stores legitimately produces two different results.
    const plan = planApply(ops(), [makeNode("narrative_movement", { model: "something-else", timeout: 999 })]);
    expect(plan.refusals).toEqual([]);
    expect(plan.writes[0].afterValue).toEqual({ model: "something-else", timeout: 999, budgetUsd: 0.3 });
  });

  it("refuses an op for a node the store does not have, like every other update op", () => {
    const plan = planApply(ops(), [makeNode("someone_else")]);
    expect(plan.writes).toEqual([]);
    expect(plan.refusals[0].reason).toContain("does not exist in the store");
  });

  it("handles a node with no modelConfig at all by creating one", () => {
    const plan = planApply(ops(), [makeNode("narrative_movement")]);
    expect(plan.writes[0].afterValue).toEqual({ budgetUsd: 0.3 });
  });
});

describe("W5 T5 — the real doc, planned against a real-shaped store", () => {
  it("plans exactly two writes and nothing else", async () => {
    const plan = planApply(parseOpsDoc(await readFile(BUDGET_DOC, "utf8")), [
      makeNode("narrative_movement", { model: "gpt-x", maxOutputTokens: 3500, budgetUsd: 0.15 }),
      makeNode("reader_simulation", { model: "gpt-x", budgetUsd: 0.2 }),
      makeNode("article_body", { budgetUsd: 1.125 })
    ]);
    expect(plan.refusals).toEqual([]);
    expect(plan.writes.map((write) => [write.nodeId, (write.afterValue as { budgetUsd: number }).budgetUsd]))
      .toEqual([["narrative_movement", 0.3], ["reader_simulation", 0.4]]);
    // article_body is deliberately not in the doc (its worst dispatch already fits twice inside its
    // ceiling), and nothing here invents an op for it.
    expect(plan.writes.some((write) => write.nodeId === "article_body")).toBe(false);
  });
});
