import { describe, expect, it } from "vitest";
import {
  RELEASE_EXECUTION_ARTIFACT,
  releaseLedgerKey,
  runDeterministicReleaseExecutor,
  type ReleaseExecutionOutput
} from "../../../src/agent/workspace/releaseExecution.js";
import { enforcePublishExecutionEvidence } from "../../../src/agent/workspace/publishDecision.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import type { CallToolFn } from "../../../src/agent/workspace/publisher.js";
import type { ReleaseLedgerEntry, WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T15.6 (ADR-2026-08-25-publish-autonomy §4.3) — release_executor.
//   - deterministic, idempotent keyed on (runId, requestId): a retry/continuation-tick must never
//     release twice, and a second call returns the first result;
//   - skips honestly when nothing was published (status "skipped", never success dressed up);
//   - never throws past its own try/catch;
//   - produces {deployStatus, productionConfirmed, releaseId, deployedSha} — the evidence
//     enforcePublishExecutionEvidence already demands of an "executed" claim.

type RunFixture = Pick<WorkflowExecutionRecord, "runId" | "stageOutputs" | "operatorPublishDecision" | "publishingPolicySnapshot" | "releaseLedger">;

const committedRun = (overrides: Partial<RunFixture> = {}): RunFixture => ({
  runId: "run_release_1",
  stageOutputs: {
    publish_executor: {
      artifact: "publish_execution.v1",
      status: "published_pending_release",
      publishCommitted: true,
      receipts: { requestId: "req_release_20260825_01" }
    }
  },
  operatorPublishDecision: "approved",
  publishingPolicySnapshot: { autonomyMode: "operator-gated", publishEnabled: true },
  ...overrides
});

const uncommittedRun = (): RunFixture => ({
  runId: "run_release_2",
  stageOutputs: {
    publish_executor: { artifact: "publish_execution.v1", status: "blocked", publishCommitted: false }
  },
  operatorPublishDecision: "approved"
});

const stubCallTool = (handlers: Partial<Record<string, (args: Record<string, unknown>) => unknown>>): { callTool: CallToolFn; calls: string[] } => {
  const calls: string[] = [];
  const callTool: CallToolFn = (async (tool: string, args: Record<string, unknown>) => {
    calls.push(tool);
    const handler = handlers[tool];
    if (!handler) throw new Error(`unexpected tool ${tool}`);
    const outcome = handler(args);
    if (outcome instanceof Error) throw outcome;
    return { ok: true, projectId: "dr-lurie", tool, result: outcome };
  }) as unknown as CallToolFn;
  return { callTool, calls };
};

// A run that already carries a ledger entry — the "second dispatch" shape a retry/stale-claim reclaim
// or continuation tick produces.
const withLedger = (run: RunFixture, entry: ReleaseLedgerEntry, key?: string): RunFixture => ({
  ...run,
  releaseLedger: { [key ?? releaseLedgerKey(run.runId, "req_release_20260825_01")]: entry }
});

describe("release_executor — nothing published ⇒ skipped, not success", () => {
  it("calls no tool at all and reports status skipped when publish_executor never committed", async () => {
    const { callTool, calls } = stubCallTool({});
    const outcome = await runDeterministicReleaseExecutor({ run: uncommittedRun(), deps: { callTool } });

    expect(outcome.ok).toBe(true);
    expect((outcome as { kind: string }).kind).toBe("completed");
    const output = (outcome as { output: ReleaseExecutionOutput }).output;
    expect(output.status).toBe("skipped");
    expect(output.reason).toBe("nothing_published");
    expect(calls).toEqual([]);
    expect(validateOutput(output, getWorkspaceNode("release_executor")?.outputSchema).ok).toBe(true);
  });

  it("skips when publish_executor's stage output is entirely absent (never reached)", async () => {
    const { callTool, calls } = stubCallTool({});
    const outcome = await runDeterministicReleaseExecutor({ run: { runId: "run_release_3", stageOutputs: {} }, deps: { callTool } });
    const output = (outcome as { ok: true; kind: "completed"; output: ReleaseExecutionOutput }).output;
    expect(output.status).toBe("skipped");
    expect(calls).toEqual([]);
  });
});

describe("release_executor — idempotent: call twice, one release", () => {
  it("a second dispatch after a terminal executed result returns the SAME output and calls nothing", async () => {
    const { callTool, calls } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_1" }, targetCommit: "sha_abc", deployStatus: "ready", productionConfirmed: true })
    });
    const run = committedRun();

    const first = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    expect(first.ok).toBe(true);
    expect((first as { kind: string }).kind).toBe("completed");
    const firstOutput = (first as { output: ReleaseExecutionOutput }).output;
    expect(firstOutput.status).toBe("executed");
    expect(calls).toEqual(["release_to_production"]);

    // Simulate what executor.ts persists: the ledger entry from the first dispatch, on the run.
    const ledgered = withLedger(run, (first as { ledgerEntry: ReleaseLedgerEntry }).ledgerEntry);

    const second = await runDeterministicReleaseExecutor({ run: ledgered, deps: { callTool } });
    expect(second.ok).toBe(true);
    expect((second as { kind: string }).kind).toBe("completed");
    const secondOutput = (second as { output: ReleaseExecutionOutput }).output;
    expect(secondOutput).toEqual(firstOutput);
    // release_to_production was called EXACTLY ONCE across both dispatches.
    expect(calls).toEqual(["release_to_production"]);
    expect((second as { warnings: string[] }).warnings).toContain("release_execution_idempotent_replay");
  });

  it("a second dispatch while verification is still pending re-polls deploy_status but never re-releases", async () => {
    const { callTool, calls } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_2" }, targetCommit: "sha_def" }),
      deploy_status: () => ({ deployStatus: "ready", productionConfirmed: true })
    });
    const run = committedRun();

    const first = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    // release_to_production's own response carried no deployStatus/productionConfirmed, so the module
    // falls through to a deploy_status poll — which this stub answers "ready" on the first try.
    expect((first as { kind: string }).kind).toBe("completed");
    expect(calls).toEqual(["release_to_production", "deploy_status"]);

    const ledgered = withLedger(run, (first as { ledgerEntry: ReleaseLedgerEntry }).ledgerEntry);
    const second = await runDeterministicReleaseExecutor({ run: ledgered, deps: { callTool } });
    expect((second as { kind: string }).kind).toBe("completed");
    // Still no second release_to_production call.
    expect(calls).toEqual(["release_to_production", "deploy_status"]);
  });

  it("re-polls (never re-releases) across a genuinely pending sequence until deploy_status confirms", async () => {
    let pollCount = 0;
    const { callTool, calls } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_3" } }),
      deploy_status: () => {
        pollCount += 1;
        return pollCount < 3 ? { deployStatus: "building" } : { deployStatus: "ready", productionConfirmed: true };
      }
    });
    const run = committedRun();

    let outcome = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    expect((outcome as { kind: string }).kind).toBe("pending");
    let ledgered = withLedger(run, (outcome as { ledgerEntry: ReleaseLedgerEntry }).ledgerEntry);

    outcome = await runDeterministicReleaseExecutor({ run: ledgered, deps: { callTool } });
    expect((outcome as { kind: string }).kind).toBe("pending");
    ledgered = withLedger(run, (outcome as { ledgerEntry: ReleaseLedgerEntry }).ledgerEntry);

    outcome = await runDeterministicReleaseExecutor({ run: ledgered, deps: { callTool } });
    expect((outcome as { kind: string }).kind).toBe("completed");
    const output = (outcome as { output: ReleaseExecutionOutput }).output;
    expect(output.status).toBe("executed");

    // release_to_production called exactly once across THREE dispatches; deploy_status polled thrice.
    expect(calls.filter((tool) => tool === "release_to_production")).toHaveLength(1);
    expect(calls.filter((tool) => tool === "deploy_status")).toHaveLength(3);
  });

  it("a release call that genuinely FAILS is not ledgered as released — a retry may call it again", async () => {
    let attempts = 0;
    const { callTool, calls } = stubCallTool({
      release_to_production: () => {
        attempts += 1;
        if (attempts === 1) return new Error("network timeout");
        return { released: true, deploy: { deployId: "deploy_4" }, deployStatus: "ready", productionConfirmed: true };
      }
    });
    const run = committedRun();

    const first = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    const firstOutput = (first as { output: ReleaseExecutionOutput }).output;
    expect(firstOutput.status).toBe("blocked");
    expect(firstOutput.reason).toBe("release_call_failed");
    expect(firstOutput.notes.join(" ")).toMatch(/Recoverable/);

    // Nothing was ledgered as a real release, so a retry (no ledger entry supplied) calls it again.
    const second = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    const secondOutput = (second as { output: ReleaseExecutionOutput }).output;
    expect(secondOutput.status).toBe("executed");
    expect(calls).toEqual(["release_to_production", "release_to_production"]);
  });
});

