import { describe, expect, it } from "vitest";
import {
  approvalBlockage,
  blockageId,
  collectRunBlockages,
  isResolvable,
  runBudgetBlockage,
  toBlockage
} from "../../../src/agent/execution/blockage.js";

// blockage.v1 — the contract's whole promise is that the REMEDY the engine already computed reaches
// a human as data. These tests pin the two halves that promise rests on: the code -> remedies table
// (so a new surface never has to guess), and the deterministic id (so a card and a chat message
// offering the same raise cannot charge for it twice).

// The exact shape budgetGuard.ts/OpenAINodeRunner.ts return on a mid-loop budget trip.
const BUDGET_RESULT = {
  code: "budget_exceeded",
  message: 'Node "brand_imagery_writer" stopped before the model turn that would cross the node budget.',
  details: {
    nodeId: "brand_imagery_writer",
    budgetUsd: 0.25,
    ceiling: "node" as const,
    spentUsdEstimate: 0.42,
    prospectiveTurnUsd: 0.36,
    spentUsd: 0.42,
    nextTurnEstimateUsd: 0.36,
    suggestedBudgetUsd: 1.5,
    stage: "mid_loop"
  },
  operatorAction: "Raise brand_imagery_writer budget to $1.5 (this run or default) and retry the node."
};

describe("toBlockage — budget", () => {
  it("turns a sync-path budget trip into an attempt raise, a default raise and a cancel", () => {
    const blockage = toBlockage(BUDGET_RESULT, { node_id: "brand_imagery_writer", run_id: "node_run_1", surface: "sync" });

    expect(blockage.kind).toBe("budget");
    expect(blockage.contract).toBe("blockage.v1");
    // The engine's own suggestion, carried verbatim — never re-derived downstream, which is how the
    // card and the engine would drift apart by a rounding rule.
    expect(blockage.remedies.map((remedy) => [remedy.id, remedy.type, remedy.args?.scope, remedy.args?.budgetUsd])).toEqual([
      ["raise_budget_attempt", "raise_node_budget", "attempt", 1.5],
      ["raise_budget_default", "raise_node_budget", "default", 1.5],
      ["cancel", "cancel", undefined, undefined]
    ]);
    // "yes" in chat means exactly one thing, and it is the cheap reversible one.
    expect(blockage.remedies.filter((remedy) => remedy.default)).toHaveLength(1);
    expect(blockage.remedies.find((remedy) => remedy.default)?.id).toBe("raise_budget_attempt");
    expect(blockage.operator_action).toBe(BUDGET_RESULT.operatorAction);
    expect(isResolvable(blockage)).toBe(true);
  });

  it("offers the per-RUN override on a real conductor run, and never the attempt override", () => {
    // F4: a per-run override + retry_node addresses a real run. There is no such thing as a
    // "one-shot attempt" there — the node is retried, not re-called — so offering one would be a
    // button that cannot be honoured.
    const blockage = toBlockage(BUDGET_RESULT, { node_id: "brand_imagery_writer", run_id: "run_9", surface: "run" });
    expect(blockage.remedies.map((remedy) => remedy.id)).toEqual(["raise_budget_run", "raise_budget_default", "cancel"]);
    expect(blockage.remedies[0].args).toMatchObject({ scope: "run", budgetUsd: 1.5, runId: "run_9", nodeId: "brand_imagery_writer" });
  });

  it("treats pricingUnknown as a CONFIG gap, not a budget one — a raise would not help", () => {
    const blockage = toBlockage(
      { ...BUDGET_RESULT, details: { nodeId: "n", budgetUsd: 0.25, ceiling: "node", pricingUnknown: true, reason: "no listed rate" } },
      { node_id: "n", surface: "sync" }
    );
    expect(blockage.kind).toBe("config");
    expect(blockage.remedies.map((remedy) => remedy.type)).toEqual(["open_settings", "cancel"]);
  });

  it("still suggests a raise when an older record carries no suggestedBudgetUsd", () => {
    const blockage = toBlockage(
      { code: "budget_exceeded", message: "old record", details: { nodeId: "n", budgetUsd: 0.25, ceiling: "node" } },
      { node_id: "n", surface: "sync" }
    );
    expect(blockage.remedies[0].args?.budgetUsd).toBe(1);
  });
});

