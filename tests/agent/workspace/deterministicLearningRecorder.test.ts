import { describe, expect, it } from "vitest";
import { buildCaptureFacts, buildCloneFacts, buildGateEvents, buildLearningObservations, buildNodeFacts, collectRunBlockers } from "../../../src/agent/workspace/learningRecord.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import type { ModelUsageSummary } from "../../../src/agent/observability/modelUsageTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

// W2b (determinism program, 2026-08-12). learning_recorder records what the run DID, and every one of
// those facts already exists on the run record or the usage ledger. This suite proves:
//   (1) the record is templated from structured facts — node statuses, warnings, errors, durations,
//       per-node cost — with nothing paraphrased or invented;
//   (2) the gate events are captured, including W6.1's waiver audit trail;
//   (3) an unreadable usage ledger reports cost as UNKNOWN (null), never as $0;
//   (4) wired into a real run it replaces the model call entirely.

const usageSummary = (overrides: Partial<ModelUsageSummary> = {}): ModelUsageSummary => ({
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  reasoningTokens: 0,
  costUsdEstimate: 1.5,
  recordCount: 2,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  totalReasoningTokens: 0,
  totalCostUsdEstimate: 1.5,
  actualCostUsdEstimate: 1.5,
  estimatedCostUsdEstimate: 0,
  byModel: {},
  byNode: { draft_writer: { inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 0, costUsdEstimate: 1.5, recordCount: 2 } },
  byProject: {},
  ...overrides
});

const sampleRun = (overrides: Partial<WorkflowExecutionRecord> = {}) => ({
  runId: "run_sample_w2b",
  status: "completed" as const,
  errors: [],
  approvalsRequired: [],
  nodes: [
    { nodeId: "input_triage", status: "completed" as const, durationMs: 12 },
    { nodeId: "draft_writer", status: "completed" as const, durationMs: 4200 },
    { nodeId: "contract_intelligence", status: "completed" as const, durationMs: 3, warnings: ["contract_prefetch_failed:timeout"] },
    { nodeId: "publication_controller", status: "completed" as const, durationMs: 2 },
    { nodeId: "publish_executor", status: "completed" as const, durationMs: 1 },
    { nodeId: "learning_recorder", status: "running" as const },
    { nodeId: "never_reached", status: "queued" as const }
  ],
  stageOutputs: {
    contract_intelligence: { artifact: "contract_intelligence.v1", blockers: ["aggression_ceiling_missing: no ceiling declared."] },
    publication_controller: {
      artifact: "publication_decision.v1",
      decision: "go",
      blockers: [],
      contentClass: "own_property",
      waivedBlockers: [{ nodeId: "contract_intelligence", blocker: "aggression_ceiling_missing: no ceiling declared.", rule: "own_property_ev_and_aggression_exemption", reason: "standing rule" }]
    },
    publish_executor: { artifact: "publish_execution.v1", status: "blocked", approvalMatched: false, blockers: ["operator_approval_absent: ..."] }
  },
  ...overrides
}) as unknown as WorkflowExecutionRecord;

