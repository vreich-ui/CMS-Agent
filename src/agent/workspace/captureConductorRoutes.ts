// T12.9 — the capture_conductor deterministic node routes: the engine code the executor runs for
// every node carrying `metadata.captureStageDeterministic` (the R-C3 v2 fast-path pattern — build
// in code, validate against the node's own outputSchema, complete with NO model call).
//
// This module COMPUTES; the executor OWNS the state transition (matching every sibling
// deterministic route). Three outcomes exist:
//   completed — the stage produced its envelope; the executor validates it against the node's own
//               outputSchema and completes the node with zero usage recorded (the R-20 $0 rule).
//   pending   — capture_crawl only: the pdf-tool job is not terminal. The executor RE-QUEUES the
//               node (never spins inside one 30s project-call window); the long-run planes — the
//               Cloud Run conductor job's advance loop and the run-continuation tick — re-drive it
//               until a poll is terminal. The job id survives between advances in the run's
//               stageOutputs under CAPTURE_CRAWL_JOB_STAGE_KEY.
//   refused   — a typed refusal. On a LIVE run the executor BLOCKS the node (a model must never
//               fabricate a crawl, mapping, theme, emission, or score — the placement_resolver
//               precedent); on a MOCK run it falls through to MockNodeRunner with a run-visible
//               warning so CI graph traversal keeps working.
import type { WorkspaceNode } from "./nodeTypes.js";
import type { WorkflowExecutionRecord } from "./executionTypes.js";
import {
  buildCaptureRunReport,
  captureCrawlStep,
  captureEmitStep,
  capturePublishStep,
  captureMapStep,
  captureScoreStep,
  captureThemeStep,
  CaptureRefusal,
  CAPTURE_ARTIFACTS,
  type CaptureCrawlJobState,
  type CaptureEmissionEnvelope,
  type CaptureFidelityEnvelope,
  type CaptureMapEnvelope,
  type RegeneratedBody
} from "../capture/captureEngine.js";

export const CAPTURE_STAGES = ["crawl", "map", "map_refine", "theme", "emit_dry", "emit_live", "score", "publish", "report"] as const;
export type CaptureStage = typeof CAPTURE_STAGES[number];

// The crawl job's cross-advance bookkeeping key. Deliberately ":"-suffixed so it can never collide
// with a node id in run.stageOutputs.
export const CAPTURE_CRAWL_JOB_STAGE_KEY = "capture_crawl:job";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export const readCaptureStage = (node: Pick<WorkspaceNode, "metadata">): CaptureStage | undefined => {
  const declared = node.metadata?.captureStageDeterministic;
  return typeof declared === "string" && (CAPTURE_STAGES as readonly string[]).includes(declared) ? (declared as CaptureStage) : undefined;
};

export type CaptureStageOutcome =
  | { kind: "completed"; output: Record<string, unknown> }
  | { kind: "pending"; jobStateKey: string; jobState: CaptureCrawlJobState; warning: string }
  | { kind: "refused"; code: string; message: string };

const refused = (code: string, message: string): CaptureStageOutcome => ({ kind: "refused", code, message });

type RunFacts = { targetProjectId: string; sourceUrl?: string };

// The run's client identity is the authority on the capture target: a run stamped with one
// projectId must never capture under another project's policy, so a differing initialInput
// targetProjectId is a refusal, not a preference.
const resolveRunFacts = (run: WorkflowExecutionRecord): RunFacts | CaptureStageOutcome => {
  const initial = isRecord(run.initialInput) ? run.initialInput : {};
  const declaredTarget = typeof initial.targetProjectId === "string" ? initial.targetProjectId.trim() : "";
  const runProject = typeof run.projectId === "string" ? run.projectId.trim() : "";
  if (!runProject) return refused("capture_target_missing", "The run carries no projectId; capture bounds are per-project.");
  if (declaredTarget && declaredTarget !== runProject) {
    return refused("capture_target_mismatch", `initialInput.targetProjectId ("${declaredTarget}") differs from the run's own projectId ("${runProject}"); the run's project is the policy authority and a capture may not be redirected to another project's bounds.`);
  }
  const sourceUrl = typeof initial.sourceUrl === "string" && initial.sourceUrl.trim() ? initial.sourceUrl.trim() : undefined;
  return { targetProjectId: runProject, ...(sourceUrl ? { sourceUrl } : {}) };
};

const stageOutput = (run: WorkflowExecutionRecord, nodeId: string): Record<string, unknown> | undefined => {
  const value = run.stageOutputs[nodeId];
  return isRecord(value) ? value : undefined;
};

