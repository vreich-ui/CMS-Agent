import { describe, expect, it } from "vitest";
import {
  buildTimelineRows,
  summarizeTimeline,
  timelineEmptyReason,
  timelineFilterOptions,
  timelineNoMatchReason,
  type ToolExecutionRow
} from "../../ui/src/runToolTimeline.js";
import * as workbench from "../../workbench/src/screens/Runs/toolTimeline.js";

// ACCEPTANCE — W5 T4 (2026-09-16). A run's tool-execution timeline, including the engine calls.
//
// The two SPAs each render this, and neither can import from the other (separately bundled, no shared
// module path — Runs/helpers.ts mirrors the mockup's own script for the same reason). So there are two
// copies of the model, and the last describe() below drives BOTH over the same fixture and asserts
// identical output: change one without the other and this file fails, which is the only thing that
// makes a deliberate copy safe.
//
// Neither `.tsx` is covered by this suite. What IS covered is every decision those files render:
// ordering, what an unrecorded caller is called, which filter options a run offers, and the
// difference between "read it, there are none" and "could not read it".

const rows: ToolExecutionRow[] = [
  { toolExecutionId: "b", toolId: "deploy_status", startedAt: "2026-09-16T10:00:02.000Z", caller: "engine", routeId: "release_executor", nodeId: "release_executor", projectId: "dr-lurie", status: "success", durationMs: 40 },
  { toolExecutionId: "a", toolId: "release_to_production", startedAt: "2026-09-16T10:00:01.000Z", caller: "engine", routeId: "release_executor", nodeId: "release_executor", projectId: "dr-lurie", status: "success", durationMs: 900 },
  { toolExecutionId: "d", toolId: "object_get", startedAt: "2026-09-16T10:00:00.000Z", caller: "model", nodeId: "article_body", projectId: "dr-lurie", status: "success" },
  { toolExecutionId: "c", toolId: "site_apply_theme", startedAt: "2026-09-16T10:00:02.000Z", caller: "engine", routeId: "clone_stage", nodeId: "clone_theme_bind", projectId: "zilberman", status: "denied", errorCode: "tenant_verb_needs_approval", engineVerbUnlisted: true },
  { toolExecutionId: "e", toolId: "object_patch", startedAt: "2026-09-16T10:00:03.000Z", projectId: "dr-lurie", status: "error", errorCode: "tenant_call_failed" }
];

