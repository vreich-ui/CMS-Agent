import { describe, expect, it } from "vitest";
import { createWorkspaceTools } from "../../../src/agent/mcp/workspace/tools.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { filterRecordsByProject, newestMatchingProject } from "../../../src/agent/improvement/projectScope.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// S-07 — the read side of tenant partitioning for feedback records and learning observations.
//
// The two record types were never project-partitioned (only runId/nodeId), which is why the tenant
// Insights tab could not be given feedback_list / learning_list_observations at all. They now carry an
// OPTIONAL projectId, and these two list tools filter on it — matching a stamped record directly and
// rescuing an unstamped legacy one through its run. What must never happen is the third case: a record
// whose project cannot be established being shown to a filtered caller.
const tools = createWorkspaceTools({});
const callTool = async (name: string, input: unknown) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return (await found.execute(input)) as { ok: true; data: any };
};

const seedRun = async (runId: string, projectId: string) => {
  await repositoryManager.getExecutionRepository().createRun({
    runId,
    workflowId: "conductor",
    projectId,
    status: "running",
    startedAt: new Date().toISOString(),
    nodes: [],
    rev: 0
  } as unknown as WorkflowExecutionRecord);
};

const unique = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

describe("feedback.list project scoping", () => {
  it("returns stamped rows for the project, rescues unstamped rows via their run, and drops the rest", async () => {
    const nodeId = unique("node_fb");
    const ownRun = unique("run_own");
    const foreignRun = unique("run_foreign");
    await seedRun(ownRun, "dr-lurie");
    await seedRun(foreignRun, "fernwell");

    await callTool("feedback.record", { kind: "approve", nodeId, projectId: "dr-lurie", note: "stamped-own" });
    await callTool("feedback.record", { kind: "approve", nodeId, projectId: "fernwell", note: "stamped-foreign" });
    await callTool("feedback.record", { kind: "approve", nodeId, runId: ownRun, note: "unstamped-own-run" });
    await callTool("feedback.record", { kind: "approve", nodeId, runId: foreignRun, note: "unstamped-foreign-run" });
    await callTool("feedback.record", { kind: "approve", nodeId, runId: unique("run_missing"), note: "unstamped-unknown-run" });
    await callTool("feedback.record", { kind: "approve", nodeId, note: "unstamped-no-run" });

    const scoped = await callTool("feedback.list", { nodeId, projectId: "dr-lurie" });
    expect(scoped.data.records.map((record: { note: string }) => record.note).sort())
      .toEqual(["stamped-own", "unstamped-own-run"]);
  });

  // The pre-existing contract: no projectId means no filtering at all, for the full workspace bearer
  // and for every caller that has never passed one.
  it("is unfiltered when no projectId is supplied", async () => {
    const nodeId = unique("node_fb_all");
    await callTool("feedback.record", { kind: "approve", nodeId, projectId: "dr-lurie" });
    await callTool("feedback.record", { kind: "approve", nodeId, projectId: "fernwell" });
    await callTool("feedback.record", { kind: "approve", nodeId });

    const all = await callTool("feedback.list", { nodeId });
    expect(all.data.records).toHaveLength(3);
  });

  it("persists the stamp so a record can be found by it later", async () => {
    const nodeId = unique("node_fb_stamp");
    const recorded = await callTool("feedback.record", { kind: "approve", nodeId, projectId: "dr-lurie" });
    expect(recorded.data.feedback.projectId).toBe("dr-lurie");
  });

  // The ordering bug. `limit` used to reach the repository BEFORE the project filter, so a tenant
  // asking for N got "the newest N records, of which these are yours" — here, none of them, while
  // three of their own sat in the store. An empty Insights card that means "you have no feedback" and
  // one that means "your feedback is older than the workspace's newest three" are different answers.
  it("returns the tenant's OWN newest N, not the workspace's newest N narrowed to them", async () => {
    const nodeId = unique("node_fb_limit");
    for (const note of ["mine-1", "mine-2", "mine-3"]) {
      await callTool("feedback.record", { kind: "approve", nodeId, projectId: "dr-lurie", note });
    }
    // Written last, so these are the workspace's newest and would have filled the whole page.
    for (const note of ["theirs-1", "theirs-2", "theirs-3", "theirs-4"]) {
      await callTool("feedback.record", { kind: "approve", nodeId, projectId: "fernwell", note });
    }

    const scoped = await callTool("feedback.list", { nodeId, projectId: "dr-lurie", limit: 3 });
    expect(scoped.data.records.map((record: { note: string }) => record.note).sort())
      .toEqual(["mine-1", "mine-2", "mine-3"]);
  });

  it("still caps a project-scoped page at limit", async () => {
    const nodeId = unique("node_fb_cap");
    for (const note of ["a", "b", "c"]) {
      await callTool("feedback.record", { kind: "approve", nodeId, projectId: "dr-lurie", note });
    }
    const scoped = await callTool("feedback.list", { nodeId, projectId: "dr-lurie", limit: 2 });
    expect(scoped.data.records).toHaveLength(2);
    expect(scoped.data.records.every((record: { projectId: string }) => record.projectId === "dr-lurie")).toBe(true);
    // Deliberately NOT asserting WHICH two. `newestFirst` orders on `createdAt`, records written in
    // the same millisecond tie, and the sort is stable — so three records recorded in a tight loop
    // come back oldest-first, and "newest first" is not true at sub-millisecond resolution. That is
    // pre-existing and not this change's to fix; the unit tests below cover ordering with records
    // whose order is actually defined.
  });

  it("leaves an UNFILTERED caller's limit exactly as it always was", async () => {
    const nodeId = unique("node_fb_unfiltered_limit");
    for (const projectId of ["dr-lurie", "fernwell", "dr-lurie"]) {
      await callTool("feedback.record", { kind: "approve", nodeId, projectId });
    }
    const all = await callTool("feedback.list", { nodeId, limit: 2 });
    expect(all.data.records).toHaveLength(2);
  });
});

