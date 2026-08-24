// T13.1 — the clone_conductor deterministic node routes: the engine code the executor runs for every
// node carrying `metadata.cloneStageDeterministic` (the same R-C3 v2 fast-path pattern
// captureConductorRoutes.ts established: build in code, validate against the node's own outputSchema,
// complete with NO model call). Mirrors captureConductorRoutes.ts exactly in shape.
//
// This module COMPUTES; the executor OWNS the state transition. Unlike capture, there is no "pending"
// stage here — clone never polls an external job plane, so only two outcomes exist:
//   completed — the stage produced its envelope; the executor validates it against the node's own
//               outputSchema and completes the node with zero usage recorded (the R-20 $0 rule).
//   refused   — a typed refusal. On a LIVE run the executor BLOCKS the node (a model must never
//               fabricate a mint, a theme apply, or a restamp — the same "no model fallback"
//               precedent capture's crawl/map/theme/emit/score stages already rely on); on a MOCK run
//               it falls through to MockNodeRunner with a run-visible warning so CI graph traversal
//               keeps working.
import type { WorkspaceNode } from "./nodeTypes.js";
import type { WorkflowExecutionRecord } from "./executionTypes.js";
import {
  buildCloneReportStep,
  cloneIntakeStep,
  cloneMintStep,
  cloneRestampStep,
  cloneThemeBindStep,
  CloneRefusal,
  CLONE_ARTIFACTS,
  type CloneIntakeEnvelope,
  type CloneMintEnvelope,
  type CloneRestampEnvelope,
  type CloneThemeBindEnvelope
} from "../capture/cloneEngine.js";

export const CLONE_STAGES = ["intake", "mint", "theme_bind", "restamp", "report"] as const;
export type CloneStage = typeof CLONE_STAGES[number];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export const readCloneStage = (node: Pick<WorkspaceNode, "metadata">): CloneStage | undefined => {
  const declared = node.metadata?.cloneStageDeterministic;
  return typeof declared === "string" && (CLONE_STAGES as readonly string[]).includes(declared) ? (declared as CloneStage) : undefined;
};

export type CloneStageOutcome = { kind: "completed"; output: Record<string, unknown> } | { kind: "refused"; code: string; message: string };

const refused = (code: string, message: string): CloneStageOutcome => ({ kind: "refused", code, message });

type RunFacts = { targetProjectId: string; captureRunId: string };

// The run's client identity is the authority on the clone target: a run stamped with one projectId
// must never write drafts under another project's policy, so a differing initialInput
// targetProjectId is a refusal, not a preference — the identical law captureConductorRoutes enforces.
const resolveRunFacts = (run: WorkflowExecutionRecord): RunFacts | CloneStageOutcome => {
  const initial = isRecord(run.initialInput) ? run.initialInput : {};
  const declaredTarget = typeof initial.targetProjectId === "string" ? initial.targetProjectId.trim() : "";
  const runProject = typeof run.projectId === "string" ? run.projectId.trim() : "";
  if (!runProject) return refused("clone_target_missing", "The run carries no projectId; clone bounds are per-project.");
  if (declaredTarget && declaredTarget !== runProject) {
    return refused("clone_target_mismatch", `initialInput.targetProjectId ("${declaredTarget}") differs from the run's own projectId ("${runProject}"); the run's project is the policy authority and a clone may not be redirected to another project's bounds.`);
  }
  const captureRunId = typeof initial.captureRunId === "string" && initial.captureRunId.trim() ? initial.captureRunId.trim() : "";
  if (!captureRunId) return refused("clone_source_run_missing", "The run's initialInput carries no captureRunId; clone_intake needs a finished capture run to clone from.");
  return { targetProjectId: runProject, captureRunId };
};

const stageOutput = (run: WorkflowExecutionRecord, nodeId: string): Record<string, unknown> | undefined => {
  const value = run.stageOutputs[nodeId];
  return isRecord(value) ? value : undefined;
};

