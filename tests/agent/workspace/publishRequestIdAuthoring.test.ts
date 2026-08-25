import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { conductorCache } from "../../../src/agent/workspace/conductor.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { AUTHORED_PUBLISH_REQUEST_ID_FLOW, mintPublishRequestId, slugifyTopic } from "../../../src/agent/workspace/publishRequestId.js";
import { buildRunContext } from "../../../src/agent/workspace/runContext.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";

// T4 (autonomous-publish) — a TEXT-ONLY run could not publish, structurally.
//
// The publish request id is authored by exactly one node, artifact_plan. artifact_plan carries the
// skip predicate {when: "no_media_slots"}, and a skipped node writes no stage output by construction.
// So the moment that predicate fired, the run lost its only source for the id — and said nothing,
// until publish_executor refused with publish_request_id_absent after a passed controller, a recorded
// operator approval, and five green publisher gates.
//
// The fix authors an id at skip time. These tests lock what it must and must not do.

const seedTo = async (store: ExecutionRepository, target: string, options: { input?: unknown; publishRequestId?: string } = {}) => {
  const started = await startDryRun({
    executionMode: "mock",
    projectId: "dr-lurie",
    input: options.input ?? { topic: "Retinoid tolerance", noMedia: true }
  }, store);
  const run = (await getRun(started.runId, store))!;
  // workflow.start_dry_run validates and stores this before the run exists (resolvePublishRequestId,
  // mcp/workspace/tools.ts); set it on the record directly so this test exercises the executor's
  // guard rather than re-testing the tool layer's validation.
  if (options.publishRequestId) run.publishRequestId = options.publishRequestId;
  const index = run.nodes.findIndex((node) => node.nodeId === target);
  for (const state of run.nodes.slice(0, index)) {
    const output = mockOutputForNode(getWorkspaceNode(state.nodeId)!, run);
    state.status = "completed";
    state.output = output;
    run.stageOutputs[state.nodeId] = output;
  }
  await store.saveRun(run);
  return started.runId;
};

describe("mintPublishRequestId", () => {
  it("mints an id matching the project's own declared pattern", () => {
    const minted = mintPublishRequestId({ runId: "run_1787658091131_cv41es", initialInput: { topic: "Retinoid tolerance" }, config: drLurieProjectConfig, now: new Date("2026-08-25T09:00:00Z") });

    expect(minted.ok).toBe(true);
    if (minted.ok) {
      expect(minted.requestId).toMatch(new RegExp(drLurieProjectConfig.objectDialect!.requestIdPattern!));
      // Self-identifying: an id this engine authored is distinguishable from an operator's at a glance,
      // in the client's records as well as ours.
      expect(minted.requestId.startsWith(`req_${AUTHORED_PUBLISH_REQUEST_ID_FLOW}_`)).toBe(true);
      expect(minted.requestId).toContain("retinoid_tolerance");
      expect(minted.requestId).toContain("20260825");
    }
  });

  it("mints distinct ids for two runs on the same topic and the same day", () => {
    const at = new Date("2026-08-25T09:00:00Z");
    const first = mintPublishRequestId({ runId: "run_1787658091131_cv41es", initialInput: "Retinoid tolerance", config: drLurieProjectConfig, now: at });
    const second = mintPublishRequestId({ runId: "run_1787658091999_zz09qq", initialInput: "Retinoid tolerance", config: drLurieProjectConfig, now: at });

    expect(first.ok && second.ok).toBe(true);
    // A publish id reaches the client's own records; a collision there is not cosmetic.
    if (first.ok && second.ok) expect(first.requestId).not.toBe(second.requestId);
  });

  it("still mints a valid id when the run's input yields no usable topic", () => {
    const minted = mintPublishRequestId({ runId: "run_1787658091131_cv41es", initialInput: { unexpected: 42 }, config: drLurieProjectConfig, now: new Date("2026-08-25T09:00:00Z") });
    expect(minted.ok).toBe(true);
    if (minted.ok) expect(minted.requestId).toMatch(new RegExp(drLurieProjectConfig.objectDialect!.requestIdPattern!));
  });

  it("refuses rather than returning an id a project's pattern would reject", () => {
    const minted = mintPublishRequestId({
      runId: "run_x",
      initialInput: "anything",
      config: { objectDialect: { ...drLurieProjectConfig.objectDialect!, requestIdPattern: "^PUB-[0-9]{4}$" } } as never,
      now: new Date("2026-08-25T09:00:00Z")
    });
    // Publishing under an identifier the client's contract does not recognise is worse than not
    // publishing, so the pre-existing publish_request_id_absent refusal is left to stand.
    expect(minted.ok).toBe(false);
  });

  it("slugifies to the id alphabet and never leaves a trailing separator", () => {
    expect(slugifyTopic("Retinoid Tolerance: A Guide!")).toBe("retinoid_tolerance_a_guide");
    expect(slugifyTopic("   ")).toBe("");
  });
});

