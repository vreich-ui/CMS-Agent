/**
 * Track C — the planner's deterministic half, where every runaway lives or dies.
 *
 * These are the tests that stand between a scheduled job and a bill: if the caps are wrong nobody
 * finds out until a day's budget is gone, and if the dedupe is wrong the site publishes the same
 * article twice and splits its own ranking. So each gate is pinned separately, with the money
 * numbers spelled out rather than derived.
 */
import { describe, expect, it } from "vitest";

import { COMMISSIONING_DEFAULTS, type Commissioning } from "../../../src/agent/planner/commissioningTypes.js";
import {
  COMMISSIONED_BY,
  MEASURED_RUN_COST_USD,
  requestTopicSlug,
  type CandidateBrief,
  type RunFact,
  buildCommissionPlan,
  consecutiveCommissionedFailures,
  dedupeKeyOf,
  mintRequestId,
  plannerHaltBlockage,
  seedCandidates
} from "../../../src/agent/planner/plan.js";

const NOW = new Date("2026-09-14T06:00:00.000Z");
const PATTERN = "^req_[a-z0-9_]+_\\d{8}_\\d{2}$";

const commissioning = (over: Partial<Commissioning> = {}): Commissioning => ({
  enabled: true,
  runsPerDay: 2,
  dailyBudgetUsd: 10,
  maxConcurrentRuns: 1,
  stopAfterConsecutiveFailures: 2,
  readerStateMix: { ...COMMISSIONING_DEFAULTS.readerStateMix },
  archetypes: [{ id: "barrier", job: "Decide what to stop using while the barrier heals.", defaultTrafficSource: "organic_search", defaultAwarenessStage: "problem_aware" }],
  seeds: [],
  exclusions: [],
  ...over
});

const candidate = (topic: string, over: Partial<CandidateBrief> = {}): CandidateBrief => ({
  topic,
  readerState: "recognition",
  archetypeId: "barrier",
  instructions: `Explain ${topic}.`,
  rationale: `Nothing on the site covers ${topic}.`,
  priority: 1,
  ...over
});

const plan = (over: Partial<Parameters<typeof buildCommissionPlan>[0]> = {}) =>
  buildCommissionPlan({
    projectId: "dr-lurie",
    commissioning: commissioning(),
    candidates: [candidate("ceramides")],
    inventory: [],
    recentRuns: [],
    requestIdPattern: PATTERN,
    now: NOW,
    planId: "plan_test",
    ...over
  });

describe("dedupeKeyOf — what counts as the same article", () => {
  it("matches a headline against the slug it would produce", () => {
    expect(dedupeKeyOf("Ceramides, Explained")).toBe(dedupeKeyOf("ceramides-explained"));
  });
  it("strips the filler a headline adds and a slug does not", () => {
    expect(dedupeKeyOf("What is niacinamide")).toBe(dedupeKeyOf("niacinamide"));
    expect(dedupeKeyOf("The barrier")).toBe(dedupeKeyOf("barrier"));
  });
  it("keeps genuinely different topics apart", () => {
    expect(dedupeKeyOf("ceramides")).not.toBe(dedupeKeyOf("retinoids"));
  });
});

describe("mintRequestId", () => {
  it("satisfies the tenant grammar", () => {
    expect(mintRequestId("Ceramides, explained", NOW, 1)).toMatch(new RegExp(PATTERN));
  });
  it("numbers the sequence so two plans in one day cannot collide", () => {
    expect(mintRequestId("ceramides", NOW, 1)).toContain("_20260914_01");
    expect(mintRequestId("ceramides", NOW, 3)).toContain("_20260914_03");
  });
  it("still mints a legal id from a topic made entirely of punctuation", () => {
    expect(mintRequestId("!!! ???", NOW, 1)).toMatch(new RegExp(PATTERN));
  });
});

