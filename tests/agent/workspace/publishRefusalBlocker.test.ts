import { describe, expect, it, vi } from "vitest";
import { runEnginePublishExecution, type ExecutedPublishExecution } from "../../../src/agent/workspace/publishExecution.js";
import type { CallToolFn } from "../../../src/agent/workspace/publisher.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, setOperatorPublishDecision, startDryRun } from "../../../src/agent/workspace/executor.js";

// -------------------------------------------------------------------------------------------------
// A CLIENT REFUSAL, end to end: from the MCP result the transport delivered, to the typed blocker the
// operator reads.
//
// run_1787656120374_18bobg (dr-lurie): all five publisher gates passed, the sequence started, and the
// run reported
//   "error": "create_missing_object_id: could not resolve the object id (object_id/id) from the
//             object_create result."
//   "steps": [{ "tool": "object_create", "ok": true }]
// object_inventory for content_item then proved NO object had been created — 13 objects, all genuine
// articles, newest 2026-08-13, no locks held. The client had refused object_create and said exactly
// why. Because the TRANSPORT succeeded, `ok` was true, nothing checked isError, and the refusal was
// re-reported as an unfamiliar response SHAPE — discarding the one sentence that would have ended the
// investigation.
//
// The suite drives the same seam publisher.ts's own tests use (deps.callTool): no live site is
// reachable from here, and the assertions are about what the operator ends up holding.

const goDecision = () => ({ artifact: "publication_decision.v1", summary: "Ready.", decision: "go", blockers: [] });

const articleBodyEnvelope = () => ({
  artifact: "client_object.v1",
  summary: "Body for the refusal path.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fingerprint: "fp_sample" },
  body: { slug: "engine-publish", title: "Engine publish", nodes: [{ id: "n1", public: { text: "hello. This paragraph exists so the fixture reads as a real article rather than a stub: it explains the claim, names the tradeoff, and gives the reader one concrete next step to take today. It is long enough to clear the readiness content floor." } }] }
});

const enginePublishPayload = () => ({
  artifact: "dry_run_publish_payload.v1",
  summary: "Candidate.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fingerprint: "fp_sample" },
  dryRun: true,
  clientObject: { slug: "engine-publish", title: "Engine publish", nodes: [] },
  requestId: "req_w2a_engine_20260813_01",
  artifactReferences: [{ key: "images/req_w2a_engine_20260813_01/a.png", digest: "sha256:abc123" }],
  blockers: []
});

// The client's own answers on the happy path, in the shapes the object dialect's readers expect.
const CLIENT_RESULTS: Record<string, unknown> = {
  object_create: { object_id: "obj_platform_9912" },
  object_checkout: { lock_token: "lock_t4", record_version: 7 },
  object_validate: { valid: true, issues: [] },
  object_patch: { record_version: 8 },
  object_publish: { status: "published", commit_sha: "9f2c1ab4", content_revision: 4 },
  object_checkin: { released: true }
};

// A refusal exactly as the transport delivers one: the CALL succeeded (ok: true) and the MCP result
// itself carries isError plus the client's reason, statusCode and Zod issues[].
const clientRefusal = (message: string, issues: unknown[] = []) => ({
  isError: true,
  content: [{ type: "text", text: message }],
  structuredContent: { error: message, statusCode: 400, ...(issues.length ? { issues } : {}) }
});

// `calls` is the ordered record of what actually reached the client — on a failure path what did NOT
// get called after it matters as much as the final state.
const stubClient = (refusals: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const callTool = vi.fn(async (tool: string) => ({
    ok: true,
    projectId: "platform",
    tool,
    result: (calls.push(tool), refusals[tool] ?? CLIENT_RESULTS[tool] ?? {})
  }));
  return { callTool: callTool as unknown as CallToolFn, calls };
};

const seedEngineRun = async () => {
  const store = new RepositoryManager().getExecutionRepository();
  const started = await startDryRun({
    executionMode: "openai",
    projectId: "platform",
    input: "client refusal path",
    budgetUsd: 100,
    entrypoint: { nodeId: "article_body", output: articleBodyEnvelope() }
  }, store);
  const seeded = (await getRun(started.runId, store))!;
  seeded.stageOutputs.publish_payload = enginePublishPayload();
  seeded.stageOutputs.publication_controller = goDecision();
  await store.saveRun(seeded);
  await setOperatorPublishDecision(started.runId, "approved", store);
  return { store, run: (await getRun(started.runId, store))! };
};