describe("T4 acceptance — a text-only run reaches the executor with a publish id", () => {
  beforeEach(() => { conductorCache.clear(); repositoryManager.getUsageRepository().clear(); });
  afterEach(() => { conductorCache.clear(); vi.unstubAllGlobals(); });

  it("authors the id at the moment artifact_plan skips on no_media_slots", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await seedTo(store, "artifact_plan");

    await runNextNode(runId, { executionRepository: store });
    const run = (await getRun(runId, store))!;
    const state = run.nodes.find((node) => node.nodeId === "artifact_plan")!;

    expect(state.status).toBe("skipped");
    expect(state.skip?.predicate).toMatchObject({ when: "no_media_slots" });
    expect(run.publishRequestId).toBeTruthy();
    expect(run.publishRequestId).toMatch(new RegExp(drLurieProjectConfig.objectDialect!.requestIdPattern!));
    // Legible from workflow.get_run without opening the node: the run says, at the point it happens,
    // that the conductor authored the id its skipped author would have.
    expect(state.warnings).toContainEqual(expect.stringContaining(`publish_request_id_authored:${run.publishRequestId}`));
  });

  it("carries the authored id into run context, which is the one lift point downstream reads", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await seedTo(store, "artifact_plan");
    await runNextNode(runId, { executionRepository: store });
    const run = (await getRun(runId, store))!;

    // publish_payload's deterministic builder and publish_executor's engine path both read
    // runContext.requestId; nothing downstream needs to know the field exists.
    const context = buildRunContext({ clientProjectId: run.projectId, stageOutputs: run.stageOutputs, publishRequestId: run.publishRequestId });
    expect(context.requestId).toBe(run.publishRequestId);
  });

  it("never overwrites an operator-supplied id", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const operatorId = "req_launch_retinoid_tolerance_20260825_07";
    const runId = await seedTo(store, "artifact_plan", { publishRequestId: operatorId });

    await runNextNode(runId, { executionRepository: store });
    const run = (await getRun(runId, store))!;

    expect(run.publishRequestId).toBe(operatorId);
    expect((run.nodes.find((node) => node.nodeId === "artifact_plan")!.warnings ?? []).some((warning) => warning.startsWith("publish_request_id_authored"))).toBe(false);
  });

  it("leaves precedence alone: an artifact_plan that really ran still wins", () => {
    // The authored id lives on run.publishRequestId, which buildRunContext reads BEHIND
    // stageOutputs.artifact_plan.requestId. A run whose plan really ran publishes under its id, full stop.
    const context = buildRunContext({
      clientProjectId: "dr-lurie",
      stageOutputs: { artifact_plan: { requestId: "req_launch_real_plan_20260825_01" } },
      publishRequestId: "req_conductor_fallback_abc123_20260825_01"
    });
    expect(context.requestId).toBe("req_launch_real_plan_20260825_01");
  });

  it("does not author for a node skipped by any other predicate", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    // A run that DOES declare media: artifact_plan runs rather than skipping, so nothing is authored.
    const runId = await seedTo(store, "artifact_plan", { input: { topic: "Retinoid tolerance", mediaSlots: [{ slot: "hero" }] } });

    await runNextNode(runId, { executionRepository: store });
    const run = (await getRun(runId, store))!;
    const state = run.nodes.find((node) => node.nodeId === "artifact_plan")!;

    expect(state.status).not.toBe("skipped");
    expect(run.publishRequestId).toBeUndefined();
  });
});
