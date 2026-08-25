import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { resetRun, retryNode, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { conductorCache } from "../../../src/agent/workspace/conductor.js";

// T3 (autonomous-publish). RunScopedCache.invalidateRun existed with ZERO callers, so nothing a run
// memoized was ever dropped short of a whole-process reset. That made the two controls an operator
// reaches for after fixing a client problem — workflow.retry_node and workflow.reset_run — silently
// inert with respect to the deterministic client reads (reduced object contract, editorial voice,
// run context bundle) that the failure came from in the first place: the retry replayed the stored
// read rather than making a fresh attempt.
//
// The invalidation lives in the executor, not in the MCP tool, so EVERY driver that retries gets it
// — the HTTP tool and the Cloud Run conductor job's gate-clearing retry alike.
describe("run-scoped cache invalidation on retry/reset", () => {
  it("retryNode drops everything memoized for that run, and only that run", async () => {
    const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-cache-retry", input: "x" }, store);
    await runNextNode(started.runId, { executionRepository: store });

    await conductorCache.getOrLoad(started.runId, "contract:project-cache-retry:(default)", async () => ({ ok: true }));
    await conductorCache.getOrLoad("run_untouched", "contract:other:(default)", async () => ({ ok: true }));
    expect(conductorCache.has(started.runId, "contract:project-cache-retry:(default)")).toBe(true);

    await retryNode(started.runId, "input_triage", { executionRepository: store });

    expect(conductorCache.has(started.runId, "contract:project-cache-retry:(default)")).toBe(false);
    expect(conductorCache.has("run_untouched", "contract:other:(default)")).toBe(true);
    conductorCache.invalidateRun("run_untouched");
  });

  it("resetRun drops everything memoized for that run", async () => {
    const store: ExecutionRepository = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-cache-reset", input: "x" }, store);
    await runNextNode(started.runId, { executionRepository: store });

    await conductorCache.getOrLoad(started.runId, "voice:project-cache-reset", async () => ({ source: "live" }));
    expect(conductorCache.has(started.runId, "voice:project-cache-reset")).toBe(true);

    await resetRun(started.runId, store);

    expect(conductorCache.has(started.runId, "voice:project-cache-reset")).toBe(false);
  });
});
