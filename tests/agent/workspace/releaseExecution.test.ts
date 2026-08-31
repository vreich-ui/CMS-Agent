import { describe, expect, it } from "vitest";
import {
  RELEASE_CALL_TIMEOUT_MARGIN_SECONDS,
  RELEASE_CALL_TIMEOUT_SECONDS,
  RELEASE_EXECUTION_ARTIFACT,
  releaseIdempotencyKey,
  releaseLedgerKey,
  runDeterministicReleaseExecutor,
  type ReleaseExecutionOutput
} from "../../../src/agent/workspace/releaseExecution.js";
import { RUN_DRIVER_TIME_BUDGET_CEILING_MS } from "../../../src/agent/mcp/workspace/tools.js";
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

const stubCallTool = (handlers: Partial<Record<string, (args: Record<string, unknown>) => unknown>>): { callTool: CallToolFn; calls: string[]; argsOf: (tool: string) => Record<string, unknown>[] } => {
  const calls: string[] = [];
  const argsLog: { tool: string; args: Record<string, unknown> }[] = [];
  const callTool: CallToolFn = (async (tool: string, args: Record<string, unknown>) => {
    calls.push(tool);
    argsLog.push({ tool, args });
    const handler = handlers[tool];
    if (!handler) throw new Error(`unexpected tool ${tool}`);
    const outcome = handler(args);
    if (outcome instanceof Error) throw outcome;
    return { ok: true, projectId: "dr-lurie", tool, result: outcome };
  }) as unknown as CallToolFn;
  return { callTool, calls, argsOf: (tool) => argsLog.filter((entry) => entry.tool === tool).map((entry) => entry.args) };
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

  it("a release call that genuinely FAILS is not ledgered as released — a retry may call it again (W7: with the SAME key)", async () => {
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
    // W7: an unacknowledged call is PENDING (the hook may have fired), never a terminal blocker.
    if (!first.ok || first.kind !== "pending") throw new Error("expected a pending outcome");
    expect(first.warnings.join(" ")).toMatch(/release_call_failed:network timeout/);
    expect(first.ledgerEntry).toMatchObject({ status: "pending", releaseUnconfirmed: true });

    // Not ledgered as an acknowledged release, so a retry calls it again — with the same key.
    const second = await runDeterministicReleaseExecutor({ run: withLedger(run, first.ledgerEntry), deps: { callTool } });
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
  it("a transport that throws on release_to_production is reported as a typed pending outcome, not an exception", async () => {
    const callTool: CallToolFn = (async () => { throw new Error("ECONNRESET"); }) as unknown as CallToolFn;
    const run = committedRun();
    const outcome = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    expect(outcome).toMatchObject({ ok: true, kind: "pending" });
    expect((outcome as { warnings: string[] }).warnings.join(" ")).toMatch(/release_call_failed:ECONNRESET/);
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

// W1.3 (corroborated in PR #232): deploy_status's own schema declares only `commit`/`deployId`
// (additionalProperties:false) and rejects a `release_id` key outright. That rejection surfaced as a
// clean `{ ok: false, error }` response (never a thrown exception — see projectMcpAdapter.callTool),
// which the poll folded into "not ready" instead of reporting the reject.
describe("release_executor — deploy_status is polled with the site's declared schema, never release_id", () => {
  it("polls with deployId when release_to_production reported one", async () => {
    const deployStatusArgs: Record<string, unknown>[] = [];
    const { callTool, calls } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_7" }, targetCommit: "sha_ghi" }),
      deploy_status: (args) => {
        deployStatusArgs.push(args);
        return { deployStatus: "ready", productionConfirmed: true };
      }
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun(), deps: { callTool } });

    expect(calls).toEqual(["release_to_production", "deploy_status"]);
    expect(deployStatusArgs).toEqual([{ deployId: "deploy_7" }]);
    expect((outcome as { kind: string }).kind).toBe("completed");
  });

  it("falls back to commit when release_to_production reported no deploy id", async () => {
    const deployStatusArgs: Record<string, unknown>[] = [];
    const { callTool } = stubCallTool({
      release_to_production: () => ({ released: true, targetCommit: "sha_jkl" }),
      deploy_status: (args) => {
        deployStatusArgs.push(args);
        return { deployStatus: "ready", productionConfirmed: true };
      }
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun(), deps: { callTool } });

    expect(deployStatusArgs).toEqual([{ commit: "sha_jkl" }]);
    expect((outcome as { kind: string }).kind).toBe("completed");
  });

  it("a request shape the site's schema rejects is reported as its own poll failure, never deploy_not_ready", async () => {
    const callTool: CallToolFn = (async (tool: string) => {
      if (tool === "release_to_production") return { ok: true, projectId: "dr-lurie", tool, result: { released: true, deploy: { deployId: "deploy_8" } } };
      // Mirrors a real additionalProperties:false rejection: the call fails cleanly, it never throws.
      return { ok: false, projectId: "dr-lurie", tool, error: "Unrecognized key(s) in object: 'release_id'", httpStatus: 400 };
    }) as unknown as CallToolFn;

    const outcome = await runDeterministicReleaseExecutor({ run: committedRun(), deps: { callTool } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "pending") throw new Error("expected a pending outcome");
    expect(outcome.warnings.join(" ")).toMatch(/deploy_status_poll_failed/);
    expect(outcome.warnings.join(" ")).toMatch(/Unrecognized key/);
    expect(outcome.warnings.join(" ")).not.toMatch(/deploy_status_not_ready/);
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
  it("never terminal when release_to_production throws (the HTTP 504 wait-cap case) — W7: pending, key stored, re-pollable", async () => {
    const { callTool, calls } = stubCallTool({
      release_to_production: () => new Error("MCP request failed with HTTP 504.")
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun() as WorkflowExecutionRecord, deps: { callTool } });

    expect(outcome.ok).toBe(true);
    // The whole point: the executor must never write this TERMINAL. W7 replaces "none" with a pending
    // entry that remembers the key the (possibly fired) hook went out under.
    if (!outcome.ok || outcome.kind !== "pending") throw new Error("expected a pending outcome");
    expect(outcome.ledgerEntry).toMatchObject({ status: "pending", releaseUnconfirmed: true, idempotencyKey: releaseIdempotencyKey("run_release_1", "req_release_20260825_01") });
    expect(calls).toEqual(["release_to_production"]);
  });

  it('ledger:"none" when the client genuinely declines the release (released:false, no hook-fired status)', async () => {
    const { callTool } = stubCallTool({ release_to_production: () => ({ released: false, status: "release_refused", error: "nothing to release" }) });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun() as WorkflowExecutionRecord, deps: { callTool } });

    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.reason).toBe("release_not_confirmed");
    expect(outcome.output.blockers.join(" ")).toMatch(/nothing to release/);
    expect(outcome.ledger).toBe("none");
  });

  it('a structured build_not_confirmed_live receipt (released:false, hook fired) is ledgered pending — re-pollable, never re-released', async () => {
    const { callTool, calls } = stubCallTool({
      release_to_production: () => ({ released: false, status: "build_not_confirmed_live", targetCommit: "sha_w7_live" }),
      deploy_status: () => ({ deployStatus: "building" })
    });
    const run = committedRun();
    const first = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    if (!first.ok || first.kind !== "pending") throw new Error("expected a pending outcome");
    expect(first.ledgerEntry).toMatchObject({ status: "pending", deployedSha: "sha_w7_live" });
    expect(first.ledgerEntry).not.toHaveProperty("releaseUnconfirmed");

    const second = await runDeterministicReleaseExecutor({ run: withLedger(run, first.ledgerEntry), deps: { callTool } });
    expect((second as { kind: string }).kind).toBe("pending");
    expect(calls).toEqual(["release_to_production", "deploy_status", "deploy_status"]);
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

// W1.3 (run_1788011844073_ipwrnx, 2026-08-30): the site's deploy_status schema accepts ONLY
// `commit`/`deployId` (additionalProperties:false). Every poll was rejected by schema, the refusal
// rode home as ok:true with isError inside the result, and the executor filed 7 polls of
// `deploy_status_not_ready:unknown` while the page was actually live. The executor must (1) poll
// with the publish receipt's own commit sha when the release response named nothing, and (2) never
// read a rejected CALL as evidence about the deploy's state.
describe("W1.3 — deploy_status polls the publish receipt's commit and surfaces rejections as rejections", () => {
  const committedRunWithCommitReceipt = (): RunFixture =>
    committedRun({
      stageOutputs: {
        publish_executor: {
          artifact: "publish_execution.v1",
          status: "published_pending_release",
          publishCommitted: true,
          receipts: { requestId: "req_release_20260825_01", commitSha: "sha_from_publish_receipt" }
        }
      }
    });

  it("polls with {commit: <receipts.commitSha>} when release_to_production named no deploy id or commit — never release_id", async () => {
    const deployStatusArgs: Record<string, unknown>[] = [];
    const { callTool, calls } = stubCallTool({
      release_to_production: () => ({ released: true }),
      deploy_status: (args) => {
        deployStatusArgs.push(args);
        return { deployStatus: "ready", productionConfirmed: true };
      }
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRunWithCommitReceipt(), deps: { callTool } });

    expect(calls).toEqual(["release_to_production", "deploy_status"]);
    expect(deployStatusArgs).toEqual([{ commit: "sha_from_publish_receipt" }]);
    expect(deployStatusArgs[0]).not.toHaveProperty("release_id");
    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.status).toBe("executed");
  });

  it("a re-poll dispatch whose pending ledger entry predates commit tracking still polls with the receipt's commit", async () => {
    const deployStatusArgs: Record<string, unknown>[] = [];
    const { callTool, calls } = stubCallTool({
      deploy_status: (args) => {
        deployStatusArgs.push(args);
        return { deployStatus: "ready", productionConfirmed: true };
      }
    });
    const run = withLedger(committedRunWithCommitReceipt(), {
      status: "pending",
      requestId: "req_release_20260825_01",
      performedAt: new Date().toISOString(),
      attempts: 1
    });
    const outcome = await runDeterministicReleaseExecutor({ run, deps: { callTool } });

    expect(calls).toEqual(["deploy_status"]);
    expect(deployStatusArgs).toEqual([{ commit: "sha_from_publish_receipt" }]);
    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.status).toBe("executed");
  });

  it("a schema rejection delivered as an isError MCP result (transport ok:true) is deploy_status_call_rejected, never not_ready:unknown", async () => {
    const { callTool } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_w13" } }),
      // The transport succeeded; the CLIENT refused — exactly how an additionalProperties:false
      // rejection actually arrives (publisher.ts: "`ok` here is the TRANSPORT's verdict").
      deploy_status: () => ({
        isError: true,
        content: [{ type: "text", text: "Unrecognized key(s) in object: 'release_id'" }],
        structuredContent: { error: "Unrecognized key(s) in object: 'release_id'", statusCode: 400 }
      })
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun(), deps: { callTool } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "pending") throw new Error("expected a pending outcome");
    expect(outcome.warnings.join(" ")).toMatch(/deploy_status_call_rejected/);
    expect(outcome.warnings.join(" ")).toMatch(/Unrecognized key/);
    expect(outcome.warnings.join(" ")).not.toMatch(/deploy_status_not_ready/);
    expect(outcome.warnings.join(" ")).not.toMatch(/not_ready:unknown/);
    // Retryable: pending ledger entry, so the next dispatch re-polls and never re-releases.
    expect(outcome.ledgerEntry.status).toBe("pending");
  });

  it("an error-shaped body WITHOUT the isError flag (no deployStatus, an error message) is also deploy_status_call_rejected", async () => {
    const { callTool } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_w13b" } }),
      deploy_status: () => ({ error: "deploy_status: request did not match the declared schema" })
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun(), deps: { callTool } });

    if (!outcome.ok || outcome.kind !== "pending") throw new Error("expected a pending outcome");
    expect(outcome.warnings.join(" ")).toMatch(/deploy_status_call_rejected/);
    expect(outcome.warnings.join(" ")).toMatch(/did not match the declared schema/);
    expect(outcome.warnings.join(" ")).not.toMatch(/deploy_status_not_ready/);
  });

  it("a response with neither deployStatus nor any error is unknown WITH the raw response appended, so it is diagnosable", async () => {
    const { callTool } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_w13c" } }),
      deploy_status: () => ({ somethingElse: true })
    });
    const outcome = await runDeterministicReleaseExecutor({ run: committedRun(), deps: { callTool } });

    if (!outcome.ok || outcome.kind !== "pending") throw new Error("expected a pending outcome");
    const joined = outcome.warnings.join(" ");
    expect(joined).toMatch(/deploy_status_not_ready:unknown raw=/);
    expect(joined).toMatch(/somethingElse/);
  });
});

