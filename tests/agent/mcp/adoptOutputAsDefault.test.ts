import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// W7 — `workspace.adopt_output_as_default` threw `node_output_unavailable` for EVERY node, always.
//
// It guarded on `latest.output === undefined`, and `listNodeOutputs` returns ExecutionArtifacts,
// whose payload field is `value` (executionTypes.ts). No artifact has ever had an `output` field, so
// the guard fired unconditionally and the tool whose entire job is adopting a recorded output could
// never adopt one.
//
// It survived because nothing called it. The Workbench control that DefaultOutputTab's own header
// points at ("adopt this node's last good output") did not exist until W6, and the sibling read
// node.get_latest_output hands the whole artifact back without reading either field. A test that
// only asserted the REFUSAL would have passed throughout — which is why this one drives a real run
// first and asserts the value that comes out the other side.

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

describe("workspace.adopt_output_as_default", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("adopts the value a run actually recorded, rather than refusing every node forever", async () => {
    const runId = (await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {} })).run.runId;
    await data("workflow.run_next_node", { runId });

    const run = await data("workflow.get_run", { runId, detail: "full" });
    const artifact = (run.run.artifacts ?? [])[0];
    expect(artifact, "the run recorded no artifact — this test proves nothing without one").toBeTruthy();
    // The premise, asserted rather than assumed: the payload lives in `value`.
    expect(artifact.value).toBeDefined();
    expect((artifact as Record<string, unknown>).output).toBeUndefined();

    const adopted = await data("workspace.adopt_output_as_default", { nodeId: artifact.nodeId, runId });
    expect(adopted.node.defaultOutput).toBeTruthy();
    expect(adopted.node.defaultOutput.value).toEqual(artifact.value);
    expect(adopted.adoptedFrom.runId).toBe(runId);
  });

  it("still refuses a node that has recorded nothing, and names it", async () => {
    const result = await call("workspace.adopt_output_as_default", { nodeId: "publish_payload", runId: "run_does_not_exist" });
    const text = JSON.stringify(result);
    expect(text).toContain("node_output_unavailable");
    expect(text).toContain("publish_payload");
  });
});

// W7 — the compact run view is the DEFAULT and is what the Workbench binds to; it carried neither
// the run's stage outputs nor its initial input, so every surface that answers "what was this node
// handed, and what did it produce" out of the run record read an empty map against the live plane.
describe("workflow.get_run carries stage outputs only when asked, and really carries them", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("omits them by default and includes them on request", async () => {
    const runId = (await data("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: { topic: "w7" } })).run.runId;
    await data("workflow.run_next_node", { runId });

    const compact = await data("workflow.get_run", { runId });
    expect(compact.run.stageOutputs).toBeUndefined();

    const withOutputs = await data("workflow.get_run", { runId, include: ["stageOutputs"] });
    expect(withOutputs.run.stageOutputs).toBeTruthy();
    expect(Object.keys(withOutputs.run.stageOutputs).length).toBeGreaterThan(0);
    // ...and it is still the COMPACT view — asking for stage outputs must not drag every node's
    // whole input/output object along, which is what detail:"full" is for.
    expect(withOutputs.run.nodes.every((node: Record<string, unknown>) => node.input === undefined && node.output === undefined)).toBe(true);
  });
});
