import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_MODE, runModeSummary, startDryRun } from "../../../src/agent/workspace/executor.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// executionMode used to default to "mock" at every entry point, so the pipeline's default behavior
// was to emit deterministic placeholder artifacts that are structurally indistinguishable from real
// model output — and nothing said so. Two things changed: live is the default, and every run states
// what produced it.
describe("execution mode is deliberate, not silent", () => {
  it("defaults to live model execution", () => {
    expect(DEFAULT_EXECUTION_MODE).toBe("openai");
  });

  it("stamps the caller's mode on the run rather than inferring it later", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const mock = await startDryRun({ projectId: "dr-lurie", input: "x", executionMode: "mock" }, store);
    const live = await startDryRun({ projectId: "dr-lurie", input: "x", executionMode: "openai" }, store);
    const unspecified = await startDryRun({ projectId: "dr-lurie", input: "x" }, store);

    expect(mock.executionMode).toBe("mock");
    expect(live.executionMode).toBe("openai");
    expect(unspecified.executionMode).toBe(DEFAULT_EXECUTION_MODE);
  });

  it("says plainly that a mock run's artifacts are not real content", () => {
    const summary = runModeSummary({ executionMode: "mock" });
    expect(summary.live).toBe(false);
    expect(summary.executionMode).toBe("mock");
    expect(summary.declared).toBe(true);
    expect(summary.notice).toContain("MOCK RUN");
    expect(summary.notice).toContain("must not be treated as real content");
  });

  it("marks a live run as live", () => {
    const summary = runModeSummary({ executionMode: "openai" });
    expect(summary.live).toBe(true);
    expect(summary.notice).toContain("LIVE MODEL RUN");
  });

  // A record persisted before the mode was stamped must not be passed off as a deliberate choice.
  it("flags a legacy record that never recorded its mode", () => {
    const summary = runModeSummary({});
    expect(summary.declared).toBe(false);
    expect(summary.notice).toContain("predates execution-mode stamping");
  });

  it("reports the node source, so a run says which definitions it actually ran", () => {
    delete process.env.WORKSPACE_NODES_SOURCE;
    expect(runModeSummary({ executionMode: "mock" }).nodeSource).toBe("store");
    process.env.WORKSPACE_NODES_SOURCE = "static";
    const pinned = runModeSummary({ executionMode: "mock" });
    expect(pinned.nodeSource).toBe("static");
    expect(pinned.notice).toContain("are NOT in this run until nodes.ts is re-seeded");
    delete process.env.WORKSPACE_NODES_SOURCE;
  });
});

describe("workflow.get_run / workflow.list_runs report the mode prominently", () => {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(response.body ?? "{}");
  };
  const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("carries a top-level mode block on get_run so a mock run cannot be mistaken for a real one", async () => {
    const runId = (await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {} })).run.runId;
    const result = await data("workflow.get_run", { runId });

    expect(result.mode.executionMode).toBe("mock");
    expect(result.mode.live).toBe(false);
    expect(result.mode.notice).toContain("MOCK RUN");
  });

  it("carries the mode on every row of the run list", async () => {
    await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {} });
    await data("workflow.start_dry_run", { executionMode: "openai", projectId: "dr-lurie", input: {} });
    const runs = (await data("workflow.list_runs", {})).runs as { mode: { live: boolean } }[];

    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((run) => typeof run.mode?.live === "boolean")).toBe(true);
    expect(runs.some((run) => run.mode.live)).toBe(true);
    expect(runs.some((run) => !run.mode.live)).toBe(true);
  });

  it("returns a null mode for an unknown run rather than inventing one", async () => {
    const result = await data("workflow.get_run", { runId: "run_does_not_exist" });
    expect(result.run).toBeNull();
    expect(result.mode).toBeNull();
  });
});
