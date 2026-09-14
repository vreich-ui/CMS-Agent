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
  ...over
});

beforeEach(async () => {
  projectRepository = new MemoryProjectRepository();
  executionRepository = new MemoryExecutionRepository();
  usageRepository = new MemoryUsageRepository();
  workspaceRepository = new MemoryWorkspaceRepository();
  learningRepository = new MemoryLearningRepository(workspaceRepository);
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