describe("release_executor — evidence: an executed claim without go-live evidence downgrades to blocked", () => {
  it("enforcePublishExecutionEvidence downgrades a forged/incomplete executed claim from this module's own output shape", () => {
    const claimed: ReleaseExecutionOutput = {
      artifact: RELEASE_EXECUTION_ARTIFACT,
      summary: "claims executed without evidence",
      status: "executed",
      releaseId: "deploy_x",
      approvalMatched: true,
      publishAuthority: { mode: "operator-gated", source: "operator_explicit", operatorDecision: "approved" },
      // No `verification` and no `result` — the evidence rule must catch this regardless of status.
      blockers: [],
      notes: []
    };
    const enforced = enforcePublishExecutionEvidence(claimed, { operatorPublishDecision: "approved" });
    expect(enforced.downgraded).toBe(true);
    expect(enforced.output).toMatchObject({ status: "blocked" });
    expect(enforced.reasons.join(" ")).toMatch(/executed_without_go_live_evidence/);
  });

  it("does not downgrade this module's own genuinely-evidenced executed claim", async () => {
    const { callTool } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_5" }, deployStatus: "ready", productionConfirmed: true })
    });
    const run = committedRun();
    const outcome = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    const output = (outcome as { output: ReleaseExecutionOutput }).output;

    expect(output.status).toBe("executed");
    expect(output.verification).toEqual({ deployStatus: "ready", productionConfirmed: true });
    expect(output.releaseId).toBe("deploy_5");
    expect(validateOutput(output, getWorkspaceNode("release_executor")?.outputSchema).ok).toBe(true);
    expect(enforcePublishExecutionEvidence(output, run).downgraded).toBe(false);
  });
});

