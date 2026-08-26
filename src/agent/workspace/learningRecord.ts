// W2b (determinism program, 2026-08-12; docs/plan/WORK-ORDER-2026-08-12-determinism.md) — the
// deterministic learning_recorder.
//
// WHY THIS EXISTS. learning_recorder's job is to write down what the run DID: which nodes ran, which
// were blocked or failed, what the publish gate decided, what it cost. Every one of those is a
// structured fact already sitting on the run record and the usage ledger — the node was paying a model
// to read them back and paraphrase them, which is both a cost line and an accuracy risk (a paraphrase
// can be wrong about a fact the record states exactly).
//
// FULLY TEMPLATED. No model call, and no nano-model free-text field either (the work order lists that
// as optional; a templated observation set that is exactly true beats a fluent one that might not be).
// Every string this module emits is derived from a value on the run record or the usage summary.
//
// The gate events are the point of the record: the publication decision (with its blockers and any
// blockers WAIVED under the standing own-property rule — W6.1's audit trail lands here too), the
// operator's durable publish decision, the publish executor's status, approval holds, and budget
// halts. Those are the facts an operator or a later analysis actually goes looking for.
//
// SAFETY. Same contract as every other deterministic path: the caller validates the built record
// against the node's OWN outputSchema and falls through to the model dispatch on any failure.
//
// T15.15 (#194, learning parity) — learning_recorder is SHARED by every workflow that composes the
// publishing tail (publishingTail.ts): publishing_conductor, capture_conductor (#187) and
// clone_conductor (#189) all dispatch the identical canonical node through this identical module.
// Before this task the record templated only facts every workflow has (node statuses, gate events,
// cost); a capture or clone run's OWN facts — fidelity score, gap ledger, quarantines, the recipe
// mint/theme/restamp ledgers — never reached learning_observations.v1, so the playbook had nothing to
// learn cloning or capturing FROM even though both workflows already dispatch this node. No new
// artifact, no forked recorder: buildCaptureFacts/buildCloneFacts below extend the SAME templated
// envelope, exactly the "engine writes down what the run did" contract the header above already
// states, generalized from "every workflow's facts" to "this workflow's facts, when they exist".
//
// COMPLETION-ORDER SAFETY. learning_recorder's own dependsOn (publication_controller, publish_executor,
// release_executor) is the ONLY thing this module may assume already ran — a sibling node that merely
// happens to usually finish first (capture_report, clone_report, gap_adjudicator: none of them are
// upstream of learning_recorder, all three are upstream of nothing it depends on) is reachable by a
// caller that dispatches learning_recorder directly (workflow.run_node) the moment ITS OWN deps are
// satisfied, without ever having run that sibling — so reading it here would make the record's shape
// depend on DISPATCH ORDER, not on the run's input, which is exactly the nondeterminism class #200
// polices. Every field below is instead read from a node that is a TRANSITIVE ancestor of
// publish_payload's own boundary binding (captureConductorNodes.ts binds it to
// [capture_emit_live, capture_score]; cloneConductorNodes.ts binds it to
// [recipe_mint, theme_bind, layout_restamp]) — which publication_controller, then publish_executor,
// then release_executor, then learning_recorder itself all transitively depend on. That closure is
// walkable in captureConductorNodes.ts/cloneConductorNodes.ts's own dependsOn arrays; nothing here
// takes it on faith. gap_adjudicator and the two terminal *_report nodes are siblings, not ancestors,
// and are deliberately NOT read here for exactly this reason — capture_score's OWN envelope already
// carries the gap ledger gap_adjudicator merely adjudicates (report.gapReport), and recipe_designer's
// OWN envelope already carries the unmet-needs list clone_report merely groups, so the facts this task
// asks for are available from an ancestor either way.

import type { ModelUsageSummary } from "../observability/modelUsageTypes.js";
import type { ExecutionStatus, WorkflowExecutionRecord } from "./executionTypes.js";

export const LEARNING_OBSERVATIONS_ARTIFACT = "learning_observations.v1";

