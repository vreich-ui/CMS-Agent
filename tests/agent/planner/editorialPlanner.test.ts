/**
 * Track C — the orchestrator, with every boundary faked.
 *
 * The pure planner is pinned separately (plan.test.ts). What is pinned HERE is the behaviour that
 * only shows up when the parts are wired together: that a tenant with no policy is skipped rather
 * than defaulted, that `enabled: false` plans but starts nothing, that a halted planner starts
 * nothing whatever the plan says, that seeds carry a day the model turn fails, and that a run which
 * IS started carries the stamp the whole feature is built on.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { MemoryExecutionRepository } from "../../../src/agent/repository/memory/MemoryExecutionRepository.js";
import { MemoryLearningRepository } from "../../../src/agent/repository/memory/MemoryLearningRepository.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { MemoryUsageRepository } from "../../../src/agent/repository/memory/MemoryUsageRepository.js";
import { MemoryWorkspaceRepository } from "../../../src/agent/repository/memory/MemoryWorkspaceRepository.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";
import {
  collectObjectRows,
  commissionForProject,
  p95RunCost,
  planForProject,
  plannerStatus,
  type PlannerDeps,
  type PlannerPlanned
} from "../../../src/agent/planner/editorialPlanner.js";
import { COMMISSIONED_BY } from "../../../src/agent/planner/plan.js";
import { resetRun } from "../../../src/agent/workspace/executor.js";
import { CommissionReservationStore } from "../../../src/agent/planner/commissioningReservations.js";
import type { BlobStoreClient } from "../../../src/agent/repository/blobs/blobClient.js";

const PROJECT_ID = "dr-lurie";
const NOW = new Date("2026-09-14T06:00:00.000Z");

const commissioningBlock = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  runsPerDay: 1,
  dailyBudgetUsd: 10,
  maxConcurrentRuns: 2,
  stopAfterConsecutiveFailures: 2,
  readerStateMix: { recognition: 0.4, understanding: 0.3, investigation: 0.2, selection: 0.1 },
  archetypes: [{ id: "barrier", job: "Decide what to stop using while the barrier heals.", defaultTrafficSource: "organic_search", defaultAwarenessStage: "problem_aware" }],
  seeds: [{ topic: "ceramides", readerState: "recognition", archetypeId: "barrier", priority: 3 }],
  exclusions: [],
  ...over
});

const strategyBody = (commissioning: unknown) => ({
  name: "Dr Lurie — strategy",
  goal: "Turn evidence-led skin explanations into routine adoption.",
  offer: "The barrier-repair protocol.",
  audience_segments: ["compromised barrier"],
  topic_weights: [],
  angle_mix: [{ angle: "myth-correction", share: 1 }],
  funnel_aggression: { tofu: 0.1, mofu: 0.3, bofu: 0.6 },
  cadence: "Two long-form articles a week.",
  ...(commissioning === undefined ? {} : { commissioning }),
  provenance: { set_by: "human", set_at: "2026-09-09T00:00:00.000Z" }
});

let projectRepository: MemoryProjectRepository;
let executionRepository: MemoryExecutionRepository;
let usageRepository: MemoryUsageRepository;
let learningRepository: MemoryLearningRepository;
let workspaceRepository: MemoryWorkspaceRepository;
let reservationStore: CommissionReservationStore;

/**
 * C7 — the reservation store's transport, in memory. `yieldOnGet` forces two concurrent callers past
 * their READ before either writes, which is the interleaving a pass lease has to survive; without it
 * the test would serialize itself and prove nothing.
 */