describe("toBlockage — the rest of the table", () => {
  it("maps an approval hold to approve/decline against the gate id", () => {
    const blockage = toBlockage(
      { code: "approval_required", message: "publish gate" },
      { node_id: "publish_executor", run_id: "run_9", gate_id: "editorial.publish", surface: "run" }
    );
    expect(blockage.kind).toBe("approval");
    expect(blockage.remedies.map((remedy) => remedy.type)).toEqual(["approve_gate", "decline_gate"]);
    expect(blockage.remedies[0].args).toMatchObject({ gateId: "editorial.publish", runId: "run_9" });
    expect(blockage.scope.gate_id).toBe("editorial.publish");
  });

  it("reports a tenant-policy hold without inventing an approval transport", () => {
    const blockage = toBlockage(
      {
        code: "tenant_verb_needs_approval",
        message: '"site_apply_theme" is set to "needs approval" for project "platform", so it was held before any transport — nothing was attempted.'
      },
      { node_id: "theme_bind", run_id: "run_9", surface: "run" }
    );
    expect(blockage.kind).toBe("approval");
    expect(blockage.details).toMatchObject({ projectId: "platform", verb: "site_apply_theme", transportAttempted: false, approvalTransportAvailable: false });
    expect(blockage.remedies.map((remedy) => remedy.type)).toEqual(["open_settings", "retry", "cancel"]);
    expect(blockage.remedies.some((remedy) => remedy.type === "approve_gate")).toBe(false);
  });

  it("routes a missing site scope to project configuration and retry, not approval", () => {
    const blockage = toBlockage(
      { code: "artifact_site_scope_missing", message: "Project zilberman declares no objectDialect.siteObjectId." },
      { node_id: "artifact_materializer", run_id: "run_z", surface: "run" }
    );
    expect(blockage.kind).toBe("config");
    expect(blockage.remedies.map((remedy) => remedy.type)).toEqual(["open_settings", "retry", "cancel"]);
    expect(blockage.remedies.some((remedy) => remedy.type === "approve_gate")).toBe(false);
  });

  it("doubles the limit that was actually hit", () => {
    const turns = toBlockage({ code: "max_turns_exceeded", message: "x", details: { maxTurns: 6, toolCallLimit: 3 } }, { node_id: "n", surface: "run" });
    expect(turns.kind).toBe("limit");
    expect(turns.remedies.map((remedy) => [remedy.id, remedy.args?.value])).toEqual([
      ["raise_max_turns", 12],
      ["raise_tool_call_limit", 6],
      ["retry", undefined],
      ["cancel", undefined]
    ]);
    const truncated = toBlockage({ code: "truncated", message: "x", details: { maxOutputTokens: 1500 } }, { node_id: "n", surface: "run" });
    expect(truncated.remedies[0].args).toMatchObject({ field: "maxOutputTokens", value: 3000 });
  });

  it("gives auth and config walls an honest link rather than a button that cannot work", () => {
    expect(toBlockage({ code: "driver_env_missing", message: "x" }, { node_id: "n", surface: "run" }).kind).toBe("auth");
    expect(toBlockage({ code: "mcp_endpoint_missing", message: "x" }, { node_id: "n", surface: "run" }).remedies[0].type).toBe("set_project_field");
  });

  it("marks a validation wall UNRESOLVABLE — D7's Blocked, not Needs-you", () => {
    const blockage = toBlockage({ code: "input_validation_failed", message: "x", details: { issues: ["/brief: required"] } }, { node_id: "n", surface: "sync" });
    expect(blockage.kind).toBe("validation");
    expect(isResolvable(blockage)).toBe(false);
  });

  it("falls back to retry/cancel for a code the table has never seen", () => {
    const blockage = toBlockage({ code: "some_future_code", message: "x" }, { node_id: "n", surface: "run" });
    expect(blockage.kind).toBe("other");
    expect(blockage.remedies.map((remedy) => remedy.type)).toEqual(["retry", "cancel"]);
  });
});

describe("blockage_id", () => {
  it("is deterministic for the same wall and different for a different attempt", () => {
    const a = blockageId({ runId: "r", nodeId: "n", code: "budget_exceeded", attempt: 1 });
    expect(a).toBe(blockageId({ runId: "r", nodeId: "n", code: "budget_exceeded", attempt: 1 }));
    expect(a).not.toBe(blockageId({ runId: "r", nodeId: "n", code: "budget_exceeded", attempt: 2 }));
    expect(a).not.toBe(blockageId({ runId: "r2", nodeId: "n", code: "budget_exceeded", attempt: 1 }));
    expect(a.startsWith("blk_")).toBe(true);
  });
});