const envelopeOf = (run: WorkflowExecutionRecord, nodeId: string, artifact: string): Record<string, unknown> | CaptureStageOutcome => {
  const value = stageOutput(run, nodeId);
  if (!value || value.artifact !== artifact) {
    return refused("capture_upstream_artifact_invalid", `Expected ${nodeId}'s stage output to be a ${artifact} envelope; found ${value ? `artifact "${String(value.artifact)}"` : "nothing"}. A placeholder or malformed upstream artifact is never built upon.`);
  }
  return value;
};

const isOutcome = (value: unknown): value is CaptureStageOutcome => isRecord(value) && typeof value.kind === "string" && ["completed", "pending", "refused"].includes(value.kind as string);

const readRegenerated = (value: Record<string, unknown> | undefined): RegeneratedBody[] => {
  if (!value || !Array.isArray(value.regenerated)) return [];
  return (value.regenerated as unknown[]).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const requestedId = typeof entry.requestedId === "string" ? entry.requestedId : "";
    const objectType = typeof entry.objectType === "string" ? entry.objectType : "";
    return requestedId && objectType && isRecord(entry.body) ? [{ requestedId, objectType, body: entry.body as Record<string, unknown> }] : [];
  });
};

const readCrawlJobState = (run: WorkflowExecutionRecord): CaptureCrawlJobState | undefined => {
  const value = stageOutput(run, CAPTURE_CRAWL_JOB_STAGE_KEY);
  if (!value || typeof value.jobId !== "string" || !value.jobId) return undefined;
  return {
    jobId: value.jobId,
    status: typeof value.status === "string" ? value.status : "pending",
    attempts: typeof value.attempts === "number" ? value.attempts : 0,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  };
};

