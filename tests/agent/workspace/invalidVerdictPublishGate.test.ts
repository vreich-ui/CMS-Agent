import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDeterministicPublishPayload,
  clientValidationFailedBlocker,
  promoteRecordedInvalidVerdictToBlocker,
  type PublishPayloadValidation
} from "../../../src/agent/workspace/publishPayload.js";
import { buildPublicationDecision, collectSourcedBlockers } from "../../../src/agent/workspace/publicationController.js";
import { promoteValidationWarningsToBlockers } from "../../../src/agent/workspace/articleBodyValidation.js";
import { evaluateDrLuriePublishReadiness } from "../../../src/agent/projects/drLurie/publishReadiness.js";
import { evaluateContentReadiness } from "../../../src/agent/projects/readinessContentChecks.js";
import { classifyBlockerSource } from "../../../src/agent/workspace/blockerClassification.js";
import { articleBodyFingerprint, readPublicationDecision, resolvePublishAuthority } from "../../../src/agent/workspace/publishDecision.js";
import { drLurieProjectConfig } from "../../../src/agent/projects/drLurie/definition.js";
import { stableHash } from "../../../src/agent/improvement/improvementTypes.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";

// W2 (2026-09-07) — PROOF THAT THE INTEGRITY PATH ALONE REFUSES AN INVALID BODY.
//
// dr-lurie was switched to publishingPolicy.autonomyMode "autonomous" on 2026-09-07. On
// run_1788769566432_5qnafb the thing that actually stopped an invalid article body from reaching
// publish_executor was the APPROVAL gate: publication_controller was refused for
// `operator_approval_absent` before it ever computed a decision, and the run recorded only
// `approval_required`. That gate does not fire for dr-lurie any more. Everything in this file exists
// to prove that what is left — the client verdict, carried as a blocker through publish_payload,
// publication_controller and the publish gate — refuses on its own, with no human in the loop.
//
// The suite is deliberately layered so a future regression names WHICH layer broke:
//   W2.1   the payload gate's own arithmetic (invalid raises, deferred does not, upstream carried);
//   W2.3   readiness reads the verdict at all (G1 — it never did);
//   W2.2   the whole conductor path under an autonomous policy snapshot with NO operator decision;
//   W2.4   the model fallback carries the same blocker (G2 — the one path that depended on a prompt);
//   W2.6   a revision turn that changed nothing is visible in the payload's own prose.

// The live run's rejection, verbatim: ONE issue object naming three problems joined by "; ".
const LIVE_ISSUE = {
  id: "schema_zod",
  label: "Per-type schema",
  status: "missing",
  message:
    "nodes.24.private.strategy: Invalid option: expected one of \"hook\"|\"agitation\"|\"context\"|\"explanation\"|\"proof\"|\"example\"|\"comparison\"|\"myth\"|\"step\"|\"recommendation\"|\"resolution\"|\"summary\"; nodes.28.public.items.0: Invalid input: expected string, received array; nodes.28.public.items.1: Invalid input: expected string, received array"
};

// A body that clears the readiness content floor (MIN_VISIBLE_CONTENT_CHARS) and carries the live
// run's two defects in the two fields the client rejected, so the fixture is recognisably the run.
const sampleBody = () => ({
  slug: "retinoid-tolerance",
  title: "Building retinoid tolerance without wrecking your barrier",
  nodes: [
    {
      id: "n_intro",
      kind: "paragraph",
      public: {
        text: "Most retinoid trouble is not an allergy and not a bad product; it is a pace problem. The barrier adapts, but it adapts on its own timetable, and pushing past that timetable is what produces the stinging, flaking and tightness people mistake for a reaction. This piece sets out what to watch for and when to slow down."
      }
    },
    { id: "n_p14", kind: "paragraph", public: { text: "Mild dryness in week two is expected." }, private: { strategy: "reassurance", intent: "reassure" } },
    { id: "n_box", kind: "callout", public: { items: [["Continue cautiously", "If symptoms are mild and improving."], ["Hold", "If the skin is not calm but symptoms are not escalating."]] } }
  ]
});