describe("collectRunBlockages", () => {
  it("reports the stopped node, the run ceiling and each pending gate, once each", () => {
    const nodeBlockage = toBlockage(BUDGET_RESULT, { node_id: "article_body", run_id: "run_9", surface: "run" });
    const blockages = collectRunBlockages({
      runId: "run_9",
      nodes: [
        { nodeId: "input_triage", status: "completed" },
        { nodeId: "article_body", status: "failed", blockage: nodeBlockage }
      ],
      budgetBlock: { blockedAt: "2026-09-07T00:00:00.000Z", budgetUsd: 3, spentUsdEstimate: 3.1, nextNodeId: "publish_payload", reason: "run ceiling reached" },
      // `pending: true` is what a GENUINE hold looks like; an entry without it
      // is the advisory record an autonomous publish leaves behind (see below).
      approvalsRequired: [{ nodeId: "publish_executor", reason: "publish gate", gateId: "editorial.publish", pending: true }]
    });
    expect(blockages.map((blockage) => [blockage.code, blockage.kind])).toEqual([
      ["budget_exceeded", "budget"],
      ["run_budget_block", "budget"],
      ["approval_required", "approval"]
    ]);
    // The run ceiling has no engine setter yet (§4) — the remedy is emitted anyway so the card can
    // say so honestly instead of the run appearing as an unexplained "blocked" with nothing on it.
    expect(blockages[1].remedies.map((remedy) => remedy.type)).toEqual(["raise_run_budget", "resume", "cancel"]);
  });

  it("ignores a stale blockage on a node that has since completed", () => {
    const stale = toBlockage(BUDGET_RESULT, { node_id: "article_body", run_id: "run_9", surface: "run" });
    expect(collectRunBlockages({ runId: "run_9", nodes: [{ nodeId: "article_body", status: "completed", blockage: stale }] })).toEqual([]);
  });

  it("does not report the same gate twice when the node state and the run both carry it", () => {
    const gate = approvalBlockage("run_9", { nodeId: "publish_executor", reason: "publish gate", gateId: "editorial.publish" });
    const blockages = collectRunBlockages({
      runId: "run_9",
      nodes: [{ nodeId: "publish_executor", status: "blocked", blockage: gate }],
      approvalsRequired: [{ nodeId: "publish_executor", reason: "publish gate", gateId: "editorial.publish", pending: true }]
    });
    expect(blockages).toHaveLength(1);
  });

  it("mints a run-budget remedy sized above what the run already spent", () => {
    const blockage = runBudgetBlockage("run_9", { blockedAt: "t", budgetUsd: 3, spentUsdEstimate: 3.1, reason: "r" });
    expect(blockage.remedies[0].args?.budgetUsd).toBe(5);
  });
});

// ─── W5.1 review fixes ───────────────────────────────────────────────────────

