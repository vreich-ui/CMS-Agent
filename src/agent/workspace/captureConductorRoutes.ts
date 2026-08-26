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
  captureMapStep,
  captureScoreStep,
  captureThemeStep,
  resolveCaptureAuthority,
  CaptureRefusal,
  CAPTURE_ARTIFACTS,
  type CaptureCrawlJobState,
  type CaptureEmissionEnvelope,
  type CaptureFidelityEnvelope,
  type CaptureMapEnvelope,
  type RegeneratedBody
} from "../capture/captureEngine.js";
// T15.7 (ADR-2026-08-25-publish-autonomy §6.2, §9) — capture_conductor's publish_payload,
// publication_controller and publish_executor stages, replacing the deleted capture_publish side path
// (T14.5's ./engine/publish.mjs). These are the SAME canonical tail node ids and shapes
// publishing_conductor uses (publishingTail.ts / nodes.ts) — captureConductorNodes.ts composes them
// onto capture's upstream via composeWorkflowNodes and retags their metadata (capture's OWN copy only)
// so they dispatch through THIS module's deterministic route instead of the DTC-specific one
// (publishPayload.ts / publishExecution.ts, which read article_body and are meaningless for a
// multi-object emission report). release_executor needs no capture-specific case at all: it is already
// object-agnostic (reads only publish_executor's own `publishCommitted` flag), so the exact same
// canonical release_executor dispatch (executor.ts, releaseExecution.ts) runs unchanged for capture.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { isProjectPublishEnabled, type CallToolFn } from "./publisher.js";
import { resolvePublishAuthority } from "./publishDecision.js";
import { buildObjectPublishPlan, executeObjectPublish, type ObjectPublishPlan, type ObjectPublishSourceReport } from "./objectPublishExecution.js";

export const CAPTURE_STAGES = ["crawl", "map", "map_refine", "theme", "emit_dry", "emit_live", "score", "publish_payload", "publication_controller", "publish_executor", "report"] as const;
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