const articleBodyEnvelope = (clientValidation?: unknown, overrides: Record<string, unknown> = {}) => ({
  artifact: "client_object.v1",
  summary: "Client object built to the fetched dr-lurie content_item contract.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-31T00:00:00.000Z", fingerprint: "0fc47972" },
  body: sampleBody(),
  blockers: [],
  ...(clientValidation ? { clientValidation } : {}),
  ...overrides
});

// The engine loop's own record, exactly as run_1788769566432_5qnafb wrote it: source, attempted,
// valid:false, and a fingerprint over the body it was earned against (which is what lets
// publish_payload reuse it instead of re-validating).
const recordedInvalidVerdict = (body: Record<string, unknown> = sampleBody()) => ({
  attempted: true,
  tool: "object_validate",
  valid: false,
  issues: [LIVE_ISSUE],
  candidate_patch_summary: "30 ops",
  source: "engine_validation_loop",
  bodyFingerprint: stableHash(body),
  engineLoop: { revalidations: 1, revisionTurns: 1, mechanicalFixes: [], outcome: "invalid", boundedExhaustion: true, revisionChangedBody: false }
});

const recordedDeferredVerdict = (body: Record<string, unknown> = sampleBody()) => ({
  attempted: true,
  tool: "object_validate",
  valid: false,
  issues: ["validate requires an existing object_id"],
  deferred: "requires_existing_object",
  source: "engine_validation_loop",
  bodyFingerprint: stableHash(body),
  engineLoop: { revalidations: 0, revisionTurns: 0, mechanicalFixes: [], outcome: "deferred", boundedExhaustion: false, revisionChangedBody: false }
});

const invalidValidation = (): PublishPayloadValidation => recordedInvalidVerdict() as unknown as PublishPayloadValidation;
const deferredValidation = (): PublishPayloadValidation => recordedDeferredVerdict() as unknown as PublishPayloadValidation;

// ---------------------------------------------------------------------------------------------
// W2.1 — the payload gate's own arithmetic.
// ---------------------------------------------------------------------------------------------
describe("W2.1 — buildDeterministicPublishPayload is the gate: it raises client_validation_failed, and never on a deferral", () => {
  it("raises client_validation_failed on {attempted:true, valid:false}, quoting the client's own issue", () => {
    const built = buildDeterministicPublishPayload({ articleBody: articleBodyEnvelope(), clientProjectId: "dr-lurie" }, invalidValidation());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.payload.blockers).toEqual([expect.stringContaining("client_validation_failed")]);
    // The blocker carries the client's own words, not a paraphrase — an operator reading the run
    // record must be able to see WHICH fields were rejected without opening the client.
    expect(built.payload.blockers[0]).toContain("nodes.24.private.strategy");
    expect(built.payload.blockers[0]).toContain("nodes.28.public.items.0");
    // Completing WITH a blocker is the designed behaviour: the node did its job and said no.
    expect(built.payload.summary).toContain("client validator invalid");
    expect(built.payload.summary).toContain("1 blocker(s)");
  });

  it("raises NO own blocker on a requires_existing_object deferral, and carries every upstream blocker through unchanged", () => {
    const upstream = ["taxonomy_unresolved: term 'barrier-repair' is unknown", "artifact_unverified: hero slot has no materialization evidence"];
    const built = buildDeterministicPublishPayload(
      { articleBody: articleBodyEnvelope(undefined, { blockers: upstream }), clientProjectId: "dr-lurie" },
      deferredValidation()
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Identical to the upstream list: nothing added (no own blocker on a deferral) and nothing
    // removed (resolveBlockers only ever clears on an explicit valid:true, which this is not).
    expect(built.payload.blockers).toEqual(upstream);
    expect(built.payload.blockers.some((blocker) => blocker.includes("client_validation_failed"))).toBe(false);
    expect(built.payload.validationAssumptions.some((assumption) => assumption.includes("NORMAL deferral"))).toBe(true);
  });

  it("a deferral with NO upstream blockers produces an empty blocker list — the publishable dry-run case", () => {
    const built = buildDeterministicPublishPayload({ articleBody: articleBodyEnvelope(), clientProjectId: "dr-lurie" }, deferredValidation());
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.payload.blockers).toEqual([]);
  });

  it("clientValidationFailedBlocker is silent for every verdict that is not a rejection", () => {
    expect(clientValidationFailedBlocker(deferredValidation())).toBeUndefined();
    expect(clientValidationFailedBlocker({ attempted: true, tool: "object_validate", valid: true, issues: [] })).toBeUndefined();
    // Unreachable is a DIFFERENT statement (client_validation_unavailable) with a different meaning.
    expect(clientValidationFailedBlocker({ attempted: false, tool: "object_validate", valid: false, issues: [], error: "ECONNREFUSED" })).toBeUndefined();
    expect(clientValidationFailedBlocker(invalidValidation())).toContain("client_validation_failed");
  });
});