describe("collectRunBlockages — what is NOT a wall", () => {
  it("ignores the ADVISORY approval record an autonomous publish leaves behind", () => {
    // The executor stamps one of these on every publish-risk node that proceeded
    // under an autonomous policy, and it omits `pending` entirely — its own
    // reason string says "Advisory only — nothing is held". Read as pending, it
    // put an Approve/Decline pair on every finished, successful run and pinned
    // the Needs-you count forever.
    const blockages = collectRunBlockages({
      runId: "run_9",
      status: "completed",
      nodes: [{ nodeId: "publish_executor", status: "completed" }],
      approvalsRequired: [{ nodeId: "publish_executor", reason: "Proceeded autonomously. Advisory only — nothing is held." }]
    });
    expect(blockages).toEqual([]);
  });

  it("still reports a GENUINE hold", () => {
    const blockages = collectRunBlockages({
      runId: "run_9",
      nodes: [{ nodeId: "publish_executor", status: "blocked" }],
      approvalsRequired: [{ nodeId: "publish_executor", reason: "held", gateId: "editorial.publish", pending: true }]
    });
    expect(blockages.map((blockage) => blockage.code)).toEqual(["approval_required"]);
  });

  it("keeps an attempted legacy publish hold whose pending flag predates the current shape", () => {
    const blockages = collectRunBlockages({
      runId: "run_legacy",
      status: "blocked",
      nodes: [{ nodeId: "publish_executor", status: "blocked" }],
      approvalsRequired: [{ nodeId: "publish_executor", reason: "explicit approval required", gateId: "editorial.publish" }]
    });
    expect(blockages.map((blockage) => blockage.code)).toEqual(["approval_required"]);
  });

  it("derives the historical Zilberman missing-scope wall from the recorded deterministic output", () => {
    const blockages = collectRunBlockages({
      runId: "run_z",
      status: "blocked",
      nodes: [{
        nodeId: "artifact_materializer",
        status: "blocked",
        output: { error: { code: "artifact_site_scope_missing", message: "Project zilberman declares no objectDialect.siteObjectId." } },
        warnings: ["artifact_materializer_deterministic_unavailable:artifact_site_scope_missing"]
      }],
      approvalsRequired: []
    });
    expect(blockages).toHaveLength(1);
    expect(blockages[0]).toMatchObject({ code: "artifact_site_scope_missing", kind: "config", scope: { node_id: "artifact_materializer" } });
    expect(blockages[0].remedies.some((remedy) => remedy.type === "approve_gate")).toBe(false);
  });

  it("preserves an unknown legacy blocker as unknown instead of manufacturing approval", () => {
    const blockages = collectRunBlockages({
      runId: "run_unknown",
      status: "blocked",
      nodes: [{ nodeId: "mystery", status: "blocked" }],
      approvalsRequired: []
    });
    expect(blockages).toHaveLength(1);
    expect(blockages[0].code).toBe("legacy_blocker_unknown");
    expect(blockages[0].kind).toBe("other");
  });

  it("reports one gate once even when the node has been retried (its attempt has moved)", () => {
    // The node blockage is minted with the node's attempt; the run-level one has
    // none and defaults to 1, so the two ids only collide on the first attempt.
    // Approving one used to leave the other pending forever.
    const nodeGate = toBlockage(
      { code: "approval_required", message: "held" },
      { node_id: "publish_executor", run_id: "run_9", gate_id: "editorial.publish", surface: "run", attempt: 3 }
    );
    const blockages = collectRunBlockages({
      runId: "run_9",
      nodes: [{ nodeId: "publish_executor", status: "blocked", blockage: nodeGate }],
      approvalsRequired: [{ nodeId: "publish_executor", reason: "held", gateId: "editorial.publish", pending: true }]
    });
    expect(blockages).toHaveLength(1);
    expect(blockages[0].blockage_id).toBe(nodeGate.blockage_id);
  });
});

describe("toBlockage — the codes the engine actually writes", () => {
  it("classifies the PREFIXED credential codes, which never arrive bare", () => {
    // driverEnvPreflight writes `driver_auth_failed:<ENV_VAR>` — an equality
    // case for the bare token could never match, so every credential failure
    // used to fall through to a "Try again" button that cannot possibly help.
    for (const code of ["driver_env_missing:DRLURIE_MCP_TOKEN", "driver_auth_failed:DRLURIE_MCP_TOKEN", "client_auth_failed:X"]) {
      const blockage = toBlockage({ code, message: "no credential" }, { node_id: "n", surface: "run" });
      expect(blockage.kind).toBe("auth");
      expect(blockage.remedies[0].type).toBe("open_settings");
    }
    expect(toBlockage({ code: "driver_auth_failed:DRLURIE_MCP_TOKEN", message: "x" }, { node_id: "n", surface: "run" }).details?.envVar).toBe("DRLURIE_MCP_TOKEN");
  });

  it("does not offer to RESUME a node someone deliberately cancelled", () => {
    const blockage = toBlockage({ code: "cancelled", message: "cancelled by operator" }, { node_id: "n", run_id: "r", surface: "run" });
    expect(blockage.remedies.map((remedy) => remedy.type)).toEqual(["retry", "cancel"]);
    expect(blockage.remedies.some((remedy) => remedy.default)).toBe(false);
  });
});

describe("runBudgetBlockage — a record written before spentUsdEstimate existed", () => {
  it("says what it knows instead of $undefined and a $null button", () => {
    const blockage = runBudgetBlockage("run_3", { blockedAt: "t", budgetUsd: 3, reason: "r" } as never);
    expect(blockage.message).not.toContain("undefined");
    expect(blockage.message).not.toContain("NaN");
    expect(blockage.remedies[0].args?.budgetUsd).toBe(4.5);
  });
});