export type NodeRunFact = {
  nodeId: string;
  status: ExecutionStatus;
  durationMs?: number;
  costUsdEstimate?: number;
  warnings?: string[];
  errors?: string[];
  // True when the node completed with no usage record at all — i.e. it ran on a deterministic engine
  // path (contract_intelligence, placement_resolver, publish_payload, publication_controller,
  // publish_executor's refusal, this node) and cost $0. The determinism program's own scoreboard.
  deterministic?: boolean;
};

export type GateEventFact = { event: string; detail: string };

// A single named ledger entry — a quarantine, a rejection, a dropped token. "Named, never silent":
// every entry the capture/clone engines write to these ledgers already carries a `reason` (verified
// against captureEngine.ts/cloneEngine.ts's own vendored engines below), so this is a read, not an
// inference. `id` is a best-effort identifier picked from whichever key the entry actually carries —
// the ledgers are not schema-uniform across capture and clone — and "(unnamed)" is itself an honest,
// visible fact about an entry the engine wrote with no identifier, never a fabricated one.
export type LedgerEntryFact = { id: string; reason: string; detail?: string };

export type CaptureLearningFacts = {
  fidelity: { verdict: string; coverageScorePct: number; coverageMinimumPct: number; mappedBlocks: number; relevantBlocks: number; tokensComplete: boolean; gapsEnumerated: boolean } | null;
  // capture_score's OWN gap ledger (report.gapReport) — the same facts gap_adjudicator judges, read
  // here from their deterministic source rather than from the judgment node (see the module header's
  // completion-order note for why gap_adjudicator itself is never read).
  gapLedger: { totalGaps: number; byCapability: Array<{ missingCapability: string; count: number }> } | null;
  crawlEvidence: { sourceUrl: string | null; jobId: string | null; pagesCaptured: number; quarantinedPages: LedgerEntryFact[] } | null;
  emissionQuarantines: LedgerEntryFact[];
  drafts: { created: number; reused: number };
};

export type CloneLearningFacts = {
  recipeMint: { applied: number; reused: number; rejected: LedgerEntryFact[] } | null;
  themeBind: { colorsApplied: number; fontsApplied: number; dropped: LedgerEntryFact[] } | null;
  // T15.12/#191's restamp_lock_conflict reason lands in here verbatim, named like every other
  // quarantine reason — it is not a distinct field, because the ledger reader does not special-case
  // reason strings; it reports whatever reason the engine wrote.
  restamp: { restamped: number; skipped: number; quarantined: LedgerEntryFact[] } | null;
  // recipe_designer's OWN unmetNeeds, grouped by missing section TYPE — structure-studio ADR §6.3's
  // input to the platform capability loop, computed the identical way clone_report's own
  // groupUnmetNeedsBySectionType does (engine/clone.mjs), from an ancestor node instead of the
  // terminal report so this reads the same regardless of dispatch order.
  capabilityBacklog: Array<{ sectionType: string; count: number }>;
};

export type LearningObservationsOutput = {
  artifact: typeof LEARNING_OBSERVATIONS_ARTIFACT;
  summary: string;
  runId: string;
  runStatus: ExecutionStatus;
  observations: string[];
  nodeFacts: NodeRunFact[];
  gateEvents: GateEventFact[];
  cost: { actualUsd: number | null; estimatedUsd: number | null; totalUsd: number | null; recordCount: number | null; source: string };
  blockers: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  notes: string[];
  // Present only when the run's own stageOutputs carry that workflow's ancestor artifacts — absent
  // (not null, not a placeholder) on a publishing_conductor run, which produces neither.
  captureFacts?: CaptureLearningFacts;
  cloneFacts?: CloneLearningFacts;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter(nonEmptyString).map((entry) => entry.trim()) : []);

const round2 = (value: number): number => Math.round(value * 100) / 100;

