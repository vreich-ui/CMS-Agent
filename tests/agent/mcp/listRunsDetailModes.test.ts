import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W4 contract — workflow.list_runs' two detail modes, through the real MCP handler.
//
// `summary` is the default because it is what a LIST is for: identity, status, where it stopped,
// how far it got, whether it is stuck. `full` still exists for the caller that genuinely wants
// per-node detail across a page — it just no longer taxes everyone who does not.

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

const makeRun = (n: number, overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: `run_${String(n).padStart(4, "0")}`,
  workflowId: "publishing_conductor",
  projectId: n % 2 === 0 ? "dr-lurie" : "zilberman",
  status: n % 5 === 0 ? "failed" : "completed",
  startedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, n)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 7, 1, 0, 1, n)).toISOString(),
  nodes: [
    { nodeId: "input_triage", status: "completed", produces: ["content_source.v1"], durationMs: 700, warnings: ["w"], errors: [] },
    { nodeId: "draft_writer", status: n % 5 === 0 ? "failed" : "completed", produces: ["draft.v1"], durationMs: 4000, errors: n % 5 === 0 ? ["draft_writer:boom"] : [] }
  ],
  artifacts: [],
  errors: n % 5 === 0 ? ["draft_writer:boom"] : [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true,
  executionMode: "mock",
  ...overrides
}) as unknown as WorkflowExecutionRecord;

describe("workflow.list_runs detail modes (W4)", () => {
  beforeEach(async () => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
    const store = repositoryManager.getExecutionRepository();
    for (let n = 0; n < 25; n += 1) await store.createRun(makeRun(n));
  });

  it("defaults to summary rows: counts, no nodes[], and the page still knows the true fleet size", async () => {
    const result = await data("workflow.list_runs", {});
    expect(result.detail).toBe("summary");
    expect(result.runs).toHaveLength(20);
    expect(result.page).toMatchObject({ limit: 20, matchedCount: 25, hasMore: true });

    const row = result.runs[0] as Record<string, unknown>;
    expect(row.runId).toBe("run_0024");
    expect(row.nodes).toBeUndefined();
    expect(row).toMatchObject({ nodeCount: 2, completedCount: 2, failedCount: 0, errorCount: 0, artifactCount: 0, dryRun: true });
    // W2 — the mode block is interned in the response-level `modes` map and the row points at it.
    expect(row.mode).toBeUndefined();
    expect((result.modes as Record<string, unknown>)[row.modeRef as string]).toMatchObject({ executionMode: "mock", live: false, declared: true });

    const failedRow = (result.runs as Array<Record<string, unknown>>).find((r) => r.status === "failed");
    expect(failedRow).toMatchObject({ failedCount: 1, completedCount: 1, errorCount: 1 });
  });

  it("detail: \"full\" keeps today's shape, nodes[] and all", async () => {
    const result = await data("workflow.list_runs", { detail: "full" });
    expect(result.detail).toBe("full");
    const row = result.runs[0] as { nodes: Array<Record<string, unknown>>; nodeCount: number };
    expect(row.nodes).toHaveLength(2);
    expect(row.nodes[0]).toMatchObject({ nodeId: "input_triage", status: "completed" });
    expect(row.nodeCount).toBe(2);
  });

  it("the two modes agree on identity, order, status and paging — they differ only in per-node detail", async () => {
    const summary = await data("workflow.list_runs", { limit: 10 });
    const full = await data("workflow.list_runs", { limit: 10, detail: "full" });

    const ids = (rows: Array<{ runId: string }>) => rows.map((row) => row.runId);
    expect(ids(summary.runs)).toEqual(ids(full.runs));
    expect(summary.page.matchedCount).toBe(full.page.matchedCount);
    expect(summary.page.hasMore).toBe(full.page.hasMore);
    for (let i = 0; i < summary.runs.length; i += 1) {
      expect(summary.runs[i].status).toBe(full.runs[i].status);
      expect(summary.runs[i].nodeCount).toBe(full.runs[i].nodeCount);
    }
  });

  it("a cursor from a summary page is a valid cursor for a full page, and vice versa", async () => {
    const summaryFirst = await data("workflow.list_runs", { limit: 10 });
    const fullSecond = await data("workflow.list_runs", { limit: 10, cursor: summaryFirst.page.nextCursor, detail: "full" });
    const summarySecond = await data("workflow.list_runs", { limit: 10, cursor: summaryFirst.page.nextCursor });

    expect(fullSecond.runs.map((r: { runId: string }) => r.runId)).toEqual(summarySecond.runs.map((r: { runId: string }) => r.runId));
    // No overlap with the first page, no gap either.
    const firstIds = new Set(summaryFirst.runs.map((r: { runId: string }) => r.runId));
    for (const row of summarySecond.runs as Array<{ runId: string }>) expect(firstIds.has(row.runId)).toBe(false);
  });

  it("filters and multi-status matching behave identically in summary mode", async () => {
    const scoped = await data("workflow.list_runs", { projectId: "dr-lurie", limit: 100 });
    expect(scoped.runs.every((row: { projectId: string }) => row.projectId === "dr-lurie")).toBe(true);
    expect(scoped.page.matchedCount).toBe(13); // n = 0,2,...,24

    const failedOnly = await data("workflow.list_runs", { status: "failed", limit: 1 });
    expect(failedOnly.page.matchedCount).toBe(5); // n = 0,5,10,15,20
    const either = await data("workflow.list_runs", { status: ["failed", "completed"], limit: 1 });
    expect(either.page.matchedCount).toBe(25);
  });

  it("a summary row is an order of magnitude smaller than the full row it replaces", async () => {
    const summary = await data("workflow.list_runs", { limit: 20 });
    const full = await data("workflow.list_runs", { limit: 20, detail: "full" });

    const bytes = (value: unknown) => JSON.stringify(value).length;
    expect(bytes(summary.runs)).toBeLessThan(bytes(full.runs));
    // Each row comfortably inside the ~1KB target, on a fixture whose rows are already modest —
    // a real run's nodes[] carries two dozen nodes with timings, warnings and attempt history.
    for (const row of summary.runs as unknown[]) expect(bytes(row)).toBeLessThan(1_024);
  });
});