describe("learning.list_observations project scoping", () => {
  it("matches on the stamp, falls back to the run, and omits what it cannot place", async () => {
    const marker = unique("[S07");
    const ownRun = unique("run_obs_own");
    const foreignRun = unique("run_obs_foreign");
    await seedRun(ownRun, "dr-lurie");
    await seedRun(foreignRun, "fernwell");

    await callTool("learning.record_observation", { observation: `${marker} stamped-own`, projectId: "dr-lurie" });
    await callTool("learning.record_observation", { observation: `${marker} stamped-foreign`, projectId: "fernwell" });
    await callTool("learning.record_observation", { observation: `${marker} unstamped-own-run`, runId: ownRun });
    await callTool("learning.record_observation", { observation: `${marker} unstamped-foreign-run`, runId: foreignRun });
    await callTool("learning.record_observation", { observation: `${marker} unstamped-no-run` });

    const scoped = await callTool("learning.list_observations", { projectId: "dr-lurie" });
    const mine = scoped.data.observations
      .filter((observation: { observation: string }) => observation.observation.startsWith(marker))
      .map((observation: { observation: string }) => observation.observation.slice(marker.length + 1))
      .sort();
    expect(mine).toEqual(["stamped-own", "unstamped-own-run"]);
  });

  it("stamps the observation and leaves an unfiltered list alone", async () => {
    const marker = unique("[S07ALL");
    const recorded = await callTool("learning.record_observation", { observation: `${marker} one`, projectId: "dr-lurie" });
    expect(recorded.data.observation.projectId).toBe("dr-lurie");
    await callTool("learning.record_observation", { observation: `${marker} two`, projectId: "fernwell" });

    const all = await callTool("learning.list_observations", {});
    const seen = all.data.observations.filter((observation: { observation: string }) => observation.observation.startsWith(marker));
    expect(seen).toHaveLength(2);
  });
});

describe("filterRecordsByProject", () => {
  // The bound that keeps a page of feedback from becoming a page of blob reads: each DISTINCT runId is
  // resolved once, however many records share it.
  it("resolves each distinct runId at most once per call", async () => {
    const calls: string[] = [];
    const executionRepository = {
      getRun: async (runId: string) => {
        calls.push(runId);
        return { runId, projectId: runId === "run-a" ? "dr-lurie" : "fernwell" } as unknown as WorkflowExecutionRecord;
      }
    };
    const records = [
      { runId: "run-a" }, { runId: "run-a" }, { runId: "run-a" },
      { runId: "run-b" }, { runId: "run-b" },
      { projectId: "dr-lurie" }
    ];

    const kept = await filterRecordsByProject(records, "dr-lurie", executionRepository);
    expect(kept).toHaveLength(4);
    expect(calls.sort()).toEqual(["run-a", "run-b"]);
  });

  // Fail closed: "we could not tell" must never render as "show it to them".
  it("excludes an unstamped record when the run lookup throws", async () => {
    const executionRepository = { getRun: async () => { throw new Error("store unavailable"); } };
    const kept = await filterRecordsByProject([{ runId: "run-a" }, { projectId: "dr-lurie" }], "dr-lurie", executionRepository as never);
    expect(kept).toEqual([{ projectId: "dr-lurie" }]);
  });
});

describe("newestMatchingProject", () => {
  const throwingRepository = { getRun: async () => { throw new Error("should not be reached"); } } as never;

  it("fills the page from the tenant's own records however deep they sit", async () => {
    const records = [
      ...Array.from({ length: 200 }, (_value, index) => ({ projectId: "fernwell", id: `theirs-${index}` })),
      { projectId: "dr-lurie", id: "mine-1" },
      { projectId: "dr-lurie", id: "mine-2" }
    ];
    const page = await newestMatchingProject(records, "dr-lurie", 5, throwingRepository);
    expect(page.map((record) => record.id)).toEqual(["mine-1", "mine-2"]);
  });

  it("applies the limit to the MATCHING records, newest first", async () => {
    const records = Array.from({ length: 10 }, (_value, index) => ({ projectId: "dr-lurie", id: `r${index}` }));
    const page = await newestMatchingProject(records, "dr-lurie", 3, throwingRepository);
    expect(page.map((record) => record.id)).toEqual(["r0", "r1", "r2"]);
  });

  // The bound that replaces the old "don't over-fetch" argument. A page filled from stamped records
  // must not walk the unstamped tail behind it, or one tenant's page cost would grow with every
  // legacy record in the workspace.
  it("stops as soon as the page is full, never touching the runs behind it", async () => {
    const looked: string[] = [];
    const executionRepository = {
      getRun: async (runId: string) => { looked.push(runId); return { runId, projectId: "dr-lurie" } as never; }
    };
    const records = [
      ...Array.from({ length: 50 }, (_value, index) => ({ projectId: "dr-lurie", id: `stamped-${index}` })),
      ...Array.from({ length: 50 }, (_value, index) => ({ runId: `run-${index}`, id: `legacy-${index}` }))
    ];
    const page = await newestMatchingProject(records, "dr-lurie", 10, executionRepository);
    expect(page).toHaveLength(10);
    expect(looked).toEqual([]);
  });

  it("passes an unfiltered call straight through, limit and all", async () => {
    const records = [{ runId: "a" }, { runId: "b" }, { runId: "c" }];
    expect(await newestMatchingProject(records, undefined, 2, throwingRepository)).toHaveLength(2);
    expect(await newestMatchingProject(records, undefined, undefined, throwingRepository)).toHaveLength(3);
  });
});