// The object publish plan publish_payload wrapped into clientObject (dry_run_publish_payload.v1's
// required, minProperties>=1 `clientObject` field — the same node schema every workflow shares, so
// capture's multi-object plan travels inside it rather than needing a schema fork). Malformed or
// absent reads as "no plan": the caller refuses rather than guessing one.
const readObjectPublishPlan = (payload: Record<string, unknown>): ObjectPublishPlan | undefined => {
  const clientObject = isRecord(payload.clientObject) ? payload.clientObject : undefined;
  const plan = clientObject && isRecord(clientObject.objectPublishPlan) ? clientObject.objectPublishPlan : undefined;
  return plan && Array.isArray(plan.publish) && Array.isArray(plan.withheld) ? (plan as unknown as ObjectPublishPlan) : undefined;
};

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
      // T15.7 (ADR-2026-08-25-publish-autonomy §6.2, §9) — capture_conductor's segment of the SHARED
      // publishing tail. These three stages ARE publish_payload / publication_controller /
      // publish_executor — the identical tail node ids composeWorkflowNodes bound onto
      // capture_conductor's upstream (captureConductorNodes.ts), not a capture-local reimplementation.
      // The operator veto and the project's autonomy policy are no longer read here at all: for
      // publication_controller and publish_executor (both riskLevel "publish") the executor's OWN
      // publish-risk gate (executor.ts, resolvePublishAuthority) already refused the dispatch before
      // this code can run, so a withheld run or an operator-gated run with no decision never reaches
      // this switch for those two stages — exactly the machinery publishing_conductor's own
      // publication_controller/publish_executor already depend on, now shared rather than duplicated.
      case "publish_payload": {
        const emission = envelopeOf(run, "capture_emit_live", CAPTURE_ARTIFACTS.emissionRun);
        if (isOutcome(emission)) return emission;
        // capture_score is part of publish_payload's ADR §6.2 boundary binding. Its content is not
        // consumed here — the object publish plan is built from the emission report alone, exactly as
        // the deleted publish.mjs built it — but its PRESENCE enforces the ordering the binding
        // declares: scoring must finish before a publish plan is built, so the run's own fidelity
        // verdict is on the record first.
        const score = envelopeOf(run, "capture_score", CAPTURE_ARTIFACTS.fidelity);
        if (isOutcome(score)) return score;
        if (emission.live !== true) {
          return refused("capture_publish_emission_not_live", "The emission upstream of this stage was a dry run, so nothing was written; there is nothing to publish.");
        }
        const report = isRecord(emission.report) ? emission.report : undefined;
        if (!report) {
          return refused("capture_publish_emission_missing", "publish_payload needs the live emission's own report; a plan may never be built from anything else.");
        }
        const { projectId, config } = await resolveCaptureAuthority(targetProjectId);
        // ADR §2.4 rows 2/3 — the kill-switch, re-evaluated LIVE (never from a snapshot): the SAME
        // reader publisher.ts's own gate uses, so capture and publishing_conductor can never disagree
        // about what "publishing is off" means.
        if (!isProjectPublishEnabled(config)) {
          return refused(
            "capture_publish_disabled",
            `Project "${projectId}" is not publish-enabled (publishingPolicy.publishEnabled, or its per-project *_PUBLISH_ENABLED env override, is off); capture built no publish plan for it. Nothing was published and nothing was released.`
          );
        }
        let plan: ObjectPublishPlan;
        try {
          // T15.11 (#190, ADR §6.3) — the run's OWN snapshot, never a live charter re-resolve: see
          // publishableTypeCharter.ts / executionTypes.ts's publishableTypes header for why.
          plan = buildObjectPublishPlan({
            report: report as ObjectPublishSourceReport,
            target: projectId,
            publishableTypes: run.publishingPolicySnapshot?.publishableTypes,
            workflowId: run.workflowId
          });
        } catch (error) {
          return refused("capture_publish_plan_invalid", error instanceof Error ? error.message : String(error));
        }
        const output = {
          artifact: "dry_run_publish_payload.v1",
          summary: `Deterministic object publish plan for ${projectId}: ${plan.publish.length} object(s) publishable, ${plan.withheld.length} withheld.`,
          clientProjectId: projectId,
          clientObjectType: "capture_emission_batch",
          contractSource: { source: "capture_conductor", targetProjectId: projectId },
          dryRun: true,
          clientObject: { objectPublishPlan: plan },
          blockers: [],
          notes: [
            `Assembled deterministically (workspace/objectPublishExecution.ts) from capture_emit_live's own emission report — the object-scoped self-check T14.5's publish.mjs pioneered, carried into the canonical path by T15.6. Capture's chartered publishable types (T15.11/#190, ADR-2026-08-25-publish-autonomy §6.3, snapshotted onto this run at creation): ${[...(run.publishingPolicySnapshot?.publishableTypes ?? [])].sort().join(", ") || "(none — pre-T15.11 run, falling back to page/navigation)"}.`,
            plan.withheld.length ? `${plan.withheld.length} object(s) withheld — each is named with its reason in clientObject.objectPublishPlan.withheld.` : "Nothing was withheld: every written object's own validation passed and nothing quarantined it."
          ]
        };
        return { kind: "completed", output };
      }
      case "publication_controller": {
        const payload = envelopeOf(run, "publish_payload", "dry_run_publish_payload.v1");
        if (isOutcome(payload)) return payload;
        const plan = readObjectPublishPlan(payload);
        if (!plan) {
          return refused("capture_publish_plan_missing", "publish_payload produced no objectPublishPlan; publication_controller cannot decide without one.");
        }
        const output = {
          artifact: "publication_decision.v1",
          summary: `Capture publication decision for ${payload.clientProjectId}: ${plan.publish.length} object(s) cleared to publish, ${plan.withheld.length} withheld (named at publish_payload). Decision: go.`,
          decision: "go",
          state: "ready_for_publish_execution",
          blockers: [],
          notes: [
            "Deterministic (captureConductorRoutes.ts): the object-scoped self-check already ran at publish_payload (workspace/objectPublishExecution.ts). This decision is run-scoped only — is there a viable plan to execute — and is never a re-judgment of any one object's admission; that judgment belongs to publish_executor's own per-object gate.",
            plan.withheld.length ? `${plan.withheld.length} object(s) will be withheld at publish_executor for the reasons publish_payload already named.` : "No object is withheld."
          ]
        };
        return { kind: "completed", output };
      }
      case "publish_executor": {
        const payload = envelopeOf(run, "publish_payload", "dry_run_publish_payload.v1");
        if (isOutcome(payload)) return payload;
        const plan = readObjectPublishPlan(payload);
        if (!plan) {
          return refused("capture_publish_plan_missing", "publish_payload produced no objectPublishPlan; publish_executor cannot execute without one.");
        }
        const { config } = await resolveCaptureAuthority(targetProjectId);
        const callTool: CallToolFn = (tool, args) => new ProjectMcpAdapter(config).callTool(tool, args);
        const result = await executeObjectPublish({ plan, callTool });
        const authority = resolvePublishAuthority(run);
        const publishCommitted = result.published.length > 0;
        const status = publishCommitted ? "published_pending_release" : result.failed.length > 0 ? "blocked" : "skipped";
        const output = {
          artifact: "publish_execution.v1",
          summary: `Capture object publish for ${targetProjectId}: ${result.published.length} object(s) published, ${result.failed.length} failed, ${result.withheld.length} withheld. ${publishCommitted ? "release_executor performs the release next, downstream in the shared tail." : "Nothing published — release_executor will skip."}`,
          status,
          clientProjectId: targetProjectId,
          clientObjectType: "capture_emission_batch",
          contractSource: { source: "capture_conductor", targetProjectId },
          approvalMatched: authority.authorized,
          publishAuthority: {
            mode: run.publishingPolicySnapshot?.autonomyMode ?? "operator-gated",
            source: authority.authorized ? authority.source : null,
            operatorDecision: run.operatorPublishDecision ?? null
          },
          publishPolicyChecked: true,
          // Read by releaseExecution.ts UNCHANGED — release_executor needs no capture-specific code at
          // all, because this is the exact field the DTC path's own publish_executor stamps too.
          publishCommitted,
          // Custom field (schema additionalProperties:true): the multi-object ledger a single
          // clientObjectId cannot carry. capture_report reads this to build its publication block.
          objectPublish: { published: result.published, failed: result.failed, withheld: result.withheld, trace: result.trace },
          blockers: result.failed.map((entry) => `${entry.objectType}/${entry.objectId}: ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}`),
          notes: [
            "Executed deterministically (workspace/objectPublishExecution.ts) through checkout -> object_publish -> checkin per object: one object's failure never withholds the rest, and each lease is released in a `finally`. trigger_netlify_build, deploy and release_to_production are all unreachable from this node — release_executor, downstream in the shared tail, is the ONE node authorized to release (Board decision B2, amended by ADR-2026-08-25-publish-autonomy §4)."
          ]
        };
        return { kind: "completed", output };
      }
      case "report": {
        const fidelity = envelopeOf(run, "capture_score", CAPTURE_ARTIFACTS.fidelity);
        if (isOutcome(fidelity)) return fidelity;
        const emission = stageOutput(run, "capture_emit_live");
        const refined = stageOutput(run, "capture_map_refine");
        const adjudication = stageOutput(run, "gap_adjudicator");
        // T15.7: what actually went live, read from the shared tail's OWN records — absent on a run
        // whose publish_executor refused or was gated off, which the report renders as "nothing
        // published" rather than silence.
        const publishExecution = stageOutput(run, "publish_executor");
        const releaseExecution = stageOutput(run, "release_executor");
        const output = buildCaptureRunReport({
          targetProjectId,
          fidelity: fidelity as unknown as CaptureFidelityEnvelope,
          emission: emission?.artifact === CAPTURE_ARTIFACTS.emissionRun ? (emission as unknown as CaptureEmissionEnvelope) : undefined,
          mapEnvelope: refined?.artifact === CAPTURE_ARTIFACTS.mapRefined ? (refined as unknown as CaptureMapEnvelope) : undefined,
          adjudication,
          publishExecution: publishExecution?.artifact === "publish_execution.v1" ? publishExecution : undefined,
          releaseExecution: releaseExecution?.artifact === "release_execution.v1" ? releaseExecution : undefined
        });
        return { kind: "completed", output: output as unknown as Record<string, unknown> };
      }
    }
  } catch (error) {
    if (error instanceof CaptureRefusal) return refused(error.code, error.message);
    return refused("threw", error instanceof Error ? error.message : String(error));
  }
}
