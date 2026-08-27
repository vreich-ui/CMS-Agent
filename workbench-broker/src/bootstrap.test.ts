import { test } from "node:test";
import assert from "node:assert/strict";
import { composeBootstrap, KNOWN_WORKFLOW_IDS } from "./bootstrap.js";

type BatchOutcome = { ok: true; data: unknown } | { ok: false; error: string };

function stubClient(byVerb: (verb: string, args: Record<string, unknown>) => BatchOutcome) {
  let calls: Array<{ verb: string; args: Record<string, unknown> }> = [];
  return {
    async callToolsBatch(reqs: Array<{ verb: string; args: Record<string, unknown> }>) {
      calls = reqs;
      return reqs.map((r) => byVerb(r.verb, r.args));
    },
    get lastCalls() {
      return calls;
    },
  };
}

const FLAT_GRAPH_OK = {
  ok: true as const,
  data: {
    nodes: [
      { id: "draft_writer", name: "Draft Writer", kind: "generation", description: "writes drafts" },
      { id: "capture_crawl", kind: "capture" }, // missing name (falls back to id) and description on purpose
      { notAnId: true }, // malformed entry, should be dropped
    ],
    edges: [{ from: "a", to: "b" }],
    registeredWorkflowIds: ["publishing_conductor", "capture_conductor", "clone_conductor"],
  },
};

test("bootstrap: issues exactly one batched call covering flat graph, each workflow's graph, runs, and attention", async () => {
  const client = stubClient((verb) => {
    if (verb === "workspace_get_graph") return FLAT_GRAPH_OK;
    if (verb === "workflow_list_runs") return { ok: true, data: { runs: [] } };
    if (verb === "constellation_get_attention") return { ok: true, data: [] };
    return { ok: false, error: `unexpected verb ${verb}` };
  });

  await composeBootstrap(client, { workspaceVersion: "1" });
  assert.equal(client.lastCalls.length, 1 + KNOWN_WORKFLOW_IDS.length + 1 + 1);
  assert.equal(client.lastCalls[0]!.verb, "workspace_get_graph");
  assert.deepEqual(client.lastCalls[0]!.args, {});
  for (let i = 0; i < KNOWN_WORKFLOW_IDS.length; i++) {
    assert.equal(client.lastCalls[1 + i]!.verb, "workspace_get_graph");
    assert.equal(client.lastCalls[1 + i]!.args.workflowId, KNOWN_WORKFLOW_IDS[i]);
  }
});