export async function runCaptureStage(input: { run: WorkflowExecutionRecord; node: WorkspaceNode; stage: CaptureStage }): Promise<CaptureStageOutcome> {
  const { run, stage } = input;
  const facts = resolveRunFacts(run);
  if (isOutcome(facts)) return facts;
  const { targetProjectId, sourceUrl } = facts;
  try {
    switch (stage) {
      case "crawl": {
        if (!sourceUrl) return refused("capture_source_missing", "The run's initialInput carries no sourceUrl; capture_crawl cannot create a job for an unnamed source.");
        const step = await captureCrawlStep({ targetProjectId, sourceUrl, jobState: readCrawlJobState(run) });
        if (step.phase === "pending") {
          return { kind: "pending", jobStateKey: CAPTURE_CRAWL_JOB_STAGE_KEY, jobState: step.jobState, warning: `capture_crawl_pending:${step.jobState.jobId}` };
        }
        return { kind: "completed", output: step.envelope as unknown as Record<string, unknown> };
      }
      case "map": {
        const crawl = envelopeOf(run, "capture_crawl", CAPTURE_ARTIFACTS.snapshot);
        if (isOutcome(crawl)) return crawl;
        const envelope = await captureMapStep({ targetProjectId, snapshot: crawl.snapshot });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "map_refine": {
        const crawl = envelopeOf(run, "capture_crawl", CAPTURE_ARTIFACTS.snapshot);
        if (isOutcome(crawl)) return crawl;
        const baseline = envelopeOf(run, "capture_map", CAPTURE_ARTIFACTS.map);
        if (isOutcome(baseline)) return baseline;
        // block_classifier may have been skipped (no declined blocks) or produced no suggestions —
        // both legal. Suggestions are sanitized and re-validated inside captureMapStep; the mapper's
        // deterministic builder rejects anything invalid or unregistered, never coerces it.
        const classification = stageOutput(run, "block_classifier");
        const envelope = await captureMapStep({ targetProjectId, snapshot: crawl.snapshot, suggestions: classification?.suggestions });
        const output = envelope.artifact === CAPTURE_ARTIFACTS.mapRefined
          ? (envelope as unknown as Record<string, unknown>)
          : {
              // Zero usable suggestions: the refined artifact IS the baseline mapping, restated
              // under this node's own artifact const with an explicit zero delta.
              ...(envelope as unknown as Record<string, unknown>),
              artifact: CAPTURE_ARTIFACTS.mapRefined,
              summary: `${envelope.summary} No classifier suggestion was applicable, so the refined mapping equals the baseline (delta 0.00pp).`,
              assistance: { considered: 0, applied: [], rejected: [] },
              coverageDelta: { baseline: envelope.coverage, refined: envelope.coverage, delta: 0 }
            };
        return { kind: "completed", output };
      }
      case "theme": {
        const crawl = envelopeOf(run, "capture_crawl", CAPTURE_ARTIFACTS.snapshot);
        if (isOutcome(crawl)) return crawl;
        const envelope = await captureThemeStep({ targetProjectId, snapshot: crawl.snapshot });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "emit_dry": {
        const refined = envelopeOf(run, "capture_map_refine", CAPTURE_ARTIFACTS.mapRefined);
        if (isOutcome(refined)) return refined;
        const theme = envelopeOf(run, "capture_theme", CAPTURE_ARTIFACTS.theme);
        if (isOutcome(theme)) return theme;
        const envelope = await captureEmitStep({ targetProjectId, mapping: refined.mapping, theme: theme.theme, live: false });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "emit_live": {
        const refined = envelopeOf(run, "capture_map_refine", CAPTURE_ARTIFACTS.mapRefined);
        if (isOutcome(refined)) return refined;
        const theme = envelopeOf(run, "capture_theme", CAPTURE_ARTIFACTS.theme);
        if (isOutcome(theme)) return theme;
        const envelope = await captureEmitStep({
          targetProjectId,
          mapping: refined.mapping,
          theme: theme.theme,
          live: true,
          // copy_regenerator's output when it ran; [] when it was deterministically skipped because
          // rights permit extracted copy. When rights REQUIRE regeneration and an entry is missing,
          // that operation is quarantined — never emitted with extracted copy (captureEngine.ts).
          regenerated: readRegenerated(stageOutput(run, "copy_regenerator"))
        });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "score": {
        const crawl = envelopeOf(run, "capture_crawl", CAPTURE_ARTIFACTS.snapshot);
        if (isOutcome(crawl)) return crawl;
        const refined = envelopeOf(run, "capture_map_refine", CAPTURE_ARTIFACTS.mapRefined);
        if (isOutcome(refined)) return refined;
        const theme = envelopeOf(run, "capture_theme", CAPTURE_ARTIFACTS.theme);
        if (isOutcome(theme)) return theme;
        const envelope = await captureScoreStep({ targetProjectId, snapshot: crawl.snapshot, mapping: refined.mapping, theme: theme.theme });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      // T14.5 — the publish tail. Runs BEFORE the report so the report can say what went live, and
      // AFTER the score so the run's own fidelity verdict is on the record first. The operator's
      // explicit veto is the one thing that stops it: publishingPolicy.operatorDefault decides what a
      // run STARTS as, and workflow.set_operator_publish_decision("withheld") overrides that default
      // — so "the human is not involved" is the default posture, not an unconditional one.
      case "publish": {
        if (run.operatorPublishDecision === "withheld") {
          return refused(
            "capture_publish_withheld_by_operator",
            "An operator explicitly withheld publication for this run (workflow.set_operator_publish_decision). Nothing was published and nothing was released; the drafts are intact."
          );
        }
        const emission = stageOutput(run, "capture_emit_live");
        if (emission?.artifact !== CAPTURE_ARTIFACTS.emissionRun) {
          return refused(
            "capture_publish_emission_missing",
            "capture_emit_live produced no live emission envelope; a publish plan may never be built from anything else."
          );
        }
        const envelope = await capturePublishStep({ targetProjectId, emission });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "report": {
        const fidelity = envelopeOf(run, "capture_score", CAPTURE_ARTIFACTS.fidelity);
        if (isOutcome(fidelity)) return fidelity;
        const emission = stageOutput(run, "capture_emit_live");
        const refined = stageOutput(run, "capture_map_refine");
        const adjudication = stageOutput(run, "gap_adjudicator");
        // T14.5: what actually went live. Absent on a run whose publish stage refused or was
        // withheld, which the report renders as "nothing published" rather than silence.
        const publication = stageOutput(run, "capture_publish");
        const output = buildCaptureRunReport({
          targetProjectId,
          fidelity: fidelity as unknown as CaptureFidelityEnvelope,
          emission: emission?.artifact === CAPTURE_ARTIFACTS.emissionRun ? (emission as unknown as CaptureEmissionEnvelope) : undefined,
          mapEnvelope: refined?.artifact === CAPTURE_ARTIFACTS.mapRefined ? (refined as unknown as CaptureMapEnvelope) : undefined,
          adjudication,
          publication: publication?.artifact === CAPTURE_ARTIFACTS.publishRun ? publication : undefined
        });
        return { kind: "completed", output: output as unknown as Record<string, unknown> };
      }
    }
  } catch (error) {
    if (error instanceof CaptureRefusal) return refused(error.code, error.message);
    return refused("threw", error instanceof Error ? error.message : String(error));
  }
}