// Per-node facts in the run record's own node order (which is the conductor's canonical order), with
// the usage ledger's per-node cost joined on. A node with no usage record and a completed status is
// reported as deterministic — that is a FACT of the ledger, not an inference about how it ran.
export function buildNodeFacts(run: Pick<WorkflowExecutionRecord, "nodes">, usage?: ModelUsageSummary): NodeRunFact[] {
  return run.nodes
    .filter((node) => node.status !== "queued")
    .map((node) => {
      const bucket = usage?.byNode?.[node.nodeId];
      return {
        nodeId: node.nodeId,
        status: node.status,
        ...(node.durationMs === undefined ? {} : { durationMs: node.durationMs }),
        ...(bucket ? { costUsdEstimate: round2(bucket.costUsdEstimate) } : {}),
        ...(node.warnings?.length ? { warnings: [...node.warnings] } : {}),
        ...(node.errors?.length ? { errors: [...node.errors] } : {}),
        ...(usage && !bucket && node.status === "completed" ? { deterministic: true } : {})
      };
    });
}

// The gate events, in the order they matter to an operator reading the record cold.
export function buildGateEvents(run: Pick<WorkflowExecutionRecord, "stageOutputs" | "approvalsRequired" | "operatorPublishDecision" | "budgetBlock">): GateEventFact[] {
  const events: GateEventFact[] = [];

  const decision = run.stageOutputs?.publication_controller;
  if (isObject(decision)) {
    const value = nonEmptyString(decision.decision) ? decision.decision : "(no decision field)";
    const blockers = stringArray(decision.blockers);
    events.push({ event: "publication_decision", detail: `publication_controller decided ${JSON.stringify(value)} with ${blockers.length} blocker(s)${blockers.length ? `: ${blockers.join(" | ")}` : ""}.` });
    // W6.1 audit trail: a waiver that is not written down is not a waiver.
    const waived = Array.isArray(decision.waivedBlockers) ? decision.waivedBlockers : [];
    if (waived.length) {
      const described = waived.map((entry) => (isObject(entry) ? `${String(entry.nodeId ?? "unknown")}: ${String(entry.blocker ?? "")} [rule ${String(entry.rule ?? "unnamed")}]` : String(entry)));
      events.push({ event: "blockers_waived", detail: `${waived.length} blocker(s) waived by standing rule and recorded on the decision: ${described.join(" | ")}.` });
    }
    // W7 (2026-08-25) audit trail, same principle one class over: an editorial blocker that did NOT
    // stop the publish is exactly the thing an operator reading the record cold needs to see, because
    // it is the one class of objection the decision deliberately declined to enforce. Silently absent
    // from the run record, "advisory" would be indistinguishable from "dropped".
    const advisories = Array.isArray(decision.advisories) ? decision.advisories : [];
    if (advisories.length) {
      const described = advisories.map((entry) => (isObject(entry) ? `${String(entry.nodeId ?? "unknown")}: ${String(entry.blocker ?? "")}` : String(entry)));
      events.push({ event: "blockers_advisory", detail: `${advisories.length} editorial blocker(s) recorded as advisory and deliberately not gating (blockerClassification.ts): ${described.join(" | ")}.` });
    }
    if (nonEmptyString(decision.contentClass)) events.push({ event: "content_class", detail: `Run content class: ${decision.contentClass}.` });
  } else {
    events.push({ event: "publication_decision", detail: "no publication_controller decision record exists on this run (the run did not reach the controller, or it produced no stage output)." });
  }

  events.push({
    event: "operator_publish_decision",
    detail: run.operatorPublishDecision
      ? `run.operatorPublishDecision is ${JSON.stringify(run.operatorPublishDecision)} (set via workflow.set_operator_publish_decision).`
      : "run.operatorPublishDecision is absent; absence never authorizes a publish."
  });

  const execution = run.stageOutputs?.publish_executor;
  if (isObject(execution)) {
    const blockers = stringArray(execution.blockers);
    events.push({ event: "publish_execution", detail: `publish_executor reported status ${JSON.stringify(execution.status ?? null)}, approvalMatched ${JSON.stringify(execution.approvalMatched ?? null)}${blockers.length ? `, blockers: ${blockers.join(" | ")}` : ""}.` });
  } else {
    events.push({ event: "publish_execution", detail: "publish_executor produced no stage output on this run (refused upstream, never reached, or publishing happened outside node execution)." });
  }

  // T15.6 (ADR-2026-08-25-publish-autonomy §4.3) — release_executor's own outcome, the same way
  // publish_executor's is recorded just above: skipped/executed/blocked, with its blockers named.
  const release = run.stageOutputs?.release_executor;
  if (isObject(release)) {
    const blockers = stringArray(release.blockers);
    events.push({ event: "release_execution", detail: `release_executor reported status ${JSON.stringify(release.status ?? null)}${blockers.length ? `, blockers: ${blockers.join(" | ")}` : ""}.` });
  } else {
    events.push({ event: "release_execution", detail: "release_executor produced no stage output on this run (not reached, or nothing was published to release)." });
  }

  for (const approval of run.approvalsRequired ?? []) {
    events.push({ event: approval.pending ? "approval_pending" : "approval_required", detail: `${approval.nodeId}: ${approval.reason}` });
  }
  if (run.budgetBlock) {
    events.push({ event: "budget_halt", detail: `${run.budgetBlock.reason} (ceiling $${run.budgetBlock.budgetUsd}, spent $${run.budgetBlock.spentUsdEstimate}${run.budgetBlock.nextNodeId ? `, next node ${run.budgetBlock.nextNodeId}` : ""}).` });
  }
  return events;
}