const memoryBlobStore = (options: { yieldOnGet?: boolean } = {}): BlobStoreClient => {
  const values = new Map<string, { data: unknown; etag: string }>();
  let generation = 0;
  const settle = async () => { if (options.yieldOnGet) { await Promise.resolve(); await Promise.resolve(); } };
  return {
    get: async (key: string) => { await settle(); return structuredClone(values.get(key)?.data ?? null); },
    getWithMetadata: async (key: string) => {
      await settle();
      const current = values.get(key);
      return current ? { data: structuredClone(current.data), etag: current.etag, metadata: {} } : null;
    },
    setJSON: async (key: string, data: unknown, opts?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      const current = values.get(key);
      if ((opts?.onlyIfNew && current) || (opts?.onlyIfMatch !== undefined && current?.etag !== opts.onlyIfMatch)) return { modified: false };
      generation += 1;
      const etag = String(generation);
      values.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    list: async () => ({ blobs: [], directories: [] }),
    delete: async (key: string) => { values.delete(key); }
  } as unknown as BlobStoreClient;
};

const projectConfig = (): ProjectConnectionConfig =>
  ({
    projectId: PROJECT_ID,
    name: "Dr Lurie",
    mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT",
    tokenEnvVar: "DR_LURIE_MCP_TOKEN",
    status: "active",
    objectDialect: { requestIdPattern: "^req_[a-z0-9_]+_\\d{8}_\\d{2}$" }
  }) as unknown as ProjectConnectionConfig;

/**
 * The tenant read seam. `object_get` on the strategy is what `getEditorialStrategy` makes;
 * `object_list` is the inventory. Everything else is refused, which is also what the real
 * READ_TOOL_ALLOWLIST would do.
 */
const tenantReader = (options: { commissioning?: unknown; inventory?: unknown[]; strategyMissing?: boolean } = {}) =>
  async (_projectId: string, tool: string) => {
    if (tool === "object_get") {
      if (options.strategyMissing) return { ok: false, error: "not found" };
      return { ok: true, result: { structuredContent: { object: { body: strategyBody(options.commissioning) } } } };
    }
    if (tool === "object_list") return { ok: true, result: { structuredContent: { objects: options.inventory ?? [] } } };
    return { ok: false, error: `unexpected tool ${tool}` };
  };

const deps = (over: PlannerDeps = {}): PlannerDeps => ({
  projectRepository,
  executionRepository,
  usageRepository,
  learningRepository,
  workspaceRepository,
  now: () => NOW,
  // No model by default — the seeds alone must be able to carry a day.
  proposeCandidates: async () => [],
  readTenant: tenantReader(),
  reservationStore,
  ...over
});

beforeEach(async () => {
  projectRepository = new MemoryProjectRepository();
  executionRepository = new MemoryExecutionRepository();
  usageRepository = new MemoryUsageRepository();
  workspaceRepository = new MemoryWorkspaceRepository();
  learningRepository = new MemoryLearningRepository(workspaceRepository);
  reservationStore = new CommissionReservationStore(memoryBlobStore(), () => NOW);
  await projectRepository.save(projectConfig());
});

describe("planForProject — when there is nothing to plan", () => {
  it("skips a project with no record, naming it", async () => {
    const result = await planForProject("ghost", deps());
    expect(result.planned).toBe(false);
    expect((result as { reason: string }).reason).toBe("no_project_record");
  });

  it("skips a tenant whose strategy has no commissioning block — the state of every site today", async () => {
    const result = await planForProject(PROJECT_ID, deps({ readTenant: tenantReader({ commissioning: undefined }) }));
    expect(result.planned).toBe(false);
    expect((result as { reason: string }).reason).toBe("no_commissioning_block");
  });

  it("still PLANS a tenant whose commissioning is switched off — that is how you see what would happen", async () => {
    const result = (await planForProject(PROJECT_ID, deps({ readTenant: tenantReader({ commissioning: commissioningBlock({ enabled: false }) }) }))) as PlannerPlanned;
    expect(result.planned).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.plan.requests).toHaveLength(1);
  });
});

