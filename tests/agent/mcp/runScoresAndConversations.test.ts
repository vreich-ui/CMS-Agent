import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { runScoresOf, SCORING_NODE_IDS } from "../../../src/agent/workspace/runScores.js";
import { runSummaryOf } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W5 contract tests — the two new reads.

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

const scoredRun = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: "run_scored_0001",
  projectId: "dr-lurie",
  workflowId: "publishing_conductor",
  status: "completed",
  startedAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:10:00.000Z",
  nodes: [
    { nodeId: "human_texture", status: "completed" },
    { nodeId: "trust_factual", status: "completed" },
    { nodeId: "emotional_resonance", status: "completed" },
    { nodeId: "reader_simulation", status: "completed" },
    { nodeId: "review_aggregator", status: "completed" },
    { nodeId: "draft_writer", status: "completed" },
    { nodeId: "research", status: "failed" }
  ],
  stageOutputs: {
    human_texture: { artifact: "human_texture_review.v1", summary: "ok", verdict: "pass" },
    trust_factual: { artifact: "trust_factual_review.v1", summary: "ok", verdict: "blocked" },
    emotional_resonance: { artifact: "emotional_resonance_review.v1", summary: "ok", score: 0.82 },
    reader_simulation: { artifact: "reader_simulation.v1", summary: "ok", result: { score: 0.61 } },
    review_aggregator: { artifact: "review_aggregation.v1", summary: "ok", reviewStatus: "revise" },
    draft_writer: { artifact: "draft.v1", summary: "a draft", wordCount: 1400 },
    // A node that FAILED: whatever it wrote is not a score.
    research: { artifact: "research_brief.v1", score: 0.99 }
  },
  artifacts: [],
  errors: [],
  approvalsRequired: [],
  dryRun: true,
  executionMode: "mock",
  ...overrides
} as unknown as WorkflowExecutionRecord);

describe("W5 — a run's scores", () => {
  it("reads the judgement each scoring node actually recorded, numbers and verdicts alike", () => {
    expect(runScoresOf(scoredRun())).toEqual({
      human_texture: "pass",
      trust_factual: "blocked",
      emotional_resonance: 0.82,
      reader_simulation: 0.61,
      review_aggregator: "revise"
    });
  });

  it("omits a node that recorded none rather than reporting a zero", () => {
    // "Not scored" and "scored zero" are different facts. draft_writer wrote an output with a
    // number in it (wordCount) and is deliberately absent; research FAILED and its 0.99 is ignored.
    const scores = runScoresOf(scoredRun());
    expect(scores).not.toHaveProperty("draft_writer");
    expect(scores).not.toHaveProperty("research");
    // ...and a run that scored nothing at all carries no `scores` field on its index row.
    const unscored = runSummaryOf(scoredRun({ stageOutputs: {}, nodes: [] } as never));
    expect(unscored).not.toHaveProperty("scores");
  });

  it("never mistakes a token count, a duration or free text for a score", () => {
    const noisy = runScoresOf(scoredRun({
      stageOutputs: {
        human_texture: { summary: "fine", tokens: 4120, durationMs: 9000, notes: ["a", "b"] },
        trust_factual: { verdict: "x".repeat(200) }
      }
    } as never));
    expect(noisy).toEqual({});
  });

  it("is carried on a list row only when the caller asks for it", async () => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
    await repositoryManager.getExecutionRepository().createRun(scoredRun());

    const lean = await data("workflow.list_runs", { limit: 5 });
    expect(lean.runs[0]).not.toHaveProperty("scores");

    const withScores = await data("workflow.list_runs", { limit: 5, include: ["scores"] });
    expect(withScores.runs[0].scores).toMatchObject({ emotional_resonance: 0.82, review_aggregator: "revise" });
    // ...and asking for scores does NOT drag the per-node chips along with them.
    expect(withScores.runs[0]).not.toHaveProperty("nodeStatuses");
    delete process.env.MCP_API_TOKEN;
    resetRepositoryManager();
  });

  it("names its scoring nodes explicitly rather than sniffing every output", () => {
    // A generic "find a number that looks like a score" walk would report token counts and
    // durations as quality. The set is a deliberate list, and widening it is a deliberate act.
    expect(SCORING_NODE_IDS).toContain("review_aggregator");
    expect(SCORING_NODE_IDS).toContain("capture_score");
    expect(SCORING_NODE_IDS).toContain("fit_adjudicator");
    expect(SCORING_NODE_IDS).not.toContain("draft_writer");
  });
});