// ---------------------------------------------------------------------------------------------
// W2.3 / G1 — readiness reads the client verdict.
// ---------------------------------------------------------------------------------------------
describe("W2.3 (G1) — readiness now reads the client's verdict, not just the workspace schema", () => {
  const checkNamed = (checks: ReturnType<typeof evaluateContentReadiness>, key: string) => checks.find((check) => check.key === key)!;

  it("FAILS client_validation_verdict on a recorded engine rejection", () => {
    const checks = evaluateContentReadiness({ articleBody: articleBodyEnvelope(recordedInvalidVerdict()), articleBodyValid: true });
    const check = checkNamed(checks, "client_validation_verdict");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("REJECTED");
    expect(check.detail).toContain("nodes.24.private.strategy");
  });

  it("PASSES on a deferral and on an accepted body, and is accepted_empty when no engine verdict exists", () => {
    expect(checkNamed(evaluateContentReadiness({ articleBody: articleBodyEnvelope(recordedDeferredVerdict()), articleBodyValid: true }), "client_validation_verdict").status).toBe("pass");
    expect(checkNamed(evaluateContentReadiness({ articleBody: articleBodyEnvelope({ ...recordedInvalidVerdict(), valid: true, issues: [] }), articleBodyValid: true }), "client_validation_verdict").status).toBe("pass");
    expect(checkNamed(evaluateContentReadiness({ articleBody: articleBodyEnvelope(), articleBodyValid: true }), "client_validation_verdict").status).toBe("accepted_empty");
  });

  it("will not gate on a clientValidation a MODEL typed into its own envelope — only the engine's record counts", () => {
    // Same fields, no `source`. A model claiming its own body is invalid (or valid) is a claim, not a
    // verdict; readRecordedValidation applies the identical rule downstream.
    const modelTyped = { attempted: true, tool: "object_validate", valid: false, issues: ["I think this is wrong"] };
    expect(checkNamed(evaluateContentReadiness({ articleBody: articleBodyEnvelope(modelTyped), articleBodyValid: true }), "client_validation_verdict").status).toBe("accepted_empty");
  });

  it("turns the whole dr-lurie readiness verdict to no_go — the gap G1 closed", () => {
    // The exact live shape: a body that satisfies the WORKSPACE outputSchema (article_body_valid
    // passes) and declares no blockers of its own, over a client verdict of invalid. Before this
    // check, every dr-lurie readiness item passed and the checklist said "go".
    const readiness = evaluateDrLuriePublishReadiness({ articleBody: articleBodyEnvelope(recordedInvalidVerdict()) });
    expect(readiness.checklist.find((check) => check.key === "article_body_valid")?.status).toBe("pass");
    expect(readiness.checklist.find((check) => check.key === "article_body_blockers")?.status).toBe("pass");
    expect(readiness.status).toBe("no_go");
    expect(readiness.blockers).toContain("client_validation_verdict");

    // And it is INTEGRITY by class, so it can never be demoted to an advisory.
    expect(classifyBlockerSource("publish_readiness").class).toBe("integrity");
  });

  it("still says go on a deferred verdict — the normal dry-run outcome must not become a gate", () => {
    expect(evaluateDrLuriePublishReadiness({ articleBody: articleBodyEnvelope(recordedDeferredVerdict()) }).status).toBe("go");
  });
});

