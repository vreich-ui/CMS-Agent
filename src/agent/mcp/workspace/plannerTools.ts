// `planner.*` — the MCP surface of `editorial_planner` (Track C, Wolf 2026-09-14).
//
// THREE VERBS, AND THE LINE BETWEEN THEM IS THE POINT:
//   * `planner.plan`       — reads everything, asks the model once, returns the plan. STARTS NOTHING.
//   * `planner.commission` — does the same and then STARTS the runs the plan authorized.
//   * `planner.status`     — reads only: today's counts, the halt state, the next eligible time.
//
// `plan` and `commission` build the plan by the SAME code path, so the preview an operator reads is
// the plan that will actually be spent — the alternative (a cheaper preview) is a preview that is
// wrong precisely when the inventory or the budget is close to a boundary, which is the only time
// anybody reads one.
//
// A dry `planner.plan` still costs one model turn (≤ $0.50). That is deliberate and it is the
// honest price of an honest preview; `planner.status` is the free call for "is this thing alive".
import { z } from "zod";

import { commissionForProject, planForProject, plannerStatus } from "../../planner/editorialPlanner.js";
import { objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";

const projectIdInput = z.object({ projectId: z.string().min(1) }).strict();
const projectIdJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1, description: "The project (tenant) to plan for, e.g. dr-lurie." } }, ["projectId"]);

const commissionInput = z
  .object({
    projectId: z.string().min(1),
    planId: z.string().min(1).optional(),
    max: z.number().int().min(0).max(10).optional()
  })
  .strict();

const commissionJsonSchema = objectSchema(
  {
    projectId: { type: "string", minLength: 1, description: "The project (tenant) to commission for." },
    planId: {
      type: "string",
      minLength: 1,
      description:
        "Optional: the planId from a planner.plan you just read. The plan is rebuilt from live data either way — this is a STALENESS GUARD, not a cache key: if the rebuilt plan has a different id (inventory or runs moved since you looked), nothing is started and the mismatch is reported. Omit to commission whatever the current plan says."
    },
    max: {
      type: "number",
      description:
        "Optional additional clamp on how many runs to start in THIS call, 0..10. Never raises the plan's own caps: max:5 against a plan holding one request starts one run. max:0 starts nothing (a dry commission)."
    }
  },
  ["projectId"]
);

export const createPlannerTools = (): WorkspaceTool[] => [
  tool({
    name: "planner.plan",
    description:
      "DRY. Build the commission plan for one tenant and return it, starting nothing. Reads the tenant's editorial_strategy.commissioning block, its published content_item inventory (object_list), its last 30 days of runs and costs, and its learning observations; asks the model ONCE (≤ $0.50, budget-guarded) for candidate briefs; then decides deterministically. Returns commission_plan.v1: {requests:[{requestId,contentSource,instructions,trafficSource,awarenessStage,rationale,dedupeKey}], rejected:[{topic,reason}], caps:{...}, halt?}. Every rejection is named (excluded / duplicate_of_published / duplicate_of_open_run / duplicate_in_plan / unknown_archetype / over_run_cap / over_budget / over_concurrency) and `caps` shows which ceiling bound, so an operator can see what to raise. A tenant with no commissioning block returns planned:false with the reason — that is normal, not an error. Works on a tenant whose commissioning is DISABLED: planning is how you see what would happen before switching it on.",
    zodSchema: projectIdInput,
    inputSchema: projectIdJsonSchema,
    execute: async (input) => ok(await planForProject(projectIdInput.parse(input).projectId))
  }),
  tool({
    name: "planner.commission",
    description:
      "LIVE. Build the same plan as planner.plan and START the runs it authorized, each stamped commissionedBy:\"editorial_planner\" with its rationale, through the ordinary workflow.start_dry_run + kick path (never a private starter) — so a commissioned run passes every gate an asked run does, including the project's requestId grammar and the publish approval policy. REFUSES to start anything when the tenant's commissioning.enabled is false, or when the planner has halted on consecutive failures (the response then carries a blockage.v1 planner_halted with revise-strategy / resume remedies). Records one learning observation per commissioned run. Returns the plan plus `commissioned:[{requestId,runId,started,error?}]`.",
    zodSchema: commissionInput,
    inputSchema: commissionJsonSchema,
    execute: async (input) => {
      const data = commissionInput.parse(input);
      return ok(
        await commissionForProject(data.projectId, {
          ...(data.planId ? { planId: data.planId } : {}),
          ...(data.max !== undefined ? { max: data.max } : {})
        })
      );
    }
  }),
  tool({
    name: "planner.status",
    description:
      "Free and read-only: what commissioning is doing for one tenant right now. Returns {enabled, configured, runsToday, runsPerDay, spentTodayUsd, dailyBudgetUsd, openRuns, maxConcurrentRuns, consecutiveFailures, halted, nextEligibleAt, runFactsRead}. runsToday/runsPerDay/spentTodayUsd/dailyBudgetUsd/openRuns/maxConcurrentRuns/consecutiveFailures and halted are all `number|null`/`boolean|null`: they are null, and nextEligibleAt is \"unknown\", whenever runFactsRead is \"failed\" — the run-history store could not be read. A null there means the store could not be read, never that nothing has run; do not treat it as zero. Otherwise nextEligibleAt is \"blocked\" when the planner has halted — it is waiting on a person, not on a clock — otherwise now (a slot is free) or the next UTC midnight. No model turn, so this is the call to poll.",
    zodSchema: projectIdInput,
    inputSchema: projectIdJsonSchema,
    execute: async (input) => ok(await plannerStatus(projectIdInput.parse(input).projectId))
  })
];