// ---------------------------------------------------------------------------
// W7 (run_1788023523567_qdv9et, 2026-08-31, project dr-lurie): release_to_production hit the site's
// serverless cap and returned HTTP 504 AFTER the build hook had fired (deploy 6a952b5e, 07:21:02 ->
// 07:21:54). The executor ledgered "none" and the next dispatch called release_to_production AGAIN —
// a second production build (6a952b93, 07:21:55). Every call now carries a stable idempotency_key
// (the site replays the original receipt for the same key) and a timeout_seconds under this
// executor's own request window; a 504 is ledgered pending with the key, and the re-dispatch polls
// deploy_status by commit before re-calling with the SAME key.
// ---------------------------------------------------------------------------
describe("W7 — one build per release attempt, even across a 504", () => {
  const runWithReceipt = (receipts: Record<string, unknown>, runId = "run_1788023523567_qdv9et"): RunFixture =>
    committedRun({
      runId,
      stageOutputs: {
        publish_executor: { artifact: "publish_execution.v1", status: "published_pending_release", publishCommitted: true, receipts: { requestId: "req_release_20260825_01", ...receipts } }
      }
    });

  it("(a) the release call carries idempotency_key = release:<runId>:<publishCommitSha>", async () => {
    const { callTool, argsOf } = stubCallTool({
      release_to_production: () => ({ released: true, deploy: { deployId: "deploy_w7" }, deployStatus: "ready", productionConfirmed: true })
    });
    const outcome = await runDeterministicReleaseExecutor({ run: runWithReceipt({ commitSha: "6a952b5e" }), deps: { callTool } });

    expect(argsOf("release_to_production")).toHaveLength(1);
    expect(argsOf("release_to_production")[0]).toMatchObject({ idempotency_key: "release:run_1788023523567_qdv9et:6a952b5e" });
    expect(releaseIdempotencyKey("run_1788023523567_qdv9et", "6a952b5e")).toBe("release:run_1788023523567_qdv9et:6a952b5e");
    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.status).toBe("executed");
    expect(outcome.output.idempotencyKey).toBe("release:run_1788023523567_qdv9et:6a952b5e");
    expect(validateOutput(outcome.output, getWorkspaceNode("release_executor")?.outputSchema).ok).toBe(true);
  });

  it("(a) falls back to the published objectId when the receipt names no commit sha", async () => {
    const { callTool, argsOf } = stubCallTool({
      release_to_production: () => ({ released: true, deployStatus: "ready", productionConfirmed: true })
    });
    await runDeterministicReleaseExecutor({ run: runWithReceipt({ objectId: "page_bruxism_guide" }), deps: { callTool } });
    expect(argsOf("release_to_production")[0]).toMatchObject({ idempotency_key: "release:run_1788023523567_qdv9et:page_bruxism_guide" });
  });

  it("(b) a 504 on the first attempt, then a re-dispatch: the SAME key is sent, unchanged, and the build hook fires once", async () => {
    let releaseCalls = 0;
    const { callTool, calls, argsOf } = stubCallTool({
      release_to_production: () => {
        releaseCalls += 1;
        // First call: the platform killed the site's function after the hook fired.
        if (releaseCalls === 1) return new Error("MCP request failed with HTTP 504.");
        // Second call, same key: the site replays the ORIGINAL receipt rather than re-firing.
        return { released: true, deploy: { deployId: "6a952b5e" }, targetCommit: "6a952b5e", replayed_from_idempotency_key: "release:run_1788023523567_qdv9et:6a952b5e" };
      },
      deploy_status: () => ({ deployStatus: "ready", productionConfirmed: true })
    });
    const run = runWithReceipt({ commitSha: "6a952b5e" });

    const first = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    if (!first.ok || first.kind !== "pending") throw new Error("expected a pending outcome");
    expect(first.warnings.join(" ")).toMatch(/release_call_failed:MCP request failed with HTTP 504/);
    expect(first.ledgerEntry).toMatchObject({ status: "pending", releaseUnconfirmed: true, attempts: 1, deployedSha: "6a952b5e", idempotencyKey: "release:run_1788023523567_qdv9et:6a952b5e" });

    // Re-dispatch with a deploy_status that is NOT yet live, so the keyed re-call is actually reached.
    let polls = 0;
    const second = await runDeterministicReleaseExecutor({
      run: withLedger(run, first.ledgerEntry),
      deps: {
        callTool: (async (tool: string, args: Record<string, unknown>) => {
          if (tool === "deploy_status") {
            polls += 1;
            return { ok: true, projectId: "dr-lurie", tool, result: polls === 1 ? { deployStatus: "building" } : { deployStatus: "ready", productionConfirmed: true } };
          }
          return callTool(tool, args);
        }) as unknown as CallToolFn
      }
    });
    if (!second.ok || second.kind !== "completed") throw new Error("expected a completed outcome");
    expect(second.output.status).toBe("executed");
    expect(second.output.notes.join(" ")).toMatch(/replayed the original receipt/);
    expect(second.output.notes.join(" ")).toMatch(/SAME idempotency_key/);

    const keys = argsOf("release_to_production").map((args) => args.idempotency_key);
    expect(keys).toEqual(["release:run_1788023523567_qdv9et:6a952b5e", "release:run_1788023523567_qdv9et:6a952b5e"]);
    expect(calls.filter((tool) => tool === "release_to_production")).toHaveLength(2);
  });

  it("(b) a re-dispatch after a 504 polls deploy_status by commit FIRST and never re-calls when production is already live", async () => {
    const { callTool, calls, argsOf } = stubCallTool({
      release_to_production: () => new Error("MCP request failed with HTTP 504."),
      deploy_status: () => ({ deployStatus: "ready", productionConfirmed: true, deployId: "6a952b5e" })
    });
    const run = runWithReceipt({ commitSha: "6a952b5e" });
    const first = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    if (!first.ok || first.kind !== "pending") throw new Error("expected a pending outcome");

    const second = await runDeterministicReleaseExecutor({ run: withLedger(run, first.ledgerEntry), deps: { callTool } });
    if (!second.ok || second.kind !== "completed") throw new Error("expected a completed outcome");
    expect(second.output.status).toBe("executed");
    expect(second.output.releaseId).toBe("6a952b5e");
    expect(second.output.notes.join(" ")).toMatch(/NOT called again/);
    expect(argsOf("deploy_status")).toEqual([{ commit: "6a952b5e" }]);
    // release_to_production: the one 504'd call, and nothing after it.
    expect(calls).toEqual(["release_to_production", "deploy_status"]);
    expect(second.ledger).toBe("terminal");
  });

  it("(b) the persisted key wins over a re-derived one: a commitSha that appears later never changes the key already fired under", async () => {
    const { callTool, argsOf } = stubCallTool({
      release_to_production: () => ({ released: true, deployStatus: "ready", productionConfirmed: true })
    });
    const run = withLedger(runWithReceipt({ commitSha: "sha_resolved_late" }), {
      status: "pending",
      requestId: "req_release_20260825_01",
      performedAt: new Date().toISOString(),
      attempts: 1,
      releaseUnconfirmed: true,
      idempotencyKey: "release:run_1788023523567_qdv9et:page_bruxism_guide"
    });
    // No deployedSha on the entry and the receipt's commit is what the pre-poll would use; make it
    // not-ready so the keyed re-call is reached.
    const outcome = await runDeterministicReleaseExecutor({
      run,
      deps: {
        callTool: (async (tool: string, args: Record<string, unknown>) => {
          if (tool === "deploy_status") return { ok: true, projectId: "dr-lurie", tool, result: { deployStatus: "building" } };
          return callTool(tool, args);
        }) as unknown as CallToolFn
      }
    });
    expect(argsOf("release_to_production")[0]).toMatchObject({ idempotency_key: "release:run_1788023523567_qdv9et:page_bruxism_guide" });
    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.idempotencyKey).toBe("release:run_1788023523567_qdv9et:page_bruxism_guide");
  });

  it("an HTTP 504 delivered as a clean ok:false (projectMcpAdapter.callTool never throws) is unacknowledged, not a decline", async () => {
    const callTool: CallToolFn = (async (tool: string) => ({ ok: false, projectId: "dr-lurie", tool, error: "MCP request failed with HTTP 504.", httpStatus: 504 })) as unknown as CallToolFn;
    const outcome = await runDeterministicReleaseExecutor({ run: runWithReceipt({ commitSha: "6a952b5e" }), deps: { callTool } });
    if (!outcome.ok || outcome.kind !== "pending") throw new Error("expected a pending outcome");
    expect(outcome.ledgerEntry).toMatchObject({ status: "pending", releaseUnconfirmed: true, idempotencyKey: "release:run_1788023523567_qdv9et:6a952b5e" });
  });

  it("a 4xx / permission refusal is a decline (nothing fired): ledger none, blocked release_not_confirmed", async () => {
    const callTool: CallToolFn = (async (tool: string) => ({ ok: false, projectId: "dr-lurie", tool, error: "Tool requires approval before it can run: release_to_production", permission: "needs_approval", requiresApproval: true })) as unknown as CallToolFn;
    const outcome = await runDeterministicReleaseExecutor({ run: runWithReceipt({ commitSha: "6a952b5e" }), deps: { callTool } });
    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.reason).toBe("release_not_confirmed");
    expect(outcome.ledger).toBe("none");
  });

  it("repeated unacknowledged calls are bounded: at maxPollAttempts the run is handed over blocked, still pending-ledgered with the key", async () => {
    const { callTool, argsOf } = stubCallTool({
      release_to_production: () => new Error("MCP request failed with HTTP 504."),
      deploy_status: () => ({ deployStatus: "building" })
    });
    const run = runWithReceipt({ commitSha: "6a952b5e" });
    const first = await runDeterministicReleaseExecutor({ run, deps: { callTool, maxPollAttempts: 2 } });
    if (!first.ok || first.kind !== "pending") throw new Error("expected a pending outcome");
    const second = await runDeterministicReleaseExecutor({ run: withLedger(run, first.ledgerEntry), deps: { callTool, maxPollAttempts: 2 } });
    if (!second.ok || second.kind !== "completed") throw new Error("expected a completed outcome");
    expect(second.output.status).toBe("blocked");
    expect(second.output.reason).toBe("release_not_acknowledged_after_max_attempts");
    expect(second.ledger).toBe("pending");
    expect(second.ledgerEntry).toMatchObject({ status: "pending", releaseUnconfirmed: true, idempotencyKey: "release:run_1788023523567_qdv9et:6a952b5e" });
    expect(new Set(argsOf("release_to_production").map((args) => args.idempotency_key)).size).toBe(1);
    expect(validateOutput(second.output, getWorkspaceNode("release_executor")?.outputSchema).ok).toBe(true);
  });

  it("(c) every release call carries timeout_seconds, sized under this executor's own request window with the margin", async () => {
    const { callTool, argsOf } = stubCallTool({
      release_to_production: () => ({ released: true, deployStatus: "ready", productionConfirmed: true })
    });
    await runDeterministicReleaseExecutor({ run: runWithReceipt({ commitSha: "6a952b5e" }), deps: { callTool } });

    const args = argsOf("release_to_production")[0];
    expect(args.timeout_seconds).toBe(RELEASE_CALL_TIMEOUT_SECONDS);
    expect(Number.isInteger(args.timeout_seconds)).toBe(true);
    expect(args.timeout_seconds as number).toBeGreaterThan(0);
    // The relation the constant's comment promises: in-call wait + margin fits inside the 45s window
    // every real driver of this dispatch enforces (RUN_DRIVER_TIME_BUDGET_CEILING_MS).
    expect((RELEASE_CALL_TIMEOUT_SECONDS + RELEASE_CALL_TIMEOUT_MARGIN_SECONDS) * 1000).toBeLessThanOrEqual(RUN_DRIVER_TIME_BUDGET_CEILING_MS);
    expect(RELEASE_CALL_TIMEOUT_MARGIN_SECONDS).toBeGreaterThanOrEqual(5);
  });

  it("a pending entry written before W7 (no idempotencyKey, no releaseUnconfirmed) still only re-polls — never re-releases", async () => {
    const { callTool, calls } = stubCallTool({ deploy_status: () => ({ deployStatus: "ready", productionConfirmed: true }) });
    const run = withLedger(runWithReceipt({ commitSha: "6a952b5e" }), { status: "pending", requestId: "req_release_20260825_01", performedAt: new Date().toISOString(), releaseId: "deploy_pre_w7", attempts: 2 });
    const outcome = await runDeterministicReleaseExecutor({ run, deps: { callTool } });
    expect(calls).toEqual(["deploy_status"]);
    if (!outcome.ok || outcome.kind !== "completed") throw new Error("expected a completed outcome");
    expect(outcome.output.status).toBe("executed");
  });
});