// ---------------------------------------------------------------------------------------------
// The upstream-blocker route in isolation: publish_payload's blocker alone produces "blocked".
// ---------------------------------------------------------------------------------------------
describe("W2.2 (isolated) — publish_payload's blocker alone blocks the decision, with readiness fully green", () => {
  it("readiness go + publish_payload: client_validation_failed -> decision \"blocked\" naming it", () => {
    // Readiness is computed over an envelope with NO client verdict recorded, so every readiness item
    // passes: this isolates the braces (the upstream INTEGRITY blocker) from the belt (G1's check),
    // and proves the pre-G1 refusal path is intact and did not merely move.
    const readiness = evaluateDrLuriePublishReadiness({ articleBody: articleBodyEnvelope() });
    expect(readiness.status).toBe("go");

    const payload = buildDeterministicPublishPayload({ articleBody: articleBodyEnvelope(), clientProjectId: "dr-lurie" }, invalidValidation());
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    const decision = buildPublicationDecision({
      readiness,
      clientProjectId: "dr-lurie",
      contentClass: "client_property",
      upstreamBlockers: collectSourcedBlockers([{ nodeId: "publish_payload", output: payload.payload }])
    });

    expect(decision.decision).toBe("blocked");
    expect(decision.state).toBe("blocked_for_publish_execution");
    expect(decision.blockers).toEqual([expect.stringMatching(/^publish_payload: client_validation_failed/)]);
    // Never demoted to advice: publish_payload is INTEGRITY in blockerClassification's table.
    expect(decision.advisories).toEqual([]);
    expect(decision.waivedBlockers).toEqual([]);
    // The publish gate's own reader refuses it.
    expect(readPublicationDecision(decision)).toMatchObject({ authorized: false, code: "controller_decision_not_go" });
  });

  it("own-property content cannot waive it — the standing waiver covers EV floor and aggression ceiling only", () => {
    const payload = buildDeterministicPublishPayload({ articleBody: articleBodyEnvelope(), clientProjectId: "dr-lurie" }, invalidValidation());
    if (!payload.ok) throw new Error("payload build failed");
    const decision = buildPublicationDecision({
      readiness: evaluateDrLuriePublishReadiness({ articleBody: articleBodyEnvelope() }),
      clientProjectId: "dr-lurie",
      contentClass: "own_property",
      upstreamBlockers: collectSourcedBlockers([{ nodeId: "publish_payload", output: payload.payload }])
    });
    expect(decision.decision).toBe("blocked");
    expect(decision.waivedBlockers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// W2.2 — the whole conductor path, autonomous, no operator decision. THE test.
// ---------------------------------------------------------------------------------------------
describe("W2.2 — under autonomyMode \"autonomous\" with NO operator decision, an invalid body cannot reach object_patch", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    // Any client call at all is a failure of this test's premise (the recorded verdict is reused, and
    // a refused publish makes no client call), so the stub exists to COUNT, not to answer.
    remoteFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: {} }) }) as unknown as Response);
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  // The live configuration change, reproduced: dr-lurie's own project config with
  // publishingPolicy.autonomyMode "autonomous", captured into the run's publishingPolicySnapshot at
  // creation exactly as it is in production. NO operator decision is ever recorded on the run.
  const startAutonomousRun = async (clientValidation: unknown) => {
    const manager = new RepositoryManager();
    const store = manager.getExecutionRepository();
    const workspace = manager.getWorkspaceRepository();
    const projects = manager.getProjectRepository();
    await projects.save({ ...drLurieProjectConfig, publishingPolicy: { ...drLurieProjectConfig.publishingPolicy, autonomyMode: "autonomous" } });
    // publish_payload already carries publishPayloadDeterministic in the canonical seed; the other two
    // deterministic routes are opt-in per node, exactly as the production workspace sets them.
    await workspace.updateNode("publication_controller", { metadata: { publicationControllerDeterministic: true } }, { actor: "w2-test" });
    await workspace.updateNode("publish_executor", { metadata: { publishExecutorDeterministic: true } }, { actor: "w2-test" });

    const started = await startDryRun({
      executionMode: "openai",
      projectId: "dr-lurie",
      input: "W2 autonomous publish-gate proof",
      budgetUsd: 100,
      entrypoint: { nodeId: "article_body", output: articleBodyEnvelope(clientValidation) }
    }, store, workspace, projects);

    expect(started.publishingPolicySnapshot?.autonomyMode).toBe("autonomous");
    // The whole point: no human has said anything about this run, in either direction.
    expect(started.operatorPublishDecision).toBeUndefined();
    expect(resolvePublishAuthority(started)).toEqual({ authorized: true, source: "policy_autonomous" });
    return { runId: started.runId, store, workspace };
  };

  const advanceTo = async (runId: string, store: ReturnType<RepositoryManager["getExecutionRepository"]>, workspace: ReturnType<RepositoryManager["getWorkspaceRepository"]>, nodeId: string) => {
    for (let step = 0; step < 6; step += 1) {
      await runNextNode(runId, { executionRepository: store, workspaceRepository: workspace });
      const run = (await getRun(runId, store))!;
      const state = run.nodes.find((node) => node.nodeId === nodeId)!;
      if (state.status === "completed" || state.status === "blocked" || state.status === "failed") return run;
    }
    throw new Error(`${nodeId} never reached a terminal state`);
  };

  it("refuses at publish_executor with publication_decision_not_affirmative — and the approval gate never fires", async () => {
    const { runId, store, workspace } = await startAutonomousRun(recordedInvalidVerdict());

    // 1. publish_payload — the deterministic route reuses article_body's engine-earned verdict and
    //    completes WITH the integrity blocker. Completing is correct; the blocker is the refusal.
    const afterPayload = await advanceTo(runId, store, workspace, "publish_payload");
    const payloadState = afterPayload.nodes.find((node) => node.nodeId === "publish_payload")!;
    expect(payloadState.status).toBe("completed");
    const payload = payloadState.output as { blockers: string[]; summary: string };
    expect(payload.blockers).toEqual([expect.stringContaining("client_validation_failed")]);
    expect(payload.summary).toContain("No model call");

    // 2. publication_controller — reached at all only because the autonomy gate let it through on
    //    policy_autonomous authority. On the live run this node never got this far: it was refused
    //    for operator_approval_absent and never computed a decision.
    const afterController = await advanceTo(runId, store, workspace, "publication_controller");
    const controllerState = afterController.nodes.find((node) => node.nodeId === "publication_controller")!;
    expect(controllerState.status).toBe("completed");
    expect(controllerState.warnings ?? []).not.toContain("approval_required");
    const decision = controllerState.output as { decision: string; blockers: string[]; advisories: unknown[] };

    // Both refusals are present and both are INTEGRITY: readiness's own client_validation_verdict
    // (W2.3's belt) and publish_payload's client_validation_failed (the braces). The decision reads
    // "no_go" rather than "blocked" ONLY because readiness itself now fails first — before W2.3 this
    // same shape produced "blocked"; the isolated suite above pins that route separately. Either
    // verdict is non-affirmative and refuses identically at the gate.
    expect(decision.decision).not.toBe("go");
    expect(decision.blockers).toContain("publish_readiness: client_validation_verdict");
    expect(decision.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/^publish_payload: client_validation_failed/)]));
    expect(decision.advisories).toEqual([]);
    expect(readPublicationDecision(decision, { bodyFingerprint: articleBodyFingerprint(afterController.stageOutputs.article_body) })).toMatchObject({ authorized: false });

    // 3. publish_executor — the node that would call object_patch. It never dispatches.
    const afterExecutor = await advanceTo(runId, store, workspace, "publish_executor");
    const executorState = afterExecutor.nodes.find((node) => node.nodeId === "publish_executor")!;
    expect(executorState.status).toBe("blocked");
    const refusal = executorState.output as { decision: string; approvalRequired: boolean; reason: string };
    expect(refusal.decision).toBe("blocked");
    expect(refusal.reason).toContain("publication_decision_not_affirmative");
    expect(executorState.warnings ?? []).toContain("publication_decision_not_affirmative");
    expect(executorState.warnings ?? []).toContain("no_publication_performed");

    // THE CLAIM OF THIS WHOLE WAVE, stated as an assertion: the approval gate contributed NOTHING.
    // No approval_required warning, no approvalRequired flag, no pending approval on the run — the
    // refusal is the integrity path's alone, exactly as it must be under an autonomous policy.
    expect(executorState.warnings ?? []).not.toContain("approval_required");
    expect(executorState.warnings ?? []).not.toContain("operator_publish_withheld");
    expect(refusal.approvalRequired).toBe(false);
    expect(afterExecutor.approvalsRequired.every((approval) => approval.source === "policy_autonomous")).toBe(true);
    expect(afterExecutor.status).toBe("blocked");

    // Nothing was ever said to the client: no object_create, no object_patch, no object_publish.
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("COUNTER-CASE: the same run with a deferred verdict reaches decision \"go\" and an authorized gate", async () => {
    const { runId, store, workspace } = await startAutonomousRun(recordedDeferredVerdict());

    const afterPayload = await advanceTo(runId, store, workspace, "publish_payload");
    // A deferral raises no own blocker — the client refusing to validate an object that does not
    // exist yet is the NORMAL dry-run outcome, and treating it as a rejection would make every
    // first-time article unpublishable.
    expect((afterPayload.nodes.find((node) => node.nodeId === "publish_payload")!.output as { blockers: string[] }).blockers).toEqual([]);

    const afterController = await advanceTo(runId, store, workspace, "publication_controller");
    const decision = afterController.nodes.find((node) => node.nodeId === "publication_controller")!.output as { decision: string; blockers: string[] };
    expect(decision.decision).toBe("go");
    expect(decision.blockers).toEqual([]);

    // The gate would authorize: an explicit controller "go" against THIS body, plus autonomous
    // authority with no operator decision. Deliberately not dispatched — publish_executor's execute
    // half is a live publish, and this assertion is about reachability, not about publishing.
    const run = (await getRun(runId, store))!;
    expect(readPublicationDecision(decision, { bodyFingerprint: articleBodyFingerprint(run.stageOutputs.article_body) })).toEqual({ authorized: true, decision: "go" });
    expect(resolvePublishAuthority(run)).toEqual({ authorized: true, source: "policy_autonomous" });
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// W2.4 / G2 — the model fallback path.
// ---------------------------------------------------------------------------------------------
describe("W2.4 (G2) — a model-built publish_payload carries the same blocker, in the same words", () => {
  const modelPayload = (blockers: unknown[] = []) => ({
    artifact: "dry_run_publish_payload.v1",
    summary: "Model-assembled dry-run publish candidate.",
    clientProjectId: "dr-lurie",
    clientObjectType: "content_item",
    contractSource: { fingerprint: "0fc47972" },
    dryRun: true,
    clientObject: sampleBody(),
    blockers
  });

  it("injects client_validation_failed when article_body recorded an invalid verdict for this body", () => {
    const output = modelPayload();
    const promoted = promoteRecordedInvalidVerdictToBlocker(output, articleBodyEnvelope(recordedInvalidVerdict())) as { blockers: string[] };
    expect(promoted).not.toBe(output);
    expect(promoted.blockers).toEqual([expect.stringContaining("client_validation_failed")]);
    // IDENTICAL WORDING to the deterministic route — the same function produced both, so the two
    // paths cannot drift and a de-duplicating reader sees one blocker, not two near-misses.
    const deterministic = buildDeterministicPublishPayload({ articleBody: articleBodyEnvelope(), clientProjectId: "dr-lurie" }, invalidValidation());
    if (!deterministic.ok) throw new Error("deterministic build failed");
    expect(promoted.blockers[0]).toBe(deterministic.payload.blockers[0]);
    // Copy-on-write: the model's own output object is not mutated.
    expect(output.blockers).toEqual([]);
  });

  it("is idempotent, and preserves the model's own blockers alongside it", () => {
    const output = modelPayload(["taxonomy_unresolved: term 'barrier-repair'"]);
    const once = promoteRecordedInvalidVerdictToBlocker(output, articleBodyEnvelope(recordedInvalidVerdict())) as { blockers: string[] };
    expect(once.blockers).toEqual(["taxonomy_unresolved: term 'barrier-repair'", expect.stringContaining("client_validation_failed")]);
    expect(promoteRecordedInvalidVerdictToBlocker(once, articleBodyEnvelope(recordedInvalidVerdict()))).toBe(once);
  });

  it("injects NOTHING on a deferral, a pass, an absent record, or a verdict about a different body", () => {
    const untouched = (articleBody: unknown) => {
      const output = modelPayload();
      expect(promoteRecordedInvalidVerdictToBlocker(output, articleBody)).toBe(output);
    };
    untouched(articleBodyEnvelope(recordedDeferredVerdict()));
    untouched(articleBodyEnvelope({ ...recordedInvalidVerdict(), valid: true, issues: [] }));
    untouched(articleBodyEnvelope());
    untouched(undefined);
    // A model-typed clientValidation is a claim, not a verdict (no `source`).
    untouched(articleBodyEnvelope({ attempted: true, tool: "object_validate", valid: false, issues: ["nope"] }));
    // A verdict earned against a DIFFERENT body is void: a verdict is about an object, and asserting
    // one about another object is exactly the failure the fingerprint exists to prevent.
    untouched(articleBodyEnvelope(recordedInvalidVerdict({ slug: "some-other-article", nodes: [] })));
  });

  it("the injected blocker is INTEGRITY at the controller, so the model path blocks exactly like the deterministic one", () => {
    const promoted = promoteRecordedInvalidVerdictToBlocker(modelPayload(), articleBodyEnvelope(recordedInvalidVerdict()));
    const decision = buildPublicationDecision({
      readiness: evaluateDrLuriePublishReadiness({ articleBody: articleBodyEnvelope() }),
      clientProjectId: "dr-lurie",
      contentClass: "client_property",
      upstreamBlockers: collectSourcedBlockers([{ nodeId: "publish_payload", output: promoted }])
    });
    expect(decision.decision).toBe("blocked");
    expect(decision.blockers).toEqual([expect.stringMatching(/^publish_payload: client_validation_failed/)]);
    expect(readPublicationDecision(decision)).toMatchObject({ authorized: false });
  });
});

// ---------------------------------------------------------------------------------------------
// W2.5 / G3 — the earliest node that knows stops being silent.
// ---------------------------------------------------------------------------------------------
describe("W2.5 (G3) — an invalid verdict becomes an article_body blocker, which readiness already refuses", () => {
  it.each(["article_body_validation_loop_exhausted", "article_body_validation_invalid"])(
    "%s reaches article_body.blockers and fails the EXISTING article_body_blockers check — no new gate needed",
    (warning) => {
      const envelope = articleBodyEnvelope(recordedInvalidVerdict());
      // On run_1788769566432_5qnafb this warning was raised and article_body still completed with
      // blockers: [] — the node that had just been told "no" by the client said nothing about it.
      const before = evaluateContentReadiness({ articleBody: envelope, articleBodyValid: true });
      expect(before.find((check) => check.key === "article_body_blockers")!.status).toBe("pass");

      const promoted = promoteValidationWarningsToBlockers(envelope, [warning]);
      const after = evaluateContentReadiness({ articleBody: promoted, articleBodyValid: true });
      const check = after.find((entry) => entry.key === "article_body_blockers")!;
      expect(check.status).toBe("fail");
      expect(check.detail).toContain(warning);

      // article_body is INTEGRITY, and so is the readiness pseudo-source: neither can be demoted.
      expect(classifyBlockerSource("article_body").class).toBe("integrity");
      // Belt and braces both engaged, from one verdict.
      expect(after.find((entry) => entry.key === "client_validation_verdict")!.status).toBe("fail");
    }
  );

  it("a valid or deferred loop outcome adds nothing — the promotion is keyed on the verdict, not on the loop running", () => {
    const envelope = articleBodyEnvelope(recordedDeferredVerdict());
    // A deferred/valid outcome never emits either rejection warning in the first place; with none to
    // promote, the envelope comes back by reference and readiness is untouched.
    expect(promoteValidationWarningsToBlockers(envelope, ["article_body_revision_failed:provider_error"])).toBe(envelope);
    expect(evaluateContentReadiness({ articleBody: envelope, articleBodyValid: true }).find((check) => check.key === "article_body_blockers")!.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------------------------
// W2.6 — a revision turn that changed nothing is visible where an operator reads.
// ---------------------------------------------------------------------------------------------
describe("W2.6 — the payload's validationAssumptions report whether the revision turn changed the body", () => {
  const assumptionsFor = (engineLoop: Record<string, unknown>) => {
    const validation = { ...recordedInvalidVerdict(), engineLoop } as unknown as PublishPayloadValidation;
    const built = buildDeterministicPublishPayload({ articleBody: articleBodyEnvelope(), clientProjectId: "dr-lurie" }, validation);
    if (!built.ok) throw new Error("build failed");
    return built.payload.validationAssumptions.join(" ");
  };

  it("names a no-op revision explicitly — the live run's shape (1 turn, 0 mechanical fixes, nothing changed)", () => {
    const prose = assumptionsFor({ revalidations: 1, revisionTurns: 1, mechanicalFixes: [], outcome: "invalid", boundedExhaustion: true, revisionChangedBody: false });
    expect(prose).toContain("1 model revision turn(s)");
    expect(prose).toContain("changed NOTHING");
  });

  it("says so when the revision DID change the body (a real edit that still did not satisfy the client)", () => {
    expect(assumptionsFor({ revalidations: 1, revisionTurns: 1, mechanicalFixes: [], outcome: "invalid", boundedExhaustion: true, revisionChangedBody: true })).toContain("did change the body");
  });

  it("stays silent when no revision turn was spent — 'changed nothing' would be true and meaningless", () => {
    const prose = assumptionsFor({ revalidations: 1, revisionTurns: 0, mechanicalFixes: ["strategy_enum:nodes[24]:reassurance→resolution"], outcome: "valid", boundedExhaustion: false, revisionChangedBody: false });
    expect(prose).not.toContain("changed NOTHING");
    expect(prose).not.toContain("did change the body");
    expect(prose).toContain("strategy_enum:nodes[24]:reassurance→resolution");
  });

  it("stays silent for a record written before revisionChangedBody existed", () => {
    expect(assumptionsFor({ revalidations: 1, revisionTurns: 1, mechanicalFixes: [], outcome: "invalid", boundedExhaustion: true })).not.toContain("changed NOTHING");
  });
});