describe("W5 — agent.list_conversations", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  const turn = (n: number, overrides: Record<string, unknown> = {}) => ({
    recordType: "turn" as const,
    turnId: `turn_${n}`,
    conversationId: `conv_${n % 2}`,
    projectId: n % 2 === 0 ? "dr-lurie" : "zilberman",
    agentRef: "agt_client_manager@11",
    agentRev: "11",
    actor: { kind: "human" as const, id: "operator" },
    requestPreview: { messageCount: n, latestMessagePreview: `message ${n}`, toolNames: ["object_create"] },
    assistantText: "x".repeat(900),
    toolCalls: [{ name: "object_create" }, { function: { name: "object_patch" } }],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsdEstimate: 0.01 },
    createdAt: new Date(Date.UTC(2026, 8, 15, 0, n)).toISOString(),
    ...overrides
  });

  it("returns the agent's turns, newest conversation first, with proposals rather than executions", async () => {
    const repository = repositoryManager.getConversationTurnRepository();
    for (let n = 1; n <= 4; n++) await repository.record(turn(n) as never);

    const result = await data("agent.list_conversations", { agentId: "agt_client_manager" });
    expect(result.conversations.length).toBeGreaterThanOrEqual(1);
    const [newest, older] = result.conversations;
    if (older) expect(newest.lastTurnAt >= older.lastTurnAt).toBe(true);

    const [firstTurn] = newest.turns;
    expect(firstTurn.actor).toEqual({ kind: "human", id: "operator" });
    // The request MIRROR, never the caller's full payload: CMS-Agent is not the transcript
    // authority and must not become one through a read verb.
    expect(firstTurn.request).toMatchObject({ messageCount: expect.any(Number) });
    expect(firstTurn).not.toHaveProperty("messages");
    // Tool calls are PROPOSALS — CMS-Agent never executes one.
    expect(firstTurn.proposedToolCalls.map((call: { name: string }) => call.name)).toEqual(["object_create", "object_patch"]);
    // The reply is truncated rather than mirrored whole.
    expect(firstTurn.assistantText.length).toBeLessThan(900);
    expect(firstTurn.usage.totalTokens).toBe(150);
  });

  it("scopes by project, and says when older conversations were left unexamined", async () => {
    const repository = repositoryManager.getConversationTurnRepository();
    for (let n = 1; n <= 4; n++) await repository.record(turn(n) as never);

    const scoped = await data("agent.list_conversations", { agentId: "agt_client_manager", projectId: "dr-lurie" });
    for (const conversation of scoped.conversations) expect(conversation.projectId).toBe("dr-lurie");

    // The scan is bounded independently of `limit`, and the response says whether it hit the cap —
    // an incomplete answer is never presented as a complete one.
    const capped = await data("agent.list_conversations", { agentId: "agt_client_manager", limit: 1 });
    expect(typeof capped.scanned).toBe("number");
    expect(typeof capped.scanCapped).toBe("boolean");
    expect(capped.conversations.length).toBeLessThanOrEqual(1);
  });

  it("returns nothing for an agent with no turns rather than someone else's", async () => {
    const repository = repositoryManager.getConversationTurnRepository();
    await repository.record(turn(1) as never);
    const other = await data("agent.list_conversations", { agentId: "agt_some_other_agent" });
    expect(other.conversations).toEqual([]);
  });
});