// W2 — the envelope. Measured live 2026-09-16: a `{limit:50, summary}` page was 60 KB, of which
// `mode` was 24 KB (repeated verbatim on every row, two distinct values across the fleet) and
// `nodeStatuses` 18 KB (rendered by exactly one surface, discarded by every other caller).
describe("workflow.list_runs payload projections (W2)", () => {
  beforeEach(async () => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
    const repository = repositoryManager.getExecutionRepository();
    for (let n = 1; n <= 50; n++) await repository.createRun(makeRun(n));
  });

  it("interns the mode block once per distinct value instead of repeating it per row", async () => {
    const page = await data("workflow.list_runs", { limit: 50 });
    expect(page.runs).toHaveLength(50);
    // Two distinct modes across fifty rows — one entry each, and every row points at one.
    expect(Object.keys(page.modes).length).toBeLessThanOrEqual(2);
    for (const row of page.runs) {
      expect(row).not.toHaveProperty("mode");
      expect(page.modes[row.modeRef]).toBeDefined();
    }
  });

  it("leaves the per-node chips off unless a caller asks for them", async () => {
    const withoutChips = await data("workflow.list_runs", { limit: 50 });
    for (const row of withoutChips.runs) {
      expect(row).not.toHaveProperty("nodeStatuses");
      expect(row).not.toHaveProperty("failedNodeIds");
    }
    // ...and the counts a row has always carried are still there, so "how many failed" needs no
    // opt-in — only "which ones" does.
    expect(withoutChips.runs[0]).toHaveProperty("nodeCount");

    const withChips = await data("workflow.list_runs", { limit: 50, include: ["nodeStatuses"] });
    expect(withChips.runs.some((row: { nodeStatuses?: unknown }) => row.nodeStatuses)).toBe(true);

    // The saving, asserted rather than asserted-about.
    const lean = JSON.stringify(withoutChips).length;
    const fat = JSON.stringify(withChips).length;
    expect(lean).toBeLessThan(fat);
    expect(lean).toBeLessThanOrEqual(20 * 1024);
  });

  it("keeps the chips available to the one surface that draws them", async () => {
    const page = await data("workflow.list_runs", { limit: 5, include: ["nodeStatuses"] });
    const failed = page.runs.find((row: { failedNodeIds?: string[] }) => row.failedNodeIds?.length);
    expect(failed?.nodeStatuses).toMatchObject({ draft_writer: "f" });
  });
});