describe("W2b — the record is templated over structured run facts", () => {
  it("reports every dispatched node's status, duration, warnings and ledger cost — and skips queued nodes", () => {
    const facts = buildNodeFacts(sampleRun(), usageSummary());

    expect(facts.map((fact) => fact.nodeId)).toEqual(["input_triage", "draft_writer", "contract_intelligence", "publication_controller", "publish_executor", "learning_recorder"]);
    expect(facts.find((fact) => fact.nodeId === "draft_writer")).toMatchObject({ status: "completed", durationMs: 4200, costUsdEstimate: 1.5 });
    expect(facts.find((fact) => fact.nodeId === "contract_intelligence")?.warnings).toEqual(["contract_prefetch_failed:timeout"]);
  });

  it("marks a completed node with no usage record as deterministic — the determinism program's own scoreboard", () => {
    const facts = buildNodeFacts(sampleRun(), usageSummary());
    expect(facts.find((fact) => fact.nodeId === "publication_controller")?.deterministic).toBe(true);
    expect(facts.find((fact) => fact.nodeId === "draft_writer")?.deterministic).toBeUndefined();
    // A node that did not complete is not claimed as deterministic either.
    expect(facts.find((fact) => fact.nodeId === "learning_recorder")?.deterministic).toBeUndefined();
  });

  it("captures the gate events, including the W6.1 waiver audit trail", () => {
    const events = buildGateEvents(sampleRun());
    const byEvent = Object.fromEntries(events.map((event) => [event.event, event.detail]));

    expect(byEvent.publication_decision).toMatch(/decided "go" with 0 blocker/);
    expect(byEvent.blockers_waived).toMatch(/own_property_ev_and_aggression_exemption/);
    expect(byEvent.blockers_waived).toMatch(/contract_intelligence/);
    expect(byEvent.content_class).toMatch(/own_property/);
    expect(byEvent.operator_publish_decision).toMatch(/absent; absence never authorizes/);
    expect(byEvent.publish_execution).toMatch(/status "blocked"/);
  });

  it("records approval holds and budget halts as gate events", () => {
    const events = buildGateEvents(sampleRun({
      approvalsRequired: [{ nodeId: "publish_executor", type: "approval_required", reason: "explicit approval required", requestedAt: "2026-08-12T10:00:00.000Z" }],
      budgetBlock: { blockedAt: "2026-08-12T10:00:00.000Z", budgetUsd: 5, spentUsdEstimate: 5.2, nextNodeId: "publish_payload", reason: "Run paused for budget" },
      operatorPublishDecision: "approved"
    }));
    const byEvent = Object.fromEntries(events.map((event) => [event.event, event.detail]));

    expect(byEvent.approval_required).toMatch(/publish_executor/);
    expect(byEvent.budget_halt).toMatch(/ceiling \$5, spent \$5.2/);
    expect(byEvent.operator_publish_decision).toMatch(/"approved"/);
  });

  it("names every upstream blocker with the node that raised it", () => {
    expect(collectRunBlockers(sampleRun())).toEqual([
      "contract_intelligence: aggression_ceiling_missing: no ceiling declared.",
      "publish_executor: operator_approval_absent: ..."
    ]);
  });

  it("produces a record that satisfies the node's own outputSchema", () => {
    const output = buildLearningObservations({ run: sampleRun(), usage: usageSummary() });
    expect(validateOutput(output, getWorkspaceNode("learning_recorder")?.outputSchema).ok).toBe(true);
    expect(output.artifact).toBe("learning_observations.v1");
    expect(output.summary).toMatch(/No model call/);
    expect(output.cost.actualUsd).toBe(1.5);
    expect(output.observations.some((line) => line.startsWith("[publication_decision]"))).toBe(true);
  });

  it("reports cost as UNKNOWN, never as $0, when the usage ledger could not be read", () => {
    const output = buildLearningObservations({ run: sampleRun(), usageError: "usage repository unavailable" });
    expect(output.cost).toEqual({ actualUsd: null, estimatedUsd: null, totalUsd: null, recordCount: null, source: expect.stringContaining("unavailable") });
    expect(output.observations.some((line) => line.includes("could not be read"))).toBe(true);
    expect(output.unresolvedQuestions.some((line) => line.includes("What did this run cost?"))).toBe(true);
  });

  it("records a failed node's own error codes verbatim rather than a paraphrase", () => {
    const output = buildLearningObservations({
      run: sampleRun({ status: "failed", errors: ["draft_writer:model_error"], nodes: [{ nodeId: "draft_writer", status: "failed", errors: ["model_error", "provider refused"] }] as never }),
      usage: usageSummary()
    });
    expect(output.observations.some((line) => line === "Node draft_writer FAILED: model_error; provider refused.")).toBe(true);
    expect(output.runStatus).toBe("failed");
  });
});