describe("dedupe", () => {
  it("refuses a topic the site has already published, by slug or by title", () => {
    expect(plan({ inventory: [{ slug: "ceramides" }] }).requests).toHaveLength(0);
    expect(plan({ inventory: [{ title: "Ceramides" }] }).rejected[0]!.reason).toBe("duplicate_of_published");
  });

  it("refuses a topic an OPEN run is already writing", () => {
    const open: RunFact = { runId: "run_1", status: "running", startedAt: "2026-09-13T06:00:00.000Z", topicKey: "Ceramides", commissionedBy: COMMISSIONED_BY };
    const result = plan({ recentRuns: [open], commissioning: commissioning({ maxConcurrentRuns: 3 }) });
    expect(result.rejected[0]!.reason).toBe("duplicate_of_open_run");
  });

  it("refuses the same topic twice inside ONE plan", () => {
    const result = plan({ candidates: [candidate("ceramides"), candidate("The Ceramides", { priority: 0 })] });
    expect(result.requests).toHaveLength(1);
    expect(result.rejected[0]!.reason).toBe("duplicate_in_plan");
  });

  it("honours the strategist's exclusions before anything else", () => {
    const result = plan({ commissioning: commissioning({ exclusions: ["ceramides"] }) });
    expect(result.rejected[0]!.reason).toBe("excluded");
  });

  it("a BROADER veto still catches a narrower topic", () => {
    const result = plan({ candidates: [candidate("prescription tretinoin dosing schedules")], commissioning: commissioning({ exclusions: ["prescription tretinoin dosing"] }) });
    expect(result.rejected[0]!.reason).toBe("excluded");
  });

  it("a NARROW veto does not ban the whole subject — precision must not ban more", () => {
    const result = plan({ candidates: [candidate("tretinoin")], commissioning: commissioning({ exclusions: ["prescription tretinoin dosing"] }) });
    expect(result.requests).toHaveLength(1);
  });

  it("ignores a one-character exclusion instead of letting it silence the publication", () => {
    const result = plan({ candidates: [candidate("azelaic acid")], commissioning: commissioning({ exclusions: ["a", "of"] }) });
    expect(result.requests).toHaveLength(1);
  });
});