describe("release_executor — never throws past its own try/catch", () => {
  it("a transport that throws on release_to_production is reported as a typed blocker, not an exception", async () => {
    const callTool: CallToolFn = (async () => { throw new Error("ECONNRESET"); }) as unknown as CallToolFn;
    const run = committedRun();
    await expect(runDeterministicReleaseExecutor({ run, deps: { callTool } })).resolves.toMatchObject({
      ok: true,
      kind: "completed",
      output: { status: "blocked", reason: "release_call_failed" }
    });
  });

  it("a transport that throws on deploy_status is reported as pending, not an exception", async () => {
    const callTool: CallToolFn = (async (tool: string) => {
      if (tool === "release_to_production") return { ok: true, projectId: "dr-lurie", tool, result: { released: true, deploy: { deployId: "deploy_6" } } };
      throw new Error("poll network error");
    }) as unknown as CallToolFn;
    const run = committedRun();
    const outcome = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    expect(outcome).toMatchObject({ ok: true, kind: "pending" });
    expect((outcome as { warnings: string[] }).warnings.join(" ")).toMatch(/deploy_status_poll_failed/);
  });

  it("returns ok:false (never throws) when no transport is supplied and something was published", async () => {
    const run = committedRun();
    await expect(runDeterministicReleaseExecutor({ run })).resolves.toMatchObject({ ok: false, code: "no_transport" });
  });
});

describe("release_executor — the ledger key", () => {
  it("is scoped to (runId, requestId)", () => {
    expect(releaseLedgerKey("run_a", "req_1")).toBe("run_a:req_1");
    expect(releaseLedgerKey("run_a", undefined)).toBe("run_a:none");
    expect(releaseLedgerKey("run_b", "req_1")).not.toBe(releaseLedgerKey("run_a", "req_1"));
  });
});

// ---------------------------------------------------------------------------
// W1.1 regression (2026-08-29, run_1787930929962_njffct): a release that was
// never confirmed to have landed must NOT be ledgered terminal. The release DID
// land, the serverless wait cap returned HTTP 504, the 504 was ledgered
// terminal, and every later retry replayed the stored 504 verbatim and called
// nothing — while production was already serving the commit. blockedOutput's
// own note has always promised "nothing here was ledgered as released, so a
// retry may call release_to_production again"; these tests hold the code to it.
// ---------------------------------------------------------------------------
describe("W1.1 — a recoverable release failure is never ledgered terminal", () => {
  it('ledger:"none" when release_to_production throws (the HTTP 504 wait-cap case)', async () => {
    const { callTool, calls } = stubCallTool({
      release_to_production: () => new Error("MCP request failed with HTTP 504.")
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun() as WorkflowExecutionRecord, deps: { callTool } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.status).toBe("blocked");
    expect(outcome.output.reason).toBe("release_call_failed");
    // The whole point: the executor must write NOTHING to the ledger for this.
    expect(outcome.ledger).toBe("none");
    expect(calls).toEqual(["release_to_production"]);
  });

  it('ledger:"none" when the client declines the release (released !== true)', async () => {
    const { callTool } = stubCallTool({ release_to_production: () => ({ released: false, status: "build_not_confirmed_live" }) });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun() as WorkflowExecutionRecord, deps: { callTool } });

    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.reason).toBe("release_not_confirmed");
    expect(outcome.ledger).toBe("none");
  });

  it('ledger:"pending" when the release landed but verification gave up — re-pollable, never re-released', async () => {
    const { callTool, calls } = stubCallTool({
      release_to_production: () => ({ released: true, releaseId: "dep_1", targetCommit: "abc123" }),
      deploy_status: () => ({ deployStatus: "building", productionConfirmed: false })
    });
    const outcome = await runDeterministicReleaseExecutor({
      run: committedRun() as WorkflowExecutionRecord,
      deps: { callTool, maxPollAttempts: 1 }
    });

    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.reason).toBe("deploy_not_confirmed_after_max_attempts");
    // pending, not terminal: a later retry re-polls deploy_status and can still reach "executed".
    expect(outcome.ledger).toBe("pending");
    expect(outcome.ledgerEntry.status).toBe("pending");
    expect(calls).toEqual(["release_to_production", "deploy_status"]);
  });

  it('a genuinely executed release is still ledgered terminal', async () => {
    const { callTool } = stubCallTool({
      release_to_production: () => ({ released: true, releaseId: "dep_2", targetCommit: "abc123" }),
      deploy_status: () => ({ deployStatus: "ready", productionConfirmed: true })
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun() as WorkflowExecutionRecord, deps: { callTool } });

    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.status).toBe("executed");
    expect(outcome.ledger).toBe("terminal");
  });
});