// T15.15 (#194) — learning parity: capture_conductor and clone_conductor now compose the shared
// publishing tail (T15.7/#187, T15.10/#189), so learning_recorder dispatches for them exactly as it
// does for publishing_conductor. This suite proves their OWN facts — fidelity, the gap ledger,
// quarantines with reasons, the recipe mint/theme/restamp ledgers, the capability backlog — reach
// learning_observations.v1 through the SAME templated envelope, never a forked recorder, and that the
// facts read are all TRANSITIVE ANCESTORS of learning_recorder's own dependsOn (never a sibling like
// gap_adjudicator or the terminal *_report nodes), so the record cannot vary by dispatch order.
const captureRun = (overrides: Partial<WorkflowExecutionRecord> = {}) => ({
  runId: "run_capture_w15_15",
  status: "completed" as const,
  errors: [],
  approvalsRequired: [],
  nodes: [],
  stageOutputs: {
    capture_crawl: {
      artifact: "capture_snapshot.v1",
      summary: "fixture",
      sourceUrl: "https://source.example/",
      jobId: "job_c1",
      snapshot: { schemaVersion: "capture-snapshot.v1", capture: {}, pages: [{}, {}, {}], diagnostics: { quarantined: [{ objectId: "page_3", reason: "robots_disallowed" }] } }
    },
    capture_score: {
      artifact: "capture_fidelity.v1",
      summary: "fixture",
      rubric: {
        verdict: "needs_governed_iteration",
        coverage: { score: 0.82, mappedBlocks: 41, relevantBlocks: 50, minimum: 0.9, met: false },
        tokensComplete: { value: true, required: true, met: true },
        gapsEnumerated: { value: true, required: true, met: true }
      },
      report: {
        gapReport: {
          schemaVersion: "capture-palette-gaps.v1",
          entries: [{ gapId: "gap_1" }, { gapId: "gap_2" }],
          byCapability: [{ missingCapability: "pricing_table", count: 2, gapIds: ["gap_1", "gap_2"] }]
        }
      }
    },
    capture_emit_live: {
      artifact: "capture_emission_run.v1",
      summary: "fixture",
      report: {
        createdObjects: [{ objectId: "sec_1" }, { objectId: "sec_2" }],
        reusedObjects: [{ objectId: "sec_3" }],
        quarantines: [{ requestedId: "sec_4", reason: "postcreate_validation_failed", detail: "schema mismatch" }]
      }
    }
  },
  ...overrides
}) as unknown as WorkflowExecutionRecord;

const cloneRun = (overrides: Partial<WorkflowExecutionRecord> = {}) => ({
  runId: "run_clone_w15_15",
  status: "completed" as const,
  errors: [],
  approvalsRequired: [],
  nodes: [],
  stageOutputs: {
    recipe_designer: {
      artifact: "clone_recipe_design.v1",
      summary: "fixture",
      sectionTemplates: [],
      templates: [],
      unmetNeeds: [{ sectionType: "pricing_table" }, { sectionType: "pricing_table" }, { sectionType: "video_embed" }]
    },
    recipe_mint: {
      artifact: "clone_recipe_mint.v1",
      summary: "fixture",
      applied: [{ objectId: "rec_1" }, { objectId: "rec_2" }],
      reused: [{ objectId: "rec_3" }],
      rejected: [{ kind: "section_template", name: "hero_v2", reason: "unregistered_section_type" }]
    },
    theme_bind: {
      artifact: "clone_theme_bind.v1",
      summary: "fixture",
      applied: { colors: { bg: "#fff", text: "#000" }, fonts: { heading: "Georgia" } },
      dropped: [{ slot: "accent2", value: "#ff00ff", reason: "contrast_violation" }]
    },
    layout_restamp: {
      artifact: "clone_restamp.v1",
      summary: "fixture",
      restamped: [{ objectId: "page_1" }],
      skipped: [{ objectId: "page_2" }],
      quarantined: [{ objectId: "page_3", reason: "restamp_lock_conflict", detail: "lock held by another run" }]
    }
  },
  ...overrides
}) as unknown as WorkflowExecutionRecord;