describe("caps", () => {
  it("stops at runsPerDay, counting only runs COMMISSIONED today", () => {
    const today: RunFact = { runId: "run_a", status: "completed", startedAt: "2026-09-14T05:00:00.000Z", costUsd: 4, commissionedBy: COMMISSIONED_BY };
    const result = plan({
      commissioning: commissioning({ runsPerDay: 1, dailyBudgetUsd: 100, maxConcurrentRuns: 3 }),
      recentRuns: [today],
      candidates: [candidate("ceramides")]
    });
    expect(result.caps.slotsByRunCount).toBe(0);
    expect(result.requests).toHaveLength(0);
    expect(result.rejected[0]!.reason).toBe("over_run_cap");
  });

  it("ignores a human-started run when counting today's commissioned work", () => {
    const human: RunFact = { runId: "run_h", status: "completed", startedAt: "2026-09-14T05:00:00.000Z", costUsd: 4 };
    const result = plan({ commissioning: commissioning({ runsPerDay: 1, dailyBudgetUsd: 100, maxConcurrentRuns: 3 }), recentRuns: [human] });
    expect(result.requests).toHaveLength(1);
  });

  it("prices the budget at the p95 run cost, not at hope", () => {
    const result = plan({
      commissioning: commissioning({ runsPerDay: 10, dailyBudgetUsd: 10, maxConcurrentRuns: 10 }),
      candidates: [candidate("a"), candidate("b"), candidate("c")],
      pricedRunCostUsd: 4.5
    });
    expect(result.caps.pricedRunCostUsd).toBe(4.5);
    expect(result.caps.slotsByBudget).toBe(2);
    expect(result.requests).toHaveLength(2);
    expect(result.rejected[0]!.reason).toBe("over_budget");
  });

  it("falls back to the measured run cost when a project has no history", () => {
    const result = plan({ commissioning: commissioning({ runsPerDay: 10, dailyBudgetUsd: 10, maxConcurrentRuns: 10 }), candidates: [candidate("a"), candidate("b"), candidate("c")] });
    expect(result.caps.pricedRunCostUsd).toBe(MEASURED_RUN_COST_USD);
    expect(result.requests).toHaveLength(2);
  });

  it("bills a run still in flight at the FULL price, not at what it has paid so far", () => {
    // The usage ledger accrues per node, so a run started this morning has paid a fraction. Reading
    // that fraction as the cost hands the budget back slots it has already committed.
    const inFlight: RunFact[] = [1, 2, 3].map((index) => ({
      runId: `run_r${index}`,
      status: "running",
      startedAt: "2026-09-14T05:00:00.000Z",
      costUsd: 1,
      commissionedBy: COMMISSIONED_BY
    }));
    const result = plan({ commissioning: commissioning({ runsPerDay: 10, dailyBudgetUsd: 20, maxConcurrentRuns: 10 }), recentRuns: inFlight });
    expect(result.caps.spentTodayUsd).toBe(12);
    expect(result.caps.slotsByBudget).toBe(2);
  });

  it("counts today's spend against the budget, using each run's REAL cost where it has one", () => {
    const spent: RunFact = { runId: "run_a", status: "completed", startedAt: "2026-09-14T05:00:00.000Z", costUsd: 9, commissionedBy: COMMISSIONED_BY };
    const result = plan({ commissioning: commissioning({ runsPerDay: 10, dailyBudgetUsd: 10, maxConcurrentRuns: 10 }), recentRuns: [spent] });
    expect(result.caps.spentTodayUsd).toBe(9);
    expect(result.caps.slotsByBudget).toBe(0);
  });

  it("stops at maxConcurrentRuns, counting every IN-FLIGHT run whoever started it", () => {
    const open: RunFact = { runId: "run_o", status: "running", startedAt: "2026-09-13T06:00:00.000Z" };
    const result = plan({ commissioning: commissioning({ runsPerDay: 5, dailyBudgetUsd: 100, maxConcurrentRuns: 1 }), recentRuns: [open] });
    expect(result.caps.slotsByConcurrency).toBe(0);
    expect(result.rejected[0]!.reason).toBe("over_concurrency");
  });

  it("DOES count the planner's OWN blocked runs — a backlog the planner made is one it owns", () => {
    // Without this the planner is invisible to every brake at once: blocked is not a failure, so
    // the halt never trips, and concurrency is always free — so a tenant whose publish gate nobody
    // clears gets a fresh pair of articles commissioned into it every morning, for ever.
    const backlog: RunFact[] = [1, 2, 3].map((index) => ({
      runId: `run_c${index}`,
      status: "blocked",
      startedAt: "2026-09-06T10:00:00.000Z",
      commissionedBy: COMMISSIONED_BY
    }));
    const result = plan({ commissioning: commissioning({ runsPerDay: 5, dailyBudgetUsd: 100, maxConcurrentRuns: 2 }), recentRuns: backlog });
    expect(result.caps.openRuns).toBe(3);
    expect(result.requests).toHaveLength(0);
    expect(result.rejected[0]!.reason).toBe("over_concurrency");
  });

  it("does NOT let runs blocked on a person hold the concurrency cap for ever", () => {
    // dr-lurie carried seven of these on 2026-09-14, the oldest a week old. Counting them as
    // concurrency would stop the site commissioning permanently because nobody clicked a button.
    const stuck: RunFact[] = [1, 2, 3, 4, 5, 6, 7].map((index) => ({ runId: `run_b${index}`, status: "blocked", startedAt: "2026-09-06T10:00:00.000Z" }));
    const result = plan({ commissioning: commissioning({ runsPerDay: 5, dailyBudgetUsd: 100, maxConcurrentRuns: 1 }), recentRuns: stuck });
    expect(result.caps.openRuns).toBe(0);
    expect(result.requests).toHaveLength(1);
  });

  it("but a blocked run still CLAIMS its topic — the draft exists", () => {
    const stuck: RunFact = { runId: "run_b", status: "blocked", startedAt: "2026-09-06T10:00:00.000Z", topicKey: "ceramides" };
    const result = plan({ commissioning: commissioning({ runsPerDay: 5, dailyBudgetUsd: 100, maxConcurrentRuns: 3 }), recentRuns: [stuck] });
    expect(result.rejected[0]!.reason).toBe("duplicate_of_open_run");
  });

  it("dedupes a LONG topic against the truncated id it would have minted", () => {
    // The id carries a 40-character slug. Comparing the full topic against it never matches, so
    // before this every topic with a long name was re-commissioned every single day, for ever.
    const topic = "how to choose a vitamin c serum for sensitive skin in winter";
    const mintedId = `req_planner_${requestTopicSlug(topic)}_20260913_01`;
    const result = plan({ candidates: [candidate(topic)], inventory: [{ objectId: mintedId }], commissioning: commissioning({ maxConcurrentRuns: 3 }) });
    expect(result.requests).toHaveLength(0);
    expect(result.rejected[0]!.reason).toBe("duplicate_of_published");
  });

  it("dedupes against a published article by the topic buried in its request id", () => {
    // Live shape: this tenant's object_list answers with ids and no bodies at all.
    const result = plan({
      candidates: [candidate("azelaic acid")],
      inventory: [{ objectId: "req_plugin_azelaic_acid_20260904_01" }],
      commissioning: commissioning({ maxConcurrentRuns: 3 })
    });
    expect(result.rejected[0]!.reason).toBe("duplicate_of_published");
  });
});