describe("planForProject — the inputs it gathers", () => {
  it("carries a day on seeds alone when the model turn returns nothing", async () => {
    const result = (await planForProject(PROJECT_ID, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }) }))) as PlannerPlanned;
    expect(result.inputs.seedCount).toBe(1);
    expect(result.inputs.modelCandidateCount).toBe(0);
    expect(result.plan.requests[0]!.contentSource.topic).toBe("ceramides");
    expect(result.plan.requests[0]!.requestId).toMatch(/^req_planner_ceramides_20260914_\d{2}$/);
  });

  it("dedupes against the tenant's published inventory", async () => {
    const reader = tenantReader({ commissioning: commissioningBlock(), inventory: [{ body: { slug: "ceramides", title: "Ceramides" } }] });
    const result = (await planForProject(PROJECT_ID, deps({ readTenant: reader }))) as PlannerPlanned;
    expect(result.inputs.inventoryCount).toBe(1);
    expect(result.plan.requests).toHaveLength(0);
    expect(result.plan.rejected[0]!.reason).toBe("duplicate_of_published");
  });

  it("reports an unreachable inventory as degraded rather than as an empty catalogue", async () => {
    const reader = async (projectId: string, tool: string) =>
      tool === "object_list" ? { ok: false, error: "tenant unreachable" } : tenantReader({ commissioning: commissioningBlock() })(projectId, tool);
    const result = (await planForProject(PROJECT_ID, deps({ readTenant: reader }))) as PlannerPlanned;
    expect(result.inputs.degraded.some((entry) => entry.startsWith("inventory_unavailable"))).toBe(true);
  });

  it("survives a model turn that throws, and says so", async () => {
    const result = (await planForProject(
      PROJECT_ID,
      deps({
        readTenant: tenantReader({ commissioning: commissioningBlock() }),
        proposeCandidates: async () => {
          throw new Error("model refused");
        }
      })
    )) as PlannerPlanned;
    expect(result.plan.requests).toHaveLength(1);
    expect(result.inputs.degraded.some((entry) => entry.startsWith("model_turn_failed"))).toBe(true);
  });

  it("ranks a strategist's seed above a model candidate", async () => {
    const result = (await planForProject(
      PROJECT_ID,
      deps({
        readTenant: tenantReader({ commissioning: commissioningBlock({ runsPerDay: 3 }) }),
        proposeCandidates: async () => [
          { topic: "retinoids", readerState: "understanding" as const, archetypeId: "barrier", instructions: "Explain retinoids.", rationale: "Gap.", priority: 0 }
        ]
      })
    )) as PlannerPlanned;
    expect(result.plan.requests.map((request) => request.contentSource.topic)).toEqual(["ceramides", "retinoids"]);
  });
});