describe("W5 T4 — the order the calls were made in", () => {
  it("sorts by startedAt, breaking ties on toolExecutionId so the order is total", () => {
    // "b" and "c" share a timestamp: a deterministic route can fire two verbs inside one stamp, and a
    // timeline that reshuffled them between renders would be unreadable.
    expect(buildTimelineRows(rows).map((row) => row.toolExecutionId)).toEqual(["d", "a", "b", "c", "e"]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    buildTimelineRows(input);
    expect(input.map((row) => row.toolExecutionId)).toEqual(rows.map((row) => row.toolExecutionId));
  });
});

describe("W5 T4 — what each row says about itself", () => {
  it("marks the engine calls, which are the ones no grant and no risk check ever saw", () => {
    const built = buildTimelineRows(rows);
    expect(built.filter((row) => row.engineReached).map((row) => row.toolId).sort())
      .toEqual(["deploy_status", "release_to_production", "site_apply_theme"]);
  });

  it("calls a row with no recorded caller \"unrecorded\", never \"model\"", () => {
    // Rows written before W3.2.1 have no caller. Labelling them would invent evidence about who made
    // a call nobody recorded — the exact failure this whole programme is about.
    const orphan = buildTimelineRows(rows).find((row) => row.toolExecutionId === "e")!;
    expect(orphan.callerLabel).toBe("unrecorded");
    expect(orphan.engineReached).toBe(false);
  });

  it("separates a call the tenant HELD from a call that failed", () => {
    const built = buildTimelineRows(rows);
    expect(built.find((row) => row.toolExecutionId === "c")!.refused).toBe(true);
    expect(built.find((row) => row.toolExecutionId === "e")!.refused).toBe(false);
  });

  // ADVERSARIAL REVIEW FIX — `status: "denied"` is not by itself a tenant refusal. The runner's
  // tool-call limiter writes a denied stub (tool_call_limit_exceeded) and so does the wire denylist
  // (publish_verb_not_permitted); a screen that called those "refused by the tenant" would send an
  // operator to read a client policy that had nothing to do with it.
  it("distinguishes a call the TENANT held from one this system denied itself", () => {
    const limited: ToolExecutionRow[] = [
      { toolId: "object_patch", startedAt: "2026-09-16T10:00:00.000Z", status: "denied", errorCode: "tool_call_limit_exceeded" },
      { toolExecutionId: "held", toolId: "site_apply_theme", startedAt: "2026-09-16T10:00:01.000Z", status: "denied", errorCode: "tenant_verb_needs_approval" }
    ];
    const built = buildTimelineRows(limited);
    expect(built.map((row) => [row.refused, row.heldByTenant])).toEqual([[true, false], [true, true]]);
    expect(summarizeTimeline(built)).toMatchObject({ denied: 2, heldByTenant: 1 });
  });

  // The server's own merge folds run-record stubs into tool.list_executions, and a stub written by
  // the tool-call limiter has neither a toolExecutionId nor a startedAt. Two of them are two rows.
  it("gives every row a unique key even when the ledger recorded no id", () => {
    const stubs: ToolExecutionRow[] = [
      { toolId: "object_patch", status: "denied", errorCode: "tool_call_limit_exceeded" },
      { toolId: "object_patch", status: "denied", errorCode: "tool_call_limit_exceeded" },
      { toolExecutionId: "real", toolId: "object_get", startedAt: "2026-09-16T10:00:00.000Z" }
    ];
    const keys = buildTimelineRows(stubs).map((row) => row.rowKey);
    expect(new Set(keys).size).toBe(3);
    // A row with no startedAt sorts LAST: an absent timestamp is "we do not know when", and putting
    // it first would assert it happened before everything else.
    expect(keys[0]).toBe("real");
  });

  it("keeps a row's key stable under filtering, so React never re-associates two rows", () => {
    const unfiltered = new Map(buildTimelineRows(rows).map((row) => [row.toolId, row.rowKey]));
    for (const row of buildTimelineRows(rows, { caller: "engine" })) {
      expect(row.rowKey).toBe(unfiltered.get(row.toolId));
    }
  });
});

describe("W5 T4 — filters, and the options they are built from", () => {
  it("derives options from the UNFILTERED set, so choosing one never deletes the others", () => {
    expect(timelineFilterOptions(rows)).toEqual({
      callers: ["engine", "model", "unrecorded"],
      routeIds: ["clone_stage", "release_executor"]
    });
  });

  it("filters by caller, counting an unrecorded row under its own label", () => {
    expect(buildTimelineRows(rows, { caller: "engine" })).toHaveLength(3);
    expect(buildTimelineRows(rows, { caller: "unrecorded" }).map((row) => row.toolId)).toEqual(["object_patch"]);
  });

  it("filters by route", () => {
    expect(buildTimelineRows(rows, { routeId: "release_executor" }).map((row) => row.toolId)).toEqual(["release_to_production", "deploy_status"]);
  });

  it("combines the two", () => {
    expect(buildTimelineRows(rows, { caller: "engine", routeId: "clone_stage" }).map((row) => row.toolId)).toEqual(["site_apply_theme"]);
  });
});

describe("W5 T4 — the summary and the empty state", () => {
  it("counts what an operator scanning a run is looking for", () => {
    expect(summarizeTimeline(buildTimelineRows(rows))).toEqual({
      total: 5, engineCalls: 3, denied: 1, heldByTenant: 1, failed: 1, unlistedVerbs: 1, projects: ["dr-lurie", "zilberman"]
    });
  });

  it("says why a FILTER matched nothing, rather than rendering an empty table under live headers", () => {
    const none = buildTimelineRows(rows, { caller: "operator" });
    expect(none).toEqual([]);
    const reason = timelineNoMatchReason(rows, none, { caller: "operator" });
    expect(reason).toContain("caller \"operator\"");
    expect(reason).toContain("5 recorded call(s)");
    // Not said when there is nothing to filter, or when the filter matched — those are other states
    // with their own copy.
    expect(timelineNoMatchReason([], [], { caller: "operator" })).toBeNull();
    expect(timelineNoMatchReason(rows, buildTimelineRows(rows), {})).toBeNull();
  });

  it("says why a run has no rows, rather than claiming it called nothing", () => {
    expect(timelineEmptyReason([])).toContain("began recording");
    expect(timelineEmptyReason(null)).toContain("could not be read");
    expect(timelineEmptyReason(rows)).toBeNull();
  });

  it("treats null and undefined as unread everywhere, never as empty", () => {
    expect(buildTimelineRows(null)).toEqual([]);
    expect(timelineFilterOptions(undefined)).toEqual({ callers: [], routeIds: [] });
  });
});

describe("W5 T4 — the two SPAs' copies cannot drift apart", () => {
  it("produces identical rows, options, summary and empty reason", () => {
    for (const filters of [{}, { caller: "engine" }, { routeId: "clone_stage" }, { caller: "unrecorded", routeId: "" }]) {
      expect(workbench.buildTimelineRows(rows, filters)).toEqual(buildTimelineRows(rows, filters));
    }
    expect(workbench.timelineFilterOptions(rows)).toEqual(timelineFilterOptions(rows));
    expect(workbench.timelineNoMatchReason(rows, workbench.buildTimelineRows(rows, { caller: "operator" }), { caller: "operator" }))
      .toEqual(timelineNoMatchReason(rows, buildTimelineRows(rows, { caller: "operator" }), { caller: "operator" }));
    expect(workbench.summarizeTimeline(workbench.buildTimelineRows(rows))).toEqual(summarizeTimeline(buildTimelineRows(rows)));
    for (const input of [rows, [], null, undefined]) {
      expect(workbench.timelineEmptyReason(input)).toEqual(timelineEmptyReason(input));
    }
  });
});