const envelopeOf = (run: WorkflowExecutionRecord, nodeId: string, artifact: string): Record<string, unknown> | CloneStageOutcome => {
  const value = stageOutput(run, nodeId);
  if (!value || value.artifact !== artifact) {
    return refused("clone_upstream_artifact_invalid", `Expected ${nodeId}'s stage output to be a ${artifact} envelope; found ${value ? `artifact "${String(value.artifact)}"` : "nothing"}. A placeholder or malformed upstream artifact is never built upon.`);
  }
  return value;
};

const isOutcome = (value: unknown): value is CloneStageOutcome => isRecord(value) && typeof value.kind === "string" && ["completed", "refused"].includes(value.kind as string);

export async function runCloneStage(input: { run: WorkflowExecutionRecord; node: WorkspaceNode; stage: CloneStage }): Promise<CloneStageOutcome> {
  const { run, stage } = input;
  const facts = resolveRunFacts(run);
  if (isOutcome(facts)) return facts;
  const { targetProjectId, captureRunId } = facts;
  try {
    switch (stage) {
      case "intake": {
        const envelope = await cloneIntakeStep({ targetProjectId, captureRunId });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "mint": {
        const intake = envelopeOf(run, "clone_intake", CLONE_ARTIFACTS.intake);
        if (isOutcome(intake)) return intake;
        const design = stageOutput(run, "recipe_designer");
        const envelope = await cloneMintStep({ targetProjectId, intake, design });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "theme_bind": {
        const intake = envelopeOf(run, "clone_intake", CLONE_ARTIFACTS.intake);
        if (isOutcome(intake)) return intake;
        const themeProposal = stageOutput(run, "theme_reconciler");
        const envelope = await cloneThemeBindStep({ targetProjectId, intake, themeProposal });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "restamp": {
        const intake = envelopeOf(run, "clone_intake", CLONE_ARTIFACTS.intake);
        if (isOutcome(intake)) return intake;
        const mint = envelopeOf(run, "recipe_mint", CLONE_ARTIFACTS.mint);
        if (isOutcome(mint)) return mint;
        // T13.4 PART C: fit_adjudicator is a pure AI node (no cloneStageDeterministic, no route of
        // its own — read the same way `design`/`themeProposal` are, below) sitting between
        // recipe_mint and layout_restamp in the graph. Its output is OPTIONAL here for the identical
        // reason it is optional on cloneRestampStep/buildRestampOps: a run that predates this node,
        // or a mock traversal that never populated it, must still restamp byte-identically to before.
        const adjudication = stageOutput(run, "fit_adjudicator");
        const envelope = await cloneRestampStep({ targetProjectId, intake, mint, adjudication });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "report": {
        const intake = envelopeOf(run, "clone_intake", CLONE_ARTIFACTS.intake);
        if (isOutcome(intake)) return intake;
        const mint = envelopeOf(run, "recipe_mint", CLONE_ARTIFACTS.mint);
        if (isOutcome(mint)) return mint;
        const themeBind = envelopeOf(run, "theme_bind", CLONE_ARTIFACTS.themeBind);
        if (isOutcome(themeBind)) return themeBind;
        const restamp = envelopeOf(run, "layout_restamp", CLONE_ARTIFACTS.restamp);
        if (isOutcome(restamp)) return restamp;
        const design = stageOutput(run, "recipe_designer");
        // Same dependency, read the same way, for the report's own (separate, re-validated-nothing)
        // informational relay of non-section_type choices — see buildCloneRunReport's doc comment.
        const adjudication = stageOutput(run, "fit_adjudicator");
        const output = buildCloneReportStep({
          intake: intake as unknown as CloneIntakeEnvelope,
          mint: mint as unknown as CloneMintEnvelope,
          themeBind: themeBind as unknown as CloneThemeBindEnvelope,
          restamp: restamp as unknown as CloneRestampEnvelope,
          design,
          adjudication
        });
        return { kind: "completed", output: output as unknown as Record<string, unknown> };
      }
    }
  } catch (error) {
    if (error instanceof CloneRefusal) return refused(error.code, error.message);
    return refused("threw", error instanceof Error ? error.message : String(error));
  }
}