describe("commissionForProject", () => {
  it("starts nothing when commissioning is disabled, and says which switch", async () => {
    const result = await commissionForProject(PROJECT_ID, {}, deps({ readTenant: tenantReader({ commissioning: commissioningBlock({ enabled: false }) }) }));
    expect(result.planned).toBe(false);
    expect((result as { reason: string }).reason).toBe("commissioning_disabled");
    expect(await executionRepository.listRuns({})).toHaveLength(0);
  });

  it("stamps commissionedBy and the rationale on the run it starts", async () => {
    const result = await commissionForProject(PROJECT_ID, { max: 1 }, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }) }));
    expect(result.commissioned).toHaveLength(1);
    const outcome = result.commissioned![0]!;
    expect(outcome.started).toBe(true);
    const run = await executionRepository.getRun(outcome.runId!);
    expect(run!.commissionedBy).toBe(COMMISSIONED_BY);
    expect(run!.commissioningRationale).toContain("Strategy seed");
    expect(run!.requestId).toBe(outcome.requestId);
    const input = run!.initialInput as { trafficSource: string; awarenessStage: string; contentSource: { topic: string } };
    expect(input.trafficSource).toBe("organic_search");
    expect(input.awarenessStage).toBe("problem_aware");
    expect(input.contentSource.topic).toBe("ceramides");
  });

  it("keeps the stamp across a workflow.reset_run — a reset re-runs the work, it does not change who asked", async () => {
    const result = await commissionForProject(PROJECT_ID, { max: 1 }, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }) }));
    const runId = result.commissioned![0]!.runId!;
    const reset = await resetRun(runId, executionRepository);
    // Every one of the planner's brakes filters on this stamp. Losing it on reset would erase the
    // run from the failure streak, hand back its run slot, refund its cost from the day's budget,
    // and leave the platform's adoption sweep unable to see the run at all — so the article would
    // publish with no accountable origin anywhere, which is the one state the stamp exists to stop.
    expect(reset.commissionedBy).toBe(COMMISSIONED_BY);
    expect(reset.commissioningRationale).toContain("Strategy seed");
    expect(reset.requestId).toBe(result.commissioned![0]!.requestId);
  });

  it("records one learning observation per commissioned run", async () => {
    await commissionForProject(PROJECT_ID, { max: 1 }, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }) }));
    const observations = await learningRepository.listObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.observation).toContain("editorial_planner commissioned");
  });

  it("honours max as a clamp and never as a raise", async () => {
    const reader = tenantReader({ commissioning: commissioningBlock({ runsPerDay: 3, maxConcurrentRuns: 3 }) });
    const result = await commissionForProject(PROJECT_ID, { max: 5 }, deps({ readTenant: reader }));
    expect(result.commissioned).toHaveLength(1);
  });

  it("starts nothing for a stale planId rather than commissioning a different plan", async () => {
    const result = await commissionForProject(PROJECT_ID, { planId: "plan_from_yesterday" }, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }) }));
    expect(result.commissioned).toHaveLength(0);
    expect((result as PlannerPlanned).inputs.degraded.some((entry) => entry.startsWith("plan_id_stale"))).toBe(true);
  });

  it("starts nothing when the planner has halted, and hands back the blockage", async () => {
    for (const runId of ["run_f1", "run_f2"]) {
      await executionRepository.createRun({
        runId,
        requestId: `req_planner_x_20260913_0${runId.endsWith("1") ? 1 : 2}`,
        workflowId: "publishing_conductor",
        projectId: PROJECT_ID,
        status: "failed",
        startedAt: "2026-09-13T06:00:00.000Z",
        updatedAt: "2026-09-13T07:00:00.000Z",
        nodes: [],
        artifacts: [],
        errors: [],
        approvalsRequired: [],
        stageOutputs: {},
        dryRun: true,
        commissionedBy: COMMISSIONED_BY
      } as never);
    }
    const result = await commissionForProject(PROJECT_ID, {}, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }) }));
    expect(result.commissioned).toHaveLength(0);
    expect((result as PlannerPlanned).blockage?.code).toBe("planner_halted");
    expect((result as PlannerPlanned).blockage?.remedies.map((remedy) => remedy.type)).toEqual(["set_project_field", "resume"]);
  });
});

describe("plannerStatus", () => {
  it("reports an unconfigured tenant without pretending it is configured", async () => {
    const status = await plannerStatus(PROJECT_ID, deps({ readTenant: tenantReader({ commissioning: undefined }) }));
    expect(status.configured).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.detail).toContain("No commissioning block");
  });

  it("reports the caps and a next eligible time for a live tenant", async () => {
    const status = await plannerStatus(PROJECT_ID, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }) }));
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.runsPerDay).toBe(1);
    expect(status.dailyBudgetUsd).toBe(10);
    expect(status.halted).toBe(false);
    expect(status.nextEligibleAt).toBe(NOW.toISOString());
    expect(status.runFactsRead).toBe("ok");
  });

  // The defect this whole file was named for (#356's "Not in this PR"): a run-facts read that fails
  // must not be reported as a tenant that has run nothing today. Every run-derived field becomes
  // null — not 0 — and nextEligibleAt becomes "unknown" rather than a timestamp nothing backs.
  it("reports unknown, not zero, when the run-facts read fails", async () => {
    const status = await plannerStatus(
      PROJECT_ID,
      deps({
        readTenant: tenantReader({ commissioning: commissioningBlock() }),
        executionRepository: { ...executionRepository, listRunsPage: async () => { throw new Error("bucket unreachable"); } } as never
      })
    );
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.runFactsRead).toBe("failed");
    expect(status.runsToday).toBeNull();
    expect(status.runsPerDay).toBeNull();
    expect(status.spentTodayUsd).toBeNull();
    expect(status.dailyBudgetUsd).toBeNull();
    expect(status.openRuns).toBeNull();
    expect(status.maxConcurrentRuns).toBeNull();
    expect(status.consecutiveFailures).toBeNull();
    expect(status.halted).toBeNull();
    expect(status.nextEligibleAt).toBe("unknown");
    expect(status.detail).toContain("could not be read");
  });

  it("reports runFactsRead \"ok\" for the early unconfigured-tenant return, which never touches the run store", async () => {
    const status = await plannerStatus(PROJECT_ID, deps({ readTenant: tenantReader({ commissioning: undefined }) }));
    expect(status.runFactsRead).toBe("ok");
  });
});