const runEngine = async (refusals: Record<string, unknown>) => {
  const { store, run } = await seedEngineRun();
  const client = stubClient(refusals);
  const result = await runEnginePublishExecution({
    run,
    clientProjectId: "platform",
    envelopeCarriers: [run.stageOutputs.publication_controller, run.stageOutputs.publish_payload, run.stageOutputs.article_body],
    deps: { executionRepository: store, callTool: client.callTool }
  });
  return { result, client, output: (result as { ok: true; output: ExecutedPublishExecution }).output };
};

describe("a client refusal reaches the operator as a typed blocker with the client's own sentence", () => {
  it("names the refused TOOL and quotes the client, instead of complaining about our own parser", async () => {
    const { result, client, output } = await runEngine({
      object_create: clientRefusal("Invalid request fields.", [{ path: ["object_type"], message: "Invalid option: expected one of \"article\"|\"page\"" }])
    });

    // Nothing after the refused call was attempted, and no object was created.
    expect(client.calls).toEqual(["object_create"]);
    expect(output.publishCommitted).toBe(false);
    expect(output.receipts.objectId).toBeUndefined();

    // The blocker names the failing CLIENT TOOL — not a phase parsed out of our own message — and
    // PublishExecutionBlocker.clientError carries the client's sentence verbatim, with the
    // statusCode and the per-field issues it supplied.
    expect(output.blocker!.code).toBe("publish_step_failed");
    expect(output.blocker!.step).toBe("object_create");
    expect(output.blocker!.clientError).toContain("status 400");
    expect(output.blocker!.clientError).toContain("Invalid request fields.");
    expect(output.blocker!.clientError).toContain("object_type: Invalid option: expected one of");
    // ...and never the shape complaint that used to stand in for it.
    expect(output.blocker!.clientError).not.toContain("create_missing_object_id");
    expect(output.blockers[0]).toContain("publish_step_failed at object_create");

    // The receipts stop lying about the call: a refused step is a failed step.
    expect(output.receipts.steps).toEqual([{ tool: "object_create", ok: false, error: expect.stringContaining("Invalid request fields.") }]);
    expect(output.receipts.toolSequence).toEqual(["object_create"]);
    expect(validateOutput(output, getWorkspaceNode("publish_executor")?.outputSchema).ok).toBe(true);
    expect((result as { nodeBlocked: boolean }).nodeBlocked).toBe(true);
    expect((result as { warnings: string[] }).warnings).toEqual(["publish_execution_blocked:publish_step_failed", "publish_partial_client_writes:1"]);
  });

  it("treats a refusal at a LATER step no differently — object_publish is not a special case", async () => {
    const { client, output } = await runEngine({ object_publish: clientRefusal("publication window is closed for this site") });

    expect(client.calls).toEqual(["object_create", "object_checkout", "object_validate", "object_patch", "object_publish"]);
    expect(output.blocker!.code).toBe("publish_step_failed");
    expect(output.blocker!.step).toBe("object_publish");
    expect(output.blocker!.clientError).toContain("publication window is closed for this site");
    expect(output.publishCommitted).toBe(false);
    expect(validateOutput(output, getWorkspaceNode("publish_executor")?.outputSchema).ok).toBe(true);
  });

  it("leaves the healthy path untouched: every step lands and the receipts are the client's own facts", async () => {
    const { client, output } = await runEngine({});

    expect(client.calls).toEqual(["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"]);
    expect(output.publishCommitted).toBe(true);
    expect(output.receipts.objectId).toBe("obj_platform_9912");
    expect(output.receipts.commitSha).toBe("9f2c1ab4");
    expect(output.receipts.steps.every((step) => step.ok)).toBe(true);
    // T15.6: a committed publish is "published_pending_release" with no blocker — release_executor
    // (a separate, downstream tail node) performs the release.
    expect(output.status).toBe("published_pending_release");
    expect(output.blocker).toBeUndefined();
  });
});
