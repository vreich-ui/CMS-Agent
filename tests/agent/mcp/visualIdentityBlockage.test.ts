import { beforeEach, describe, expect, it } from "vitest";
import { resetRepositoryManager, repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { toolError } from "../../../src/agent/mcp/workspace/toolKit.js";
import { clampModelConfigOverride, createVisualIdentityTools, extractNodeProposal } from "../../../src/agent/mcp/workspace/visualIdentityTools.js";
import { toBlockage } from "../../../src/agent/execution/blockage.js";

// W1 / F3 — THE SCREENSHOT CASE. `visual_identity.propose` used to catch a failed writer run and
// string-join its errors into
//   "visual_identity_no_proposal: brand_imagery_writer returned no proposal: node run failed:
//    budget_exceeded; Node …"
// which is what the Imagery tab rendered under a red X: a sentence naming a remedy nobody could
// click. These tests pin the two things that changed — the blockage rides out on the wire envelope
// as DATA, and the tool accepts the one-shot raise that resolving it re-calls with.

const BLOCKAGE = toBlockage(
  {
    code: "budget_exceeded",
    message: 'Node "brand_imagery_writer" stopped before the model turn that would cross the node ceiling.',
    details: { nodeId: "brand_imagery_writer", budgetUsd: 0.25, ceiling: "node", spentUsdEstimate: 0.42, prospectiveTurnUsd: 0.36, suggestedBudgetUsd: 1.5 },
    operatorAction: "Raise brand_imagery_writer budget to $1.5 (this run or default) and retry the node."
  },
  { node_id: "brand_imagery_writer", run_id: "node_run_1", surface: "sync" }
);

/** What nodeRuntime.executeNode now returns for a node that hit its ceiling (nodeRuntimeBlockage.test.ts). */
const blockedRun = (nodeId: string) => ({
  executionId: "exec_1",
  execution: {
    runId: "node_run_1",
    status: "failed",
    nodes: [{ nodeId, status: "failed", errors: ["budget_exceeded", BLOCKAGE.message], output: { error: { code: "budget_exceeded", message: BLOCKAGE.message } }, blockage: BLOCKAGE }],
    stageOutputs: {},
    artifacts: [],
    errors: ["budget_exceeded", BLOCKAGE.message]
  }
});

const PROPOSAL = { artifact: "brand_imagery_proposal.v1", mode: "house", brandImagery: { version: 1 }, rationale: "r", confidence: "medium" };
const completedRun = (nodeId: string, output: unknown) => ({
  executionId: "exec_2",
  execution: { runId: "node_run_2", status: "completed", nodes: [{ nodeId, status: "completed", output }], stageOutputs: { [nodeId]: output }, artifacts: [], errors: [] }
});

const houseArgs = { project_id: "dr-lurie", mode: "house", brief: "Evidence-led skin health." };

const proposeWith = (impl: (data: { nodeId: string; modelConfig?: Record<string, unknown> }) => unknown) => {
  const calls: Array<{ nodeId: string; modelConfig?: Record<string, unknown> }> = [];
  const [definition] = createVisualIdentityTools({
    workspaceRepository: repositoryManager.getWorkspaceRepository(),
    executionRepository: repositoryManager.getExecutionRepository(),
    projectRepository: repositoryManager.getProjectRepository(),
    executeNodeImpl: (async (data: { nodeId: string; modelConfig?: Record<string, unknown> }) => {
      calls.push(data);
      return impl(data) as never;
    }) as never
  });
  return { definition, calls };
};

describe("extractNodeProposal", () => {
  it("returns the blockage instead of the failure prose", () => {
    const extracted = extractNodeProposal(blockedRun("brand_imagery_writer"), "brand_imagery_writer");
    expect(extracted.ok).toBe(false);
    expect((extracted as { blockage?: unknown }).blockage).toMatchObject({ kind: "budget", contract: "blockage.v1" });
  });

  it("never mistakes a failure's own error envelope for a proposal", () => {
    // nodeRuntime now writes `state.output = { error: … }` on the failure path (F2). A reader that
    // only checked `output !== undefined` would hand that envelope back as if it were the writer's
    // proposal — an error object rendered on an approval card.
    const run = blockedRun("brand_imagery_writer");
    (run.execution.nodes[0] as { blockage?: unknown }).blockage = undefined;
    const extracted = extractNodeProposal(run, "brand_imagery_writer");
    expect(extracted.ok).toBe(false);
  });

  it("still returns a real proposal unchanged", () => {
    expect(extractNodeProposal(completedRun("brand_imagery_writer", PROPOSAL), "brand_imagery_writer")).toEqual({ ok: true, proposal: PROPOSAL });
  });
});

describe("visual_identity.propose — blockage on the wire", () => {
  beforeEach(async () => {
    delete process.env.WORKSPACE_STORE;
    delete process.env.MCP_EXPOSED_TOOL_PREFIXES;
    resetRepositoryManager();
  });

  it("puts the remedy in error.blockage, where a card can read it as data", async () => {
    const { definition } = proposeWith(({ nodeId }) => blockedRun(nodeId));

    const envelope = await definition.execute(houseArgs).then(
      () => { throw new Error("expected a refusal"); },
      (error: unknown) => toolError(error)
    );

    expect(envelope.error.code).toBe("visual_identity_no_proposal");
    const blockage = envelope.error.blockage as typeof BLOCKAGE;
    expect(blockage.remedies[0].type).toBe("raise_node_budget");
    expect(blockage.remedies[0].args).toMatchObject({ scope: "attempt", budgetUsd: 1.5 });
    // The tool that produced it is named on the scope, so the surface knows what to re-call to
    // resolve it — a blockage from a synchronous tool has no run to retry.
    expect(blockage.scope.tool).toBe("visual_identity_propose");
    // The prose is still there for anything that only ever read the message.
    expect(envelope.error.message).toContain("returned no proposal");
  });

  it("threads modelConfigOverride into the node as a one-shot ceiling", async () => {
    const { definition, calls } = proposeWith(({ nodeId }) => completedRun(nodeId, PROPOSAL));

    const result = await definition.execute({ ...houseArgs, modelConfigOverride: { budgetUsd: 1.5 } }) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(calls[0].modelConfig).toEqual({ budgetUsd: 1.5 });
  });

  it("passes no modelConfig at all when no override was asked for", async () => {
    const { definition, calls } = proposeWith(({ nodeId }) => completedRun(nodeId, PROPOSAL));
    await definition.execute(houseArgs);
    expect(calls[0].modelConfig).toBeUndefined();
  });

  it("refuses an override outside the allowed range rather than passing it to the node", async () => {
    const { definition, calls } = proposeWith(({ nodeId }) => completedRun(nodeId, PROPOSAL));
    await expect(definition.execute({ ...houseArgs, modelConfigOverride: { budgetUsd: -1 } })).rejects.toBeTruthy();
    await expect(definition.execute({ ...houseArgs, modelConfigOverride: { model: "gpt-4o" } })).rejects.toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe("clampModelConfigOverride — the tenant spend lever, shut", () => {
  // visual_identity_propose is on SITE_CLIENT_MANAGER_TOOLS: a TENANT's bearer
  // can call it, and executeNode SPREADS modelConfig over the node's own — it
  // replaces the ceiling rather than tightening it, with no run-level budget
  // behind the synthetic run. Unclamped, this field is a per-call spend lever on
  // a node deliberately configured for one $0.25 turn.
  const writerConfig = { budgetUsd: 0.25, maxTurns: 1, maxOutputTokens: 1500 };

  it("passes the engine's own suggestion through untouched", () => {
    // ~$1.50 is what suggestedBudgetUsd offers for this node; the clamp must
    // never bite the remedy it exists to let through.
    expect(clampModelConfigOverride({ budgetUsd: 1.5 }, writerConfig)).toEqual({ override: { budgetUsd: 1.5 }, warnings: [] });
    expect(clampModelConfigOverride({ maxTurns: 2 }, writerConfig).override).toEqual({ maxTurns: 2 });
  });

  it("clamps a caller asking for far more, and SAYS so rather than refusing", () => {
    const clamped = clampModelConfigOverride({ budgetUsd: 100, maxTurns: 8, maxOutputTokens: 32_000 }, writerConfig);
    expect(clamped.override).toEqual({ budgetUsd: 2, maxTurns: 4, maxOutputTokens: 6000 });
    expect(clamped.warnings).toEqual([
      "model_config_override_clamped:budgetUsd:100_to_2",
      "model_config_override_clamped:maxTurns:8_to_4",
      "model_config_override_clamped:maxOutputTokens:32000_to_6000"
    ]);
  });

  it("scales with a node that is legitimately configured to spend more", () => {
    expect(clampModelConfigOverride({ budgetUsd: 20 }, { budgetUsd: 3 }).override).toEqual({ budgetUsd: 20 });
  });

  it("is a no-op when nothing was asked for", () => {
    expect(clampModelConfigOverride(undefined, writerConfig)).toEqual({ warnings: [] });
  });
});