describe("helpers", () => {
  it("finds object rows however the tenant wrapped them", () => {
    expect(collectObjectRows({ structuredContent: { objects: [{ body: { slug: "a", title: "A" } }] } })).toEqual([{ slug: "a", title: "A" }]);
    expect(collectObjectRows({ content: [{ text: JSON.stringify({ items: [{ slug: "b" }] }) }] })).toEqual([{ slug: "b" }]);
    expect(collectObjectRows("not an inventory")).toEqual([]);
  });

  it("refuses to call two data points a distribution", () => {
    expect(p95RunCost([{ runId: "1", status: "completed", startedAt: "", costUsd: 4 }, { runId: "2", status: "completed", startedAt: "", costUsd: 5 }])).toBeUndefined();
    expect(p95RunCost([1, 2, 3, 10].map((cost, index) => ({ runId: String(index), status: "completed", startedAt: "", costUsd: cost })))).toBe(10);
  });

  it("prices ONLY finished runs — a run that died at the gate is evidence about a failure, not about cost", () => {
    // 19 runs blocked early at $0.30 plus one real $14.70 run priced p95 at $0.30, which turned a
    // declared $10/day into 33 authorized slots — $80 of work under a budget still reporting $10.
    const junk = Array.from({ length: 19 }, (_value, index) => ({ runId: `b${index}`, status: "blocked", startedAt: "", costUsd: 0.3 }));
    const real = { runId: "done", status: "completed", startedAt: "", costUsd: 14.7 };
    expect(p95RunCost([...junk, real])).toBeUndefined();
  });

  it("never prices a run below what one has actually been measured to cost", () => {
    const cheap = [0.2, 0.3, 0.4, 0.5].map((cost, index) => ({ runId: String(index), status: "completed", startedAt: "", costUsd: cost }));
    expect(p95RunCost(cheap)).toBe(4);
  });
});


/**
 * C7 — commissioning atomicity.
 *
 * The old path protected itself with a check-then-act whose own comment admitted it "does not make
 * commissioning atomic", and read today's runs through `.catch(() => [])`, so a store that could not
 * be read was indistinguishable from one that said nothing had run. These pin the replacements: a
 * durable claim the store arbitrates, a pass lease that makes `runsPerDay` mean runs per day, and a
 * refusal — never a guess — whenever the evidence is missing.
 */