// Every blocker the run's own stage outputs carry, named with the node that raised it. Deliberately
// NOT de-duplicated against the publication decision's own list: this node records what each node
// said, and the decision record separately records what the controller did about it.
export function collectRunBlockers(run: Pick<WorkflowExecutionRecord, "nodes" | "stageOutputs">): string[] {
  const blockers: string[] = [];
  const seen = new Set<string>();
  for (const node of run.nodes) {
    const output = run.stageOutputs?.[node.nodeId] ?? node.output;
    if (!isObject(output)) continue;
    for (const blocker of stringArray(output.blockers)) {
      const key = `${node.nodeId}:${blocker.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blockers.push(`${node.nodeId}: ${blocker}`);
    }
  }
  return blockers;
}

// Best-effort identifier for a ledger entry, tried in the order the engines actually use across their
// various push sites (objectId — recipe_mint/layout_restamp/capture_emit_live's post-create
// quarantines; requestedId — capture_emit_live's pre-create quarantines; asset — capture_emit_live's
// asset-bind quarantines; blockRef — capture_map_refine's rejected classifier suggestions; slot —
// theme_bind's dropped tokens (engine/clone.mjs), which are named by their token slot, not an object
// id; name/kind — recipe_mint's rejected designs, which are named before they have an objectId).
const LEDGER_ID_KEYS = ["objectId", "requestedId", "asset", "blockRef", "slot", "name", "kind"] as const;

const ledgerEntry = (entry: Record<string, unknown>): LedgerEntryFact => {
  let id = "(unnamed)";
  for (const key of LEDGER_ID_KEYS) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) { id = value.trim(); break; }
  }
  const reason = nonEmptyString(entry.reason) ? entry.reason.trim() : "no_reason_recorded";
  const detail = nonEmptyString(entry.detail) ? entry.detail.trim() : undefined;
  return { id, reason, ...(detail ? { detail } : {}) };
};

const ledgerEntries = (value: unknown): LedgerEntryFact[] => (Array.isArray(value) ? value.filter(isObject).map(ledgerEntry) : []);

// capture_score's own gap ledger — the facts gap_adjudicator judges but does not originate. Read
// straight off capture_fidelity.v1 (score.mjs's FidelityReport), a guaranteed ancestor of
// learning_recorder (see the module header), so this is available whether or not gap_adjudicator (a
// sibling, not an ancestor) has run yet.
export function buildCaptureFacts(run: Pick<WorkflowExecutionRecord, "stageOutputs">): CaptureLearningFacts | undefined {
  const stageOutputs = run.stageOutputs ?? {};
  const score = stageOutputs.capture_score;
  if (!isObject(score) || score.artifact !== "capture_fidelity.v1") return undefined;

  const rubric = isObject(score.rubric) ? score.rubric : undefined;
  const coverage = rubric && isObject(rubric.coverage) ? rubric.coverage : undefined;
  const report = isObject(score.report) ? score.report : undefined;
  const gapReport = report && isObject(report.gapReport) ? report.gapReport : undefined;

  const crawl = stageOutputs.capture_crawl;
  const crawlOk = isObject(crawl) && crawl.artifact === "capture_snapshot.v1";
  const snapshot = crawlOk && isObject((crawl as Record<string, unknown>).snapshot) ? (crawl as Record<string, unknown>).snapshot as Record<string, unknown> : undefined;
  const diagnostics = snapshot && isObject(snapshot.diagnostics) ? snapshot.diagnostics : undefined;

  const emitLive = stageOutputs.capture_emit_live;
  const emitOk = isObject(emitLive) && emitLive.artifact === "capture_emission_run.v1";
  const emitReport = emitOk && isObject((emitLive as Record<string, unknown>).report) ? (emitLive as Record<string, unknown>).report as Record<string, unknown> : undefined;

  return {
    fidelity: rubric
      ? {
          verdict: nonEmptyString(rubric.verdict) ? rubric.verdict : "unknown",
          coverageScorePct: typeof coverage?.score === "number" ? round2(coverage.score * 100) : 0,
          coverageMinimumPct: typeof coverage?.minimum === "number" ? round2(coverage.minimum * 100) : 0,
          mappedBlocks: typeof coverage?.mappedBlocks === "number" ? coverage.mappedBlocks : 0,
          relevantBlocks: typeof coverage?.relevantBlocks === "number" ? coverage.relevantBlocks : 0,
          tokensComplete: isObject(rubric.tokensComplete) && rubric.tokensComplete.met === true,
          gapsEnumerated: isObject(rubric.gapsEnumerated) && rubric.gapsEnumerated.met === true
        }
      : null,
    gapLedger: gapReport
      ? {
          totalGaps: Array.isArray(gapReport.entries) ? gapReport.entries.length : 0,
          byCapability: Array.isArray(gapReport.byCapability)
            ? gapReport.byCapability.filter(isObject).map((entry) => ({
                missingCapability: nonEmptyString(entry.missingCapability) ? entry.missingCapability : "unknown",
                count: typeof entry.count === "number" ? entry.count : 0
              }))
            : []
        }
      : null,
    crawlEvidence: crawlOk
      ? {
          sourceUrl: nonEmptyString((crawl as Record<string, unknown>).sourceUrl) ? (crawl as Record<string, unknown>).sourceUrl as string : null,
          jobId: nonEmptyString((crawl as Record<string, unknown>).jobId) ? (crawl as Record<string, unknown>).jobId as string : null,
          pagesCaptured: snapshot && Array.isArray(snapshot.pages) ? snapshot.pages.length : 0,
          quarantinedPages: ledgerEntries(diagnostics?.quarantined)
        }
      : null,
    emissionQuarantines: emitOk ? ledgerEntries(emitReport?.quarantines) : [],
    drafts: {
      created: emitOk && Array.isArray(emitReport?.createdObjects) ? (emitReport!.createdObjects as unknown[]).length : 0,
      reused: emitOk && Array.isArray(emitReport?.reusedObjects) ? (emitReport!.reusedObjects as unknown[]).length : 0
    }
  };
}

// recipe_mint / theme_bind / layout_restamp — the three ancestors publish_payload binds to for
// clone_conductor (cloneConductorNodes.ts: composeWorkflowNodes(upstream, { publish_payload:
// ["recipe_mint", "theme_bind", "layout_restamp"] })) — plus recipe_designer, an ancestor of
// recipe_mint, for the capability backlog. clone_report groups the identical unmetNeeds list
// (engine/clone.mjs's groupUnmetNeedsBySectionType) purely for display; the grouping performed here is
// the same one-line transform, not a re-derivation of any judgment.
export function buildCloneFacts(run: Pick<WorkflowExecutionRecord, "stageOutputs">): CloneLearningFacts | undefined {
  const stageOutputs = run.stageOutputs ?? {};
  const mint = stageOutputs.recipe_mint;
  if (!isObject(mint) || mint.artifact !== "clone_recipe_mint.v1") return undefined;

  const themeBind = stageOutputs.theme_bind;
  const themeOk = isObject(themeBind) && themeBind.artifact === "clone_theme_bind.v1";
  const themeApplied = themeOk && isObject((themeBind as Record<string, unknown>).applied) ? (themeBind as Record<string, unknown>).applied as Record<string, unknown> : undefined;

  const restamp = stageOutputs.layout_restamp;
  const restampOk = isObject(restamp) && restamp.artifact === "clone_restamp.v1";

  const design = stageOutputs.recipe_designer;
  const designOk = isObject(design) && design.artifact === "clone_recipe_design.v1";
  const backlog = new Map<string, number>();
  if (designOk && Array.isArray((design as Record<string, unknown>).unmetNeeds)) {
    for (const need of (design as Record<string, unknown>).unmetNeeds as unknown[]) {
      const sectionType = isObject(need) && nonEmptyString(need.sectionType) ? need.sectionType : "unknown";
      backlog.set(sectionType, (backlog.get(sectionType) ?? 0) + 1);
    }
  }

  return {
    recipeMint: {
      applied: Array.isArray(mint.applied) ? mint.applied.length : 0,
      reused: Array.isArray(mint.reused) ? mint.reused.length : 0,
      rejected: ledgerEntries(mint.rejected)
    },
    themeBind: themeOk
      ? {
          colorsApplied: themeApplied && isObject(themeApplied.colors) ? Object.keys(themeApplied.colors).length : 0,
          fontsApplied: themeApplied && isObject(themeApplied.fonts) ? Object.keys(themeApplied.fonts).length : 0,
          dropped: ledgerEntries((themeBind as Record<string, unknown>).dropped)
        }
      : null,
    restamp: restampOk
      ? {
          restamped: Array.isArray((restamp as Record<string, unknown>).restamped) ? ((restamp as Record<string, unknown>).restamped as unknown[]).length : 0,
          skipped: Array.isArray((restamp as Record<string, unknown>).skipped) ? ((restamp as Record<string, unknown>).skipped as unknown[]).length : 0,
          quarantined: ledgerEntries((restamp as Record<string, unknown>).quarantined)
        }
      : null,
    capabilityBacklog: [...backlog.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([sectionType, count]) => ({ sectionType, count }))
  };
}

// One templated line per named ledger entry — the same "Node X FAILED: ..." / "Node X was BLOCKED"
// density buildLearningObservations already uses for node facts, applied to a quarantine/rejection
// ledger: a withheld or quarantined object is recorded with its OWN reason, never folded into a count.
const describeLedgerEntries = (label: string, entries: LedgerEntryFact[]): string[] =>
  entries.map((entry) => `${label} ${entry.id}: ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}.`);

function describeCaptureFacts(facts: CaptureLearningFacts | undefined): string[] {
  if (!facts) return [];
  const lines: string[] = [];
  if (facts.fidelity) {
    lines.push(
      `Capture fidelity verdict "${facts.fidelity.verdict}": coverage ${facts.fidelity.coverageScorePct}% (${facts.fidelity.mappedBlocks}/${facts.fidelity.relevantBlocks} block(s)) against a ${facts.fidelity.coverageMinimumPct}% minimum; tokens ${facts.fidelity.tokensComplete ? "complete" : "incomplete"}, gaps ${facts.fidelity.gapsEnumerated ? "enumerated" : "NOT enumerated"}.`
    );
  }
  if (facts.gapLedger) {
    lines.push(`Capture gap ledger: ${facts.gapLedger.totalGaps} residual gap(s) across ${facts.gapLedger.byCapability.length} missing capabilit(ies)${facts.gapLedger.byCapability.length ? `: ${facts.gapLedger.byCapability.map((entry) => `${entry.missingCapability} (${entry.count})`).join(", ")}` : ""}.`);
  }
  if (facts.crawlEvidence) {
    lines.push(`Capture crawl evidence: ${facts.crawlEvidence.pagesCaptured} page(s) captured from ${facts.crawlEvidence.sourceUrl ?? "(no sourceUrl recorded)"} (job ${facts.crawlEvidence.jobId ?? "unknown"}).`);
    lines.push(...describeLedgerEntries("Capture crawl quarantined page", facts.crawlEvidence.quarantinedPages));
  }
  lines.push(`Capture emission drafts: ${facts.drafts.created} created, ${facts.drafts.reused} reused, ${facts.emissionQuarantines.length} quarantined.`);
  lines.push(...describeLedgerEntries("Capture emission quarantined", facts.emissionQuarantines));
  return lines;
}

function describeCloneFacts(facts: CloneLearningFacts | undefined): string[] {
  if (!facts) return [];
  const lines: string[] = [];
  if (facts.recipeMint) {
    lines.push(`Clone recipe mint: ${facts.recipeMint.applied} minted, ${facts.recipeMint.reused} reused, ${facts.recipeMint.rejected.length} rejected.`);
    lines.push(...describeLedgerEntries("Clone recipe rejected", facts.recipeMint.rejected));
  }
  if (facts.themeBind) {
    lines.push(`Clone theme bind: ${facts.themeBind.colorsApplied} color token(s) + ${facts.themeBind.fontsApplied} font token(s) applied, ${facts.themeBind.dropped.length} dropped.`);
    lines.push(...describeLedgerEntries("Clone theme token dropped", facts.themeBind.dropped));
  }
  if (facts.restamp) {
    lines.push(`Clone layout restamp: ${facts.restamp.restamped} page(s) restamped, ${facts.restamp.skipped} skipped, ${facts.restamp.quarantined.length} quarantined.`);
    lines.push(...describeLedgerEntries("Clone restamp quarantined page", facts.restamp.quarantined));
  }
  if (facts.capabilityBacklog.length) {
    lines.push(`Clone capability backlog (structure-studio ADR §6.3): ${facts.capabilityBacklog.map((entry) => `${entry.sectionType} (${entry.count})`).join(", ")}.`);
  }
  return lines;
}

export type LearningRecordSources = {
  run: Pick<WorkflowExecutionRecord, "runId" | "status" | "nodes" | "stageOutputs" | "approvalsRequired" | "operatorPublishDecision" | "budgetBlock" | "errors">;
  // Omitted when the usage ledger could not be read; cost fields then report null (never zero — an
  // unread ledger is "unknown", and conflating it with "$0" is exactly the fabrication class this
  // program exists to remove).
  usage?: ModelUsageSummary;
  usageError?: string;
};

export function buildLearningObservations(sources: LearningRecordSources): LearningObservationsOutput {
  const { run, usage } = sources;
  const nodeFacts = buildNodeFacts(run, usage);
  const gateEvents = buildGateEvents(run);
  const blockers = collectRunBlockers(run);
  const captureFacts = buildCaptureFacts(run);
  const cloneFacts = buildCloneFacts(run);

  const completed = nodeFacts.filter((fact) => fact.status === "completed");
  const failed = nodeFacts.filter((fact) => fact.status === "failed");
  const blocked = nodeFacts.filter((fact) => fact.status === "blocked");
  const deterministic = nodeFacts.filter((fact) => fact.deterministic);
  const warned = nodeFacts.filter((fact) => (fact.warnings?.length ?? 0) > 0);

  const cost = usage
    ? { actualUsd: round2(usage.actualCostUsdEstimate), estimatedUsd: round2(usage.estimatedCostUsdEstimate), totalUsd: round2(usage.totalCostUsdEstimate), recordCount: usage.recordCount, source: "usage ledger (summarizeModelUsage over this runId) — measured, never estimated by a model" }
    : { actualUsd: null, estimatedUsd: null, totalUsd: null, recordCount: null, source: `usage ledger unavailable (${sources.usageError ?? "no reason reported"}); cost is reported as unknown rather than as zero` };

  const observations = [
    `Run ${run.runId} ended with status ${run.status}: ${completed.length} node(s) completed, ${blocked.length} blocked, ${failed.length} failed, of ${nodeFacts.length} that were dispatched or seeded.`,
    ...(usage
      ? [`Measured model spend for this run: $${cost.actualUsd} actual + $${cost.estimatedUsd} estimated across ${usage.recordCount} usage record(s). ${deterministic.length} completed node(s) produced NO usage record at all — they ran on deterministic engine paths at $0.`]
      : [`Model spend could not be read from the usage ledger (${sources.usageError ?? "no reason reported"}); no cost figure is asserted here.`]),
    ...failed.map((fact) => `Node ${fact.nodeId} FAILED: ${(fact.errors ?? ["no error recorded"]).join("; ")}.`),
    ...blocked.map((fact) => `Node ${fact.nodeId} was BLOCKED — an expected safety state when a gate refuses, not a defect by itself.`),
    ...warned.map((fact) => `Node ${fact.nodeId} carried warning(s): ${(fact.warnings ?? []).join("; ")}.`),
    ...(run.errors?.length ? [`Run-level errors recorded: ${run.errors.join("; ")}.`] : []),
    ...gateEvents.map((event) => `[${event.event}] ${event.detail}`),
    ...describeCaptureFacts(captureFacts),
    ...describeCloneFacts(cloneFacts)
  ];

  const summary =
    `Deterministic run record for ${run.runId} (status ${run.status}): ${completed.length}/${nodeFacts.length} node(s) completed, ` +
    `${blocked.length} blocked, ${failed.length} failed, ${blockers.length} blocker(s) raised upstream, ${gateEvents.length} gate event(s), ` +
    `spend ${usage ? `$${cost.actualUsd} actual` : "unknown (ledger unavailable)"}. Templated from the run record and the usage ledger. No model call.`;

  return {
    artifact: LEARNING_OBSERVATIONS_ARTIFACT,
    summary,
    runId: run.runId,
    runStatus: run.status,
    observations,
    nodeFacts,
    gateEvents,
    cost,
    blockers,
    assumptions: [
      "Every statement here is a value read from the run record or the model-usage ledger; nothing is inferred, summarized by a model, or estimated.",
      "A completed node with no usage record is reported as having run deterministically — that is a property of the ledger, which deterministic engine paths deliberately never write to (the R-20 rule: a $0 event stays $0).",
      "Blocked nodes are recorded as safety states, not failures: the publish gates are designed to refuse."
    ],
    unresolvedQuestions: [
      ...(failed.length ? [`Why did ${failed.map((fact) => fact.nodeId).join(", ")} fail? The record carries the error codes; root cause is not inferable from the run record alone.`] : []),
      ...(blockers.length ? ["Which of the upstream blockers recorded here are systematic (a schema/contract gap) versus specific to this request? Not decidable from one run."] : []),
      ...(usage ? [] : ["What did this run cost? The usage ledger was unreadable at record time."])
    ],
    notes: [
      "Recorded deterministically by the conductor (learningRecord.ts): fully templated over structured run facts — stage outputs, node statuses, durations, warnings, gate events and the measured usage ledger. No model call, no free-text generation.",
      "Gate events are the audited part of this record: the publication decision and any blockers waived under a standing rule are written down verbatim here as well as on the decision itself, so the waiver survives even if the decision record is later re-read out of context.",
      ...(captureFacts || cloneFacts
        ? [
            "T15.15 (#194): captureFacts/cloneFacts are read from stage outputs that are TRANSITIVE ANCESTORS of learning_recorder's own dependsOn (publish_payload's boundary binding and everything upstream of it) — never from a sibling node (gap_adjudicator, capture_report, clone_report) that might not have run yet, so this record's shape cannot depend on which node a caller happened to dispatch first."
          ]
        : [])
    ],
    ...(captureFacts ? { captureFacts } : {}),
    ...(cloneFacts ? { cloneFacts } : {})
  };
}
