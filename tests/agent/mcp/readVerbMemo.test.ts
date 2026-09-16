import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMOIZABLE_READ_VERBS, clearReadMemoForTests, isMemoizableRead, setReadMemoEnabled, withReadMemo } from "../../../src/agent/mcp/workspace/readVerbMemo.js";

// W1 acceptance for the read memo. Two properties matter more than the speed-up: a WRITE verb is
// never collapsed (that would silently drop an operator's second decision), and two callers with
// different authorization never share an answer.

describe("read verb memo", () => {
  // The memo is off by default under vitest (see setReadMemoEnabled); this is the suite that wants
  // it on, and it is the only one, because it drives withReadMemo directly rather than through a
  // store a test can reset behind its back.
  beforeEach(() => { setReadMemoEnabled(true); clearReadMemoForTests(); });
  afterEach(() => setReadMemoEnabled(false));

  it("collapses identical concurrent reads into one dispatch", async () => {
    let calls = 0;
    const execute = async () => { calls++; await new Promise((done) => setTimeout(done, 5)); return { nodes: [] }; };
    const results = await Promise.all(Array.from({ length: 10 }, () => withReadMemo("workspace_get_nodes", {}, {}, execute)));
    expect(calls).toBe(1);
    expect(results.filter((result) => result.memoized)).toHaveLength(9);
    expect(results.every((result) => result.result)).toBe(true);
  });

  it("treats argument key ORDER as the same question and different VALUES as different ones", async () => {
    let calls = 0;
    const execute = async () => { calls++; return calls; };
    await withReadMemo("workflow_list_runs", { limit: 5, workflowId: "a" }, {}, execute);
    await withReadMemo("workflow_list_runs", { workflowId: "a", limit: 5 }, {}, execute);
    expect(calls).toBe(1);
    await withReadMemo("workflow_list_runs", { workflowId: "b", limit: 5 }, {}, execute);
    expect(calls).toBe(2);
  });

  it("never memoizes a verb that is not on the read allowlist", async () => {
    let calls = 0;
    const execute = async () => { calls++; return calls; };
    await Promise.all([
      withReadMemo("workflow_run_next_node", { runId: "r1" }, {}, execute),
      withReadMemo("workflow_run_next_node", { runId: "r1" }, {}, execute)
    ]);
    expect(calls).toBe(2);
  });

  it("keeps the allowlist free of anything that writes", () => {
    // Every wire verb is `<domain>_<action>[_<detail>]`. Only these actions read; anything else on
    // the allowlist is either a write or a verb nobody checked, and both must fail this test. The
    // action is read positionally rather than by substring, because `workflow_get_run` contains
    // the word "run" and is still a read.
    const readActions = new Set(["get", "list", "validate", "resolve", "export", "compare", "search", "preflight"]);
    const offenders = [...MEMOIZABLE_READ_VERBS].filter((verb) => !readActions.has(verb.split("_")[1] ?? ""));
    expect(offenders).toEqual([]);
  });

  it("does not let two differently-authorized callers share an answer", async () => {
    let calls = 0;
    const execute = async () => { calls++; return calls; };
    await withReadMemo("project_list", {}, { actor: { kind: "agent", id: "operator" } }, execute);
    await withReadMemo("project_list", {}, { actor: { kind: "agent", id: "tenant" } }, execute);
    expect(calls).toBe(2);
    await withReadMemo("project_list", {}, { actor: { kind: "agent", id: "operator" }, allowedToolNames: ["project_list"] }, execute);
    expect(calls).toBe(3);
  });

  it("does not cache a failure", async () => {
    let calls = 0;
    const execute = async () => { calls++; throw new Error("store unavailable"); };
    await expect(withReadMemo("skill_list", {}, {}, execute)).rejects.toThrow("store unavailable");
    await expect(withReadMemo("skill_list", {}, {}, execute)).rejects.toThrow("store unavailable");
    expect(calls).toBe(2);
  });

  it("normalizes the dotted internal name onto the wire name", () => {
    expect(isMemoizableRead("workspace.get_nodes")).toBe(true);
    expect(isMemoizableRead("workspace_get_nodes")).toBe(true);
    expect(isMemoizableRead("workspace.update_node")).toBe(false);
  });
});