describe("T15.15 — capture facts flow into learning_observations.v1", () => {
  it("is undefined for a run with no capture_score envelope (a publishing/clone run)", () => {
    expect(buildCaptureFacts({ stageOutputs: {} })).toBeUndefined();
    expect(buildCaptureFacts(cloneRun())).toBeUndefined();
  });

  it("reads fidelity, the gap ledger, crawl evidence and emission quarantines from capture_score/capture_crawl/capture_emit_live — never from gap_adjudicator or capture_report", () => {
    const facts = buildCaptureFacts(captureRun())!;
    expect(facts.fidelity).toEqual({ verdict: "needs_governed_iteration", coverageScorePct: 82, coverageMinimumPct: 90, mappedBlocks: 41, relevantBlocks: 50, tokensComplete: true, gapsEnumerated: true });
    expect(facts.gapLedger).toEqual({ totalGaps: 2, byCapability: [{ missingCapability: "pricing_table", count: 2 }] });
    expect(facts.crawlEvidence?.pagesCaptured).toBe(3);
    expect(facts.crawlEvidence?.quarantinedPages).toEqual([{ id: "page_3", reason: "robots_disallowed" }]);
    expect(facts.emissionQuarantines).toEqual([{ id: "sec_4", reason: "postcreate_validation_failed", detail: "schema mismatch" }]);
    expect(facts.drafts).toEqual({ created: 2, reused: 1 });
  });

  it("names a withheld/quarantined capture object with its reason in the observations ledger", () => {
    const output = buildLearningObservations({ run: captureRun() });
    expect(output.observations).toContain("Capture emission quarantined sec_4: postcreate_validation_failed (schema mismatch).");
    expect(output.observations).toContain("Capture crawl quarantined page page_3: robots_disallowed.");
    expect(output.captureFacts).toBeDefined();
    expect(output.cloneFacts).toBeUndefined();
  });
});

describe("T15.15 — clone facts flow into learning_observations.v1", () => {
  it("is undefined for a run with no recipe_mint envelope (a publishing/capture run)", () => {
    expect(buildCloneFacts({ stageOutputs: {} })).toBeUndefined();
    expect(buildCloneFacts(captureRun())).toBeUndefined();
  });

  it("reads the mint/theme/restamp ledgers and the capability backlog from recipe_mint/theme_bind/layout_restamp/recipe_designer — never from clone_report", () => {
    const facts = buildCloneFacts(cloneRun())!;
    expect(facts.recipeMint).toEqual({ applied: 2, reused: 1, rejected: [{ id: "hero_v2", reason: "unregistered_section_type" }] });
    expect(facts.themeBind).toEqual({ colorsApplied: 2, fontsApplied: 1, dropped: [{ id: "accent2", reason: "contrast_violation" }] }); // "slot" is theme_bind's own identifier key (engine/clone.mjs)
    expect(facts.restamp).toEqual({ restamped: 1, skipped: 1, quarantined: [{ id: "page_3", reason: "restamp_lock_conflict", detail: "lock held by another run" }] });
    expect(facts.capabilityBacklog).toEqual([{ sectionType: "pricing_table", count: 2 }, { sectionType: "video_embed", count: 1 }]);
  });

  it("names T15.12/#191's restamp_lock_conflict quarantine with its reason in the observations ledger, and surfaces the capability backlog", () => {
    const output = buildLearningObservations({ run: cloneRun() });
    expect(output.observations).toContain("Clone restamp quarantined page page_3: restamp_lock_conflict (lock held by another run).");
    expect(output.observations.some((line) => line.includes("pricing_table (2)") && line.includes("video_embed (1)"))).toBe(true);
    expect(output.cloneFacts).toBeDefined();
    expect(output.captureFacts).toBeUndefined();
  });
});