test("bootstrap: happy path fills every key and carries no errors map", async () => {
  const client = stubClient((verb, args) => {
    if (verb === "workspace_get_graph" && !args.workflowId) return FLAT_GRAPH_OK;
    if (verb === "workspace_get_graph") {
      return { ok: true, data: { nodes: [{ id: `${args.workflowId}_n1` }], edges: [] } };
    }
    if (verb === "workflow_list_runs") {
      return { ok: true, data: { runs: Array.from({ length: 15 }, (_, i) => ({ runId: `r${i}` })) } };
    }
    if (verb === "constellation_get_attention") return { ok: true, data: [{ id: "attn1" }] };
    throw new Error(`unexpected verb ${verb}`);
  });

  const result = await composeBootstrap(client, { workspaceVersion: "42" });
  assert.equal(result.errors, undefined);
  assert.equal(result.workspaceVersion, "42");
  assert.ok(result.workflows);
  assert.equal(result.workflows!.length, 3);
  // Malformed node entry (no id) dropped; two valid nodes kept, second falls back name->id.
  assert.equal(result.nodeSummaries?.length, 2);
  assert.equal(result.nodeSummaries?.[1]?.name, "capture_crawl");
  assert.equal(result.nodeSummaries?.[1]?.description, "");
  assert.equal(Object.keys(result.graphs).length, 3);
  assert.equal(result.graphs["publishing_conductor"]?.nodes.length, 1);
  // recentRuns capped at 10 even though 15 came back.
  assert.equal(result.recentRuns?.length, 10);
  assert.deepEqual(result.attention, [{ id: "attn1" }]);
  assert.match(result.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("bootstrap: constellation_get_attention failing degrades to null + errors.attention without touching anything else", async () => {
  const client = stubClient((verb, args) => {
    if (verb === "workspace_get_graph" && !args.workflowId) return FLAT_GRAPH_OK;
    if (verb === "workspace_get_graph") return { ok: true, data: { nodes: [], edges: [] } };
    if (verb === "workflow_list_runs") return { ok: true, data: { runs: [] } };
    if (verb === "constellation_get_attention") {
      return { ok: false, error: 'Anthropic Proxy: Invalid content from server' };
    }
    throw new Error(`unexpected verb ${verb}`);
  });

  const result = await composeBootstrap(client, { workspaceVersion: "1" });
  assert.equal(result.attention, null);
  assert.equal(result.errors?.attention, "Anthropic Proxy: Invalid content from server");
  // Everything else still painted.
  assert.ok(result.workflows);
  assert.ok(result.nodeSummaries);
  assert.ok(result.recentRuns);
});

test("bootstrap: the flat graph call failing nulls workflows AND nodeSummaries but leaves per-workflow graphs alone", async () => {
  const client = stubClient((verb, args) => {
    if (verb === "workspace_get_graph" && !args.workflowId) return { ok: false, error: "boom" };
    if (verb === "workspace_get_graph") return { ok: true, data: { nodes: [{ id: "x" }], edges: [] } };
    if (verb === "workflow_list_runs") return { ok: true, data: { runs: [] } };
    if (verb === "constellation_get_attention") return { ok: true, data: [] };
    throw new Error(`unexpected verb ${verb}`);
  });

  const result = await composeBootstrap(client, { workspaceVersion: "1" });
  assert.equal(result.workflows, null);
  assert.equal(result.nodeSummaries, null);
  assert.equal(result.errors?.workflows, "boom");
  assert.equal(result.errors?.nodeSummaries, "boom");
  assert.equal(result.graphs["publishing_conductor"]?.nodes.length, 1);
});

test("bootstrap: one bad per-workflow graph call nulls only that entry, keyed by workflow id", async () => {
  const client = stubClient((verb, args) => {
    if (verb === "workspace_get_graph" && !args.workflowId) return FLAT_GRAPH_OK;
    if (verb === "workspace_get_graph" && args.workflowId === "capture_conductor") {
      return { ok: false, error: "capture graph exploded" };
    }
    if (verb === "workspace_get_graph") return { ok: true, data: { nodes: [], edges: [] } };
    if (verb === "workflow_list_runs") return { ok: true, data: { runs: [] } };
    if (verb === "constellation_get_attention") return { ok: true, data: [] };
    throw new Error(`unexpected verb ${verb}`);
  });

  const result = await composeBootstrap(client, { workspaceVersion: "1" });
  assert.equal(result.graphs["capture_conductor"], null);
  assert.equal(result.errors?.["graphs.capture_conductor"], "capture graph exploded");
  assert.ok(result.graphs["publishing_conductor"]);
  assert.ok(result.graphs["clone_conductor"]);
});

test("bootstrap: falls back to the known conductor ids when registeredWorkflowIds is absent", async () => {
  const client = stubClient((verb, args) => {
    if (verb === "workspace_get_graph" && !args.workflowId) {
      return { ok: true, data: { nodes: [], edges: [] } }; // no registeredWorkflowIds field at all
    }
    if (verb === "workspace_get_graph") return { ok: true, data: { nodes: [], edges: [] } };
    if (verb === "workflow_list_runs") return { ok: true, data: { runs: [] } };
    if (verb === "constellation_get_attention") return { ok: true, data: [] };
    throw new Error(`unexpected verb ${verb}`);
  });

  const result = await composeBootstrap(client, { workspaceVersion: "1" });
  assert.deepEqual(
    result.workflows?.map((w) => w.id),
    [...KNOWN_WORKFLOW_IDS]
  );
});