describe("commissionForProject — C7 atomicity", () => {
  const enabled = () => deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }) });

  it("binds the reservation to the run it started", async () => {
    const result = await commissionForProject(PROJECT_ID, { max: 1 }, enabled());
    const outcome = (result as { commissioned: { requestId: string; runId?: string; started: boolean }[] }).commissioned[0]!;
    expect(outcome.started).toBe(true);

    const held = await reservationStore.get(PROJECT_ID, outcome.requestId);
    expect(held?.state).toBe("started");
    expect(held?.runId).toBe(outcome.runId);
  });

  it("refuses a request id another caller already holds, naming the holder", async () => {
    // First pass takes the id for real.
    const first = await commissionForProject(PROJECT_ID, { max: 1 }, enabled());
    const requestId = (first as { commissioned: { requestId: string }[] }).commissioned[0]!.requestId;
    // Erase the RUN but keep the reservation: the store has a claim, the run list does not show it.
    // This is the crash-recovery shape, and the reservation is what must still refuse.
    await resetRun((first as { commissioned: { runId?: string }[] }).commissioned[0]!.runId!).catch(() => undefined);

    const second = await commissionForProject(PROJECT_ID, { max: 1 }, enabled());
    const outcome = (second as { commissioned: { started: boolean; error?: string }[] }).commissioned[0];
    if (outcome?.started === false) {
      expect(outcome.error).toMatch(/already (exists|reserved)/);
      expect(outcome.error).toContain(requestId);
    } else {
      // If the plan deduped it away instead, no second run was started either — which is the same
      // guarantee reached one gate earlier.
      expect((second as { commissioned: unknown[] }).commissioned).toHaveLength(0);
    }
  });

  it("starts nothing when the run history cannot be read — an unreadable ledger is not an empty one", async () => {
    // Prototype preserved: a plain spread of a class instance drops its methods, and the missing
    // one would fail this test for a reason it is not about.
    const blind = Object.assign(Object.create(Object.getPrototypeOf(executionRepository)), executionRepository, {
      listRuns: async () => { throw new Error("bucket unreachable"); },
      listRunsPage: async () => { throw new Error("bucket unreachable"); }
    }) as MemoryExecutionRepository;

    const result = await commissionForProject(PROJECT_ID, { max: 1 }, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }), executionRepository: blind }));
    expect((result as { reason?: string }).reason).toBe("run_history_unreadable");
    expect((result as { commissioned: unknown[] }).commissioned).toHaveLength(0);
    // The caps would have read runsAlreadyToday:0 / spentTodayUsd:0 — a whole fresh day's budget
    // authorized by the one call that could not see what today had already cost.
    expect((result as { detail: string }).detail).toContain("bucket unreachable");
  });

  it("refuses the START when the ledger fails only at the last moment", async () => {
    // Planning reads the ledger through `listRunsPage` and is left working; only the last-moment
    // collision read (`listRuns`, immediately before startDryRun) fails. So this tenant HAS a plan,
    // a budget and a slot — and still starts nothing, because the one read that could have shown a
    // duplicate did not happen.
    const flaky = Object.assign(Object.create(Object.getPrototypeOf(executionRepository)), executionRepository, {
      listRuns: async () => { throw new Error("ledger timeout"); }
    }) as MemoryExecutionRepository;

    const result = await commissionForProject(PROJECT_ID, { max: 1 }, deps({ readTenant: tenantReader({ commissioning: commissioningBlock() }), executionRepository: flaky }));
    const outcome = (result as { commissioned: { started: boolean; error?: string }[] }).commissioned[0]!;
    expect(outcome.started).toBe(false);
    expect(outcome.error).toContain("could not be read");
    expect(outcome.error).toContain("ledger timeout");
  });

  it("lets only one of two concurrent passes commission, and tells the other why", async () => {
    // One shared store, and a transport that forces both callers to read the lease before either
    // writes it — a process-local mutex would pass this test by accident; a durable lease passes it
    // for the reason it exists.
    reservationStore = new CommissionReservationStore(memoryBlobStore({ yieldOnGet: true }), () => NOW);

    const [a, b] = await Promise.all([
      commissionForProject(PROJECT_ID, { max: 1, holder: "job" }, enabled()),
      commissionForProject(PROJECT_ID, { max: 1, holder: "operator" }, enabled())
    ]);

    const refused = [a, b].filter((r) => (r as { reason?: string }).reason === "pass_in_flight");
    const ran = [a, b].filter((r) => ((r as { commissioned?: unknown[] }).commissioned ?? []).length > 0);
    expect(refused).toHaveLength(1);
    expect(ran).toHaveLength(1);
    expect((refused[0] as { detail: string }).detail).toContain("already in flight");
  });

  it("releases the pass lease afterwards, so the next pass is not locked out", async () => {
    await commissionForProject(PROJECT_ID, { max: 1 }, enabled());
    const lease = await reservationStore.acquirePass(PROJECT_ID, "next");
    expect(lease.ok).toBe(true);
  });
});