describe("T15.15 — determinism: no wall-clock value, random id, or completion-order dependence", () => {
  it("is byte-identical across two builds of the identical capture run", () => {
    const a = buildLearningObservations({ run: captureRun() });
    const b = buildLearningObservations({ run: captureRun() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is byte-identical across two builds of the identical clone run", () => {
    const a = buildLearningObservations({ run: cloneRun() });
    const b = buildLearningObservations({ run: cloneRun() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reads gap_adjudicator, capture_report or clone_report even when present on the run — only ancestors of learning_recorder", () => {
    const withSiblings = captureRun({
      stageOutputs: {
        ...captureRun().stageOutputs,
        gap_adjudicator: { artifact: "gap_adjudication.v1", summary: "fixture", adjudications: [{ gapId: "gap_1", disposition: "capability_backlog" }], humanSummary: "should never be read here" },
        capture_report: { artifact: "capture_run_report.v1", summary: "fixture", gapsByCapability: [{ missingCapability: "SHOULD_NOT_APPEAR", count: 999 }] }
      }
    });
    const withoutSiblings = captureRun();
    const withOutput = buildLearningObservations({ run: withSiblings });
    const withoutOutput = buildLearningObservations({ run: withoutSiblings });
    expect(JSON.stringify(withOutput)).toBe(JSON.stringify(withoutOutput));
    expect(JSON.stringify(withOutput)).not.toContain("SHOULD_NOT_APPEAR");
  });
});

describe("wired into a real run: replaces the model call entirely", () => {
  it("completes learning_recorder with zero model calls and zero usage records", async () => {
    repositoryManager.getUsageRepository().clear();
    const store = new RepositoryManager().getExecutionRepository();
    const workspace = new RepositoryManager().getWorkspaceRepository();
    await workspace.updateNode("learning_recorder", { metadata: { learningRecorderDeterministic: true } }, { actor: "w2b-test" });

    const started = await startDryRun({
      executionMode: "openai",
      projectId: "platform",
      input: "W2b e2e",
      budgetUsd: 100,
      entrypoint: {
        nodeId: "publish_payload",
        output: {
          artifact: "dry_run_publish_payload.v1",
          summary: "Candidate.",
          clientProjectId: "platform",
          clientObjectType: "content_item",
          contractSource: { tool: "object_contract", fingerprint: "fp_sample" },
          dryRun: true,
          clientObject: { slug: "s", title: "t", nodes: [] },
          blockers: []
        }
      }
    }, store, workspace);

    // Seed the three publish-tail nodes learning_recorder depends on, so it is the only node dispatched.
    // T15.6: release_executor joined the tail between publish_executor and learning_recorder; since
    // publish_executor never published, release_executor's honest outcome is "skipped".
    const run = (await getRun(started.runId, store))!;
    for (const [nodeId, output] of [
      ["publication_controller", { artifact: "publication_decision.v1", summary: "Ready.", decision: "go", blockers: [] }],
      ["publish_executor", { artifact: "publish_execution.v1", summary: "Refused.", status: "blocked", blockers: ["operator_approval_absent: ..."] }],
      ["release_executor", { artifact: "release_execution.v1", summary: "Nothing published.", status: "skipped", reason: "nothing_published", blockers: [], notes: [] }]
    ] as const) {
      const state = run.nodes.find((node) => node.nodeId === nodeId)!;
      state.status = "completed";
      state.output = output;
      run.stageOutputs[nodeId] = output;
    }
    await store.saveRun(run);

    const advanced = await runNextNode(started.runId, { executionRepository: store, workspaceRepository: workspace, approved: true });
    const state = advanced!.nodes.find((node) => node.nodeId === "learning_recorder")!;

    expect(state.status).toBe("completed");
    const output = state.output as { artifact: string; runId: string; gateEvents: Array<{ event: string }>; summary: string };
    expect(output.artifact).toBe("learning_observations.v1");
    expect(output.runId).toBe(started.runId);
    expect(output.gateEvents.map((event) => event.event)).toContain("publish_execution");
    expect(output.summary).toMatch(/No model call/);
    expect(await repositoryManager.getUsageRepository().list({ runId: started.runId, nodeId: "learning_recorder" })).toEqual([]);
  });
});