describe("halt", () => {
  const failed = (runId: string, startedAt: string): RunFact => ({ runId, status: "failed", startedAt, commissionedBy: COMMISSIONED_BY });

  it("halts after the configured number of consecutive commissioned failures", () => {
    const result = plan({ recentRuns: [failed("r2", "2026-09-13T06:00:00.000Z"), failed("r1", "2026-09-12T06:00:00.000Z")] });
    expect(result.halt?.code).toBe("planner_halted");
    expect(result.requests).toHaveLength(0);
    expect(result.caps.slots).toBe(0);
  });

  it("does not halt while the streak is shorter than the threshold", () => {
    expect(plan({ recentRuns: [failed("r1", "2026-09-13T06:00:00.000Z")] }).halt).toBeUndefined();
  });

  it("a run BLOCKED on an approval neither counts as a failure nor halts the planner", () => {
    const runs: RunFact[] = [
      { runId: "b1", status: "blocked", startedAt: "2026-09-13T09:00:00.000Z", commissionedBy: COMMISSIONED_BY },
      failed("r1", "2026-09-13T06:00:00.000Z")
    ];
    expect(consecutiveCommissionedFailures(runs)).toBe(0);
  });

  it("a commissioned SUCCESS breaks the streak", () => {
    const runs: RunFact[] = [
      failed("r3", "2026-09-13T08:00:00.000Z"),
      { runId: "r2", status: "completed", startedAt: "2026-09-13T07:00:00.000Z", commissionedBy: COMMISSIONED_BY },
      failed("r1", "2026-09-13T06:00:00.000Z")
    ];
    expect(consecutiveCommissionedFailures(runs)).toBe(1);
  });

  it("a HUMAN's failed run neither trips nor resets the planner's breaker", () => {
    const runs: RunFact[] = [
      { runId: "h2", status: "failed", startedAt: "2026-09-13T09:00:00.000Z" },
      failed("r2", "2026-09-13T08:00:00.000Z"),
      { runId: "h1", status: "failed", startedAt: "2026-09-13T07:00:00.000Z" },
      failed("r1", "2026-09-13T06:00:00.000Z")
    ];
    expect(consecutiveCommissionedFailures(runs)).toBe(2);
  });

  it("raises a blockage.v1 with the two remedies the platform renders", () => {
    const halt = plan({ recentRuns: [failed("r2", "2026-09-13T06:00:00.000Z"), failed("r1", "2026-09-12T06:00:00.000Z")] }).halt!;
    const blockage = plannerHaltBlockage("dr-lurie", halt);
    expect(blockage.contract).toBe("blockage.v1");
    expect(blockage.remedies.map((remedy) => remedy.type)).toEqual(["set_project_field", "resume"]);
    expect(blockage.remedies[0]!.args.field).toBe("editorial_strategy.commissioning");
  });
});

describe("the plan itself", () => {
  it("inherits placement from the archetype and lets a candidate override it", () => {
    const result = plan({ candidates: [candidate("ceramides"), candidate("retinoids", { trafficSource: "email", awarenessStage: "most_aware", priority: 0 })], commissioning: commissioning({ maxConcurrentRuns: 3 }) });
    expect(result.requests[0]!.trafficSource).toBe("organic_search");
    expect(result.requests[0]!.awarenessStage).toBe("problem_aware");
    expect(result.requests[1]!.trafficSource).toBe("email");
  });

  it("is deterministic — same inputs, same plan, same request ids", () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()));
  });

  it("sorts by priority, then by topic, so the preview matches what commissioning will spend on", () => {
    const result = plan({
      commissioning: commissioning({ runsPerDay: 5, dailyBudgetUsd: 100, maxConcurrentRuns: 5 }),
      candidates: [candidate("zinc", { priority: 1 }), candidate("azelaic", { priority: 5 }), candidate("allantoin", { priority: 1 })]
    });
    expect(result.requests.map((request) => request.contentSource.topic)).toEqual(["azelaic", "allantoin", "zinc"]);
  });

  it("names an unmintable request id as its own reason, not as an archetype problem", () => {
    const result = plan({ requestIdPattern: "^never_matches_anything$" });
    expect(result.rejected[0]!.reason).toBe("request_id_unmintable");
  });

  it("drops a candidate naming an archetype the strategy does not define", () => {
    expect(plan({ candidates: [candidate("ceramides", { archetypeId: "ghost" })] }).rejected[0]!.reason).toBe("unknown_archetype");
  });

  it("turns seeds into candidates carrying the archetype's job", () => {
    const seeded = seedCandidates(commissioning({ seeds: [{ topic: "ceramides", readerState: "recognition", archetypeId: "barrier", priority: 3 }] }));
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.instructions).toContain("Decide what to stop using");
    expect(seeded[0]!.priority).toBe(3);
  });
});
