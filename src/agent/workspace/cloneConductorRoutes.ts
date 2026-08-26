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
  buildCloneObjectPublishReport,
  buildCloneReportStep,
  cloneIntakeStep,
  cloneMintStep,
  cloneRestampStep,
  cloneThemeBindStep,
  depositPublishedTemplatesStep,
  resolveCloneAuthority,
  CloneRefusal,
  CLONE_ARTIFACTS,
  type CloneIntakeEnvelope,
  type CloneMintEnvelope,
  type CloneRestampEnvelope,
  type CloneThemeBindEnvelope,
  type LibraryDepositLedger
} from "../capture/cloneEngine.js";
// T15.10 (#189, ADR-2026-08-25-publish-autonomy §6.2, §9) — clone_conductor's publish_payload,
// publication_controller and publish_executor stages, joining the shared publishing tail exactly as
// T15.7 (#187) did for capture_conductor. These are the SAME canonical tail node ids and shapes
// publishing_conductor uses (publishingTail.ts / nodes.ts) — cloneConductorNodes.ts composes them
// onto clone's upstream via composeWorkflowNodes and retags their metadata (clone's OWN copy only) so
// they dispatch through THIS module's deterministic route instead of the DTC-specific one. Mirrors
// captureConductorRoutes.ts's identical three cases exactly, differing only in WHERE the object
// publish report is assembled from (three stage envelopes here, one emission report there). No
// release-specific code exists here at all: release_executor is already object-agnostic (reads only
// publish_executor's own `publishCommitted` flag), so the canonical dispatch runs unchanged for clone.
import { ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { isProjectPublishEnabled, type CallToolFn } from "./publisher.js";
import { resolvePublishAuthority } from "./publishDecision.js";
import { buildObjectPublishPlan, executeObjectPublish, type ObjectPublishPlan } from "./objectPublishExecution.js";
// T15.32 (#208; ADR-2026-08-25-structure-studio §5.2) — the client-memory write. "report" is the
// studio's TERMINAL stage (the ADR's own phrase): every upstream stage, including release_executor,
// has already run and landed its own stage output by the time this case executes, so this is the one
// place in the graph that can state "what this run actually finished" once and mean it. The write
// reads the just-deposited library record BACK (never re-derives its provenance) and is a plain
// side effect — see clientMemoryStore.ts's own header for why its return value must never be folded
// into this stage's own output.
import { TemplateLibraryStore } from "../library/templateLibraryStore.js";
import { ClientMemoryStore } from "../memory/clientMemoryStore.js";
import type { TemplateArtifactValue } from "../memory/memoryEnvelope.js";
// T15.34 (#210; ADR-2026-08-25-structure-studio §7) — the pdf-template branch's own deterministic
// stages, dispatched by "pdf_intake"/"pdf_mint"/"pdf_publish" below exactly as the clone stages above
// are — SEPARATE functions, SEPARATE artifacts, NEVER routed through cloneMintStep/publish_executor/
// the shared publishing tail. See pdfTemplateEngine.ts's own header for the full discipline/transport
// argument.
import { pdfTemplateIntakeStep, pdfTemplateMintStep, pdfTemplatePublishStep, depositPublishedPdfTemplatesStep, PDF_TEMPLATE_ARTIFACTS } from "../capture/pdfTemplateEngine.js";

export const CLONE_STAGES = ["intake", "mint", "theme_bind", "restamp", "publish_payload", "publication_controller", "publish_executor", "report", "pdf_intake", "pdf_mint", "pdf_publish"] as const;
export type CloneStage = typeof CLONE_STAGES[number];

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export const readCloneStage = (node: Pick<WorkspaceNode, "metadata">): CloneStage | undefined => {
  const declared = node.metadata?.cloneStageDeterministic;
  return typeof declared === "string" && (CLONE_STAGES as readonly string[]).includes(declared) ? (declared as CloneStage) : undefined;
};

export type CloneStageOutcome = { kind: "completed"; output: Record<string, unknown> } | { kind: "refused"; code: string; message: string };

const refused = (code: string, message: string): CloneStageOutcome => ({ kind: "refused", code, message });

// T15.30 (#206; ADR-2026-08-25-structure-studio §3) — "one node graph, two entry adapters." A run's
// facts now carry EITHER a captureRunId (clone-driven, unchanged since T13.1) OR a structureBrief
// (demand-driven, T15.30) — never both, never neither. Only the "intake" case below reads the
// mode-specific field; everything downstream reads the SAME `clone_intake` envelope regardless of
// which entry produced it, exactly as the ADR requires ("everything downstream is byte-identically
// the same graph").
type RunFacts = { targetProjectId: string } & (
  | { mode: "clone"; captureRunId: string }
  | { mode: "demand"; structureBrief: unknown }
);

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
  if (captureRunId) return { targetProjectId: runProject, mode: "clone", captureRunId };
  // DEMAND-DRIVEN (T15.30): no captureRunId — a structureBrief instead. `null`/`undefined` is not a
  // brief; presence alone selects the mode here, and cloneIntakeStep/buildCloneIntake do the real
  // (total, deterministic) validation of its shape, so this stays a single "is one supplied" check.
  if (initial.structureBrief !== undefined && initial.structureBrief !== null) {
    return { targetProjectId: runProject, mode: "demand", structureBrief: initial.structureBrief };
  }
  return refused("clone_source_missing", "The run's initialInput carries neither a captureRunId (clone-driven) nor a structureBrief (demand-driven); clone_intake needs one or the other.");
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

// T15.30 (#206) — the ONLY thing publish_executor needs out of a demand-driven run's raw
// structureBrief: the reference it stated for provenance, when it stated one. Deliberately reads the
// RAW initialInput field rather than clone_intake's own (already-validated) `sourceUrl`, so this stays
// a plain fact of the run request — the same posture `resolveRunFacts` above already takes with
// `structureBrief` itself (presence-only, no shape validation; cloneIntakeStep/buildCloneIntake do the
// real, total validation).
const structureBriefSourceUrl = (structureBrief: unknown): string | undefined =>
  isRecord(structureBrief) && typeof structureBrief.sourceUrl === "string" && structureBrief.sourceUrl.trim() ? structureBrief.sourceUrl.trim() : undefined;

// The object publish plan publish_payload wraps into clientObject (dry_run_publish_payload.v1's
// required, minProperties>=1 `clientObject` field — the same node schema every workflow shares, so
// clone's multi-object plan travels inside it exactly as capture's does). Malformed or absent reads
// as "no plan": the caller refuses rather than guessing one.
const readObjectPublishPlan = (payload: Record<string, unknown>): ObjectPublishPlan | undefined => {
  const clientObject = isRecord(payload.clientObject) ? payload.clientObject : undefined;
  const plan = clientObject && isRecord(clientObject.objectPublishPlan) ? clientObject.objectPublishPlan : undefined;
  return plan && Array.isArray(plan.publish) && Array.isArray(plan.withheld) ? (plan as unknown as ObjectPublishPlan) : undefined;
};

// T15.32 (#208; ADR-2026-08-25-structure-studio §5.2, §5.3) — deterministic, engine-authored (never a
// model turn): every field this builds comes from READING BACK already-persisted data — the
// TemplateLibraryStore record templateDeposit.ts/depositPublishedTemplatesStep just wrote in THIS
// SAME run (publish_executor, above), and the objectId the library ledger already names. Nothing here
// invents, infers, or asks a model for anything. NEVER FATAL to the run: mirrors
// depositPublishedTemplatesStep's own "one candidate's failure never aborts the batch" discipline —
// a memory-store outage must not turn a successful publish into a failed report.
type ClientMemoryWriteResult = { attempted: boolean; recordedCount: number; refused: number; note?: string };

async function writeTemplateMemoryRecords(input: {
  targetProjectId: string;
  entries: Array<{ templateId: string; version: number; objectId: string }>;
}): Promise<ClientMemoryWriteResult | undefined> {
  if (input.entries.length === 0) return undefined;
  const libraryStore = new TemplateLibraryStore();
  const records: TemplateArtifactValue[] = [];
  let refused = 0;
  try {
    for (const entry of input.entries) {
      const record = await libraryStore.getVersion(entry.templateId, entry.version);
      if (!record) {
        // Read-your-own-write inconsistency (the deposit above claimed this version exists) — never
        // thrown; named and skipped, the same "refuse this one candidate, not the batch" posture
        // depositPublishedTemplatesStep itself takes.
        refused += 1;
        continue;
      }
      records.push({ templateId: record.templateId, version: record.version, objectType: record.objectType, instantiatedObjectId: entry.objectId, provenance: record.provenance });
    }
    await new ClientMemoryStore().recordTemplates(input.targetProjectId, records);
    return { attempted: true, recordedCount: records.length, refused };
  } catch (error) {
    // A memory-store failure is a bookkeeping failure, not a publish failure — the objects this run
    // published stay published either way (ADR §5's memory is a LEDGER of what happened, not a gate
    // on whether it happens). Named honestly rather than silently dropped.
    return { attempted: true, recordedCount: 0, refused: input.entries.length, note: `template_memory_write_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// T15.34 (#210) — the project-only half of resolveRunFacts, factored out so the pdf-template branch
// can resolve "which project" WITHOUT resolveRunFacts's mode requirement ("exactly one of
// captureRunId/structureBrief") ever applying to it: a pdf_template is designed from its own
// pdfTemplateBrief, never from a capture run or a structure need, and requiring either of those on a
// run that only briefs a pdf template would make the pdf-template branch unreachable on its own.
// Every clone/structure stage keeps calling the FULL resolveRunFacts (unchanged) for the mode facts
// it actually needs (see the "intake" and "publish_executor" cases, below) — this helper duplicates
// only the project-identity checks resolveRunFacts already performs, never the mode branch.
const resolveRunProjectId = (run: WorkflowExecutionRecord): { targetProjectId: string } | CloneStageOutcome => {
  const initial = isRecord(run.initialInput) ? run.initialInput : {};
  const declaredTarget = typeof initial.targetProjectId === "string" ? initial.targetProjectId.trim() : "";
  const runProject = typeof run.projectId === "string" ? run.projectId.trim() : "";
  if (!runProject) return refused("clone_target_missing", "The run carries no projectId; clone bounds are per-project.");
  if (declaredTarget && declaredTarget !== runProject) {
    return refused("clone_target_mismatch", `initialInput.targetProjectId ("${declaredTarget}") differs from the run's own projectId ("${runProject}"); the run's project is the policy authority and a clone may not be redirected to another project's bounds.`);
  }
  return { targetProjectId: runProject };
};

export async function runCloneStage(input: { run: WorkflowExecutionRecord; node: WorkspaceNode; stage: CloneStage }): Promise<CloneStageOutcome> {
  const { run, stage } = input;
  const resolvedProject = resolveRunProjectId(run);
  if (isOutcome(resolvedProject)) return resolvedProject;
  const { targetProjectId } = resolvedProject;
  try {
    switch (stage) {
      case "intake": {
        // T15.30 — the ONE branch in this whole module that reads which entry the CLONE/STRUCTURE
        // side of the run took. Resolved HERE, not at the top of runCloneStage (T15.34/#210): a
        // pdf-template-only run (pdfTemplateBrief, no captureRunId/structureBrief) must reach
        // pdf_intake/pdf_mint/pdf_publish below without tripping resolveRunFacts's "needs one or the
        // other" requirement, which belongs to clone_intake alone. Everything downstream of THIS case
        // reads clone_intake's own envelope, never `facts` again.
        const facts = resolveRunFacts(run);
        if (isOutcome(facts)) return facts;
        const envelope =
          facts.mode === "clone"
            ? await cloneIntakeStep({ targetProjectId, captureRunId: facts.captureRunId })
            : await cloneIntakeStep({ targetProjectId, structureBrief: facts.structureBrief });
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
      // T15.34 (#210; ADR-2026-08-25-structure-studio §7) — the pdf-template branch. THIS IS NOT THE
      // SHARED PUBLISHING TAIL and pdf_publish is not publish_executor: pdf_intake/pdf_mint never
      // touch a CMS objectId, and pdf_publish calls pdf-tool's own publish_pdf_template, never
      // object_publish. pdf_publish's node is declared riskLevel:"publish" (cloneConductorNodes.ts)
      // purely so the executor's SAME generic publish-risk gate (isPublishRisk/resolvePublishAuthority,
      // keyed on riskLevel alone — never on node id or which tail composed a node) refuses to dispatch
      // it for an operator-withheld or non-autonomous run, exactly as it already does for
      // publication_controller/publish_executor below. By the time this case runs at all, that gate
      // has already resolved — this case's own job is purely "call the pdf-tool bridge and report".
      case "pdf_intake": {
        const envelope = pdfTemplateIntakeStep({ initialInput: run.initialInput });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "pdf_mint": {
        const intake = envelopeOf(run, "pdf_template_intake", PDF_TEMPLATE_ARTIFACTS.intake);
        if (isOutcome(intake)) return intake;
        const design = stageOutput(run, "pdf_template_designer");
        const envelope = await pdfTemplateMintStep({ targetProjectId, intake, design });
        return { kind: "completed", output: envelope as unknown as Record<string, unknown> };
      }
      case "pdf_publish": {
        const mint = envelopeOf(run, "pdf_template_mint", PDF_TEMPLATE_ARTIFACTS.mint);
        if (isOutcome(mint)) return mint;
        const { config } = await resolveCloneAuthority(targetProjectId);
        if (!isProjectPublishEnabled(config)) {
          return refused(
            "pdf_template_publish_disabled",
            `Project "${targetProjectId}" is not publish-enabled (publishingPolicy.publishEnabled, or its per-project *_PUBLISH_ENABLED env override, is off); nothing was published to pdf-tool for it. This is the SAME kill-switch read publish_payload uses for CMS structure, applied here to a different store.`
          );
        }
        const envelope = await pdfTemplatePublishStep({ targetProjectId, mint });
        const authority = resolvePublishAuthority(run);
        const library = envelope.published.length > 0
          ? await depositPublishedPdfTemplatesStep({ sourceProjectId: targetProjectId, mint, published: envelope.published })
          : undefined;
        const output = {
          ...envelope,
          approvalMatched: authority.authorized,
          publishAuthority: {
            mode: run.publishingPolicySnapshot?.autonomyMode ?? "operator-gated",
            source: authority.authorized ? authority.source : null,
            operatorDecision: run.operatorPublishDecision ?? null
          },
          ...(library ? { library } : {})
        };
        return { kind: "completed", output: output as unknown as Record<string, unknown> };
      }
      // T15.10 (ADR-2026-08-25-publish-autonomy §6.2, §9) — clone_conductor's segment of the SHARED
      // publishing tail. These three stages ARE publish_payload / publication_controller /
      // publish_executor — the identical tail node ids composeWorkflowNodes bound onto
      // clone_conductor's upstream (cloneConductorNodes.ts), not a clone-local reimplementation. The
      // operator veto and the project's autonomy policy are no longer read here at all: for
      // publication_controller and publish_executor (both riskLevel "publish") the executor's OWN
      // publish-risk gate (executor.ts, resolvePublishAuthority) already refused the dispatch before
      // this code can run, so a withheld run or an operator-gated run with no decision never reaches
      // this switch for those two stages.
      case "publish_payload": {
        const intake = envelopeOf(run, "clone_intake", CLONE_ARTIFACTS.intake);
        if (isOutcome(intake)) return intake;
        const mint = envelopeOf(run, "recipe_mint", CLONE_ARTIFACTS.mint);
        if (isOutcome(mint)) return mint;
        const themeBind = envelopeOf(run, "theme_bind", CLONE_ARTIFACTS.themeBind);
        if (isOutcome(themeBind)) return themeBind;
        const restamp = envelopeOf(run, "layout_restamp", CLONE_ARTIFACTS.restamp);
        if (isOutcome(restamp)) return restamp;
        const { projectId, config } = await resolveCloneAuthority(targetProjectId);
        // ADR §2.4 rows 2/3 — the kill-switch, re-evaluated LIVE (never from a snapshot): the SAME
        // reader publisher.ts's own gate uses, so clone and every other workflow can never disagree
        // about what "publishing is off" means.
        if (!isProjectPublishEnabled(config)) {
          return refused(
            "clone_publish_disabled",
            `Project "${projectId}" is not publish-enabled (publishingPolicy.publishEnabled, or its per-project *_PUBLISH_ENABLED env override, is off); clone built no publish plan for it. Nothing was published and nothing was released.`
          );
        }
        const sourceReport = buildCloneObjectPublishReport({
          target: projectId,
          intake: intake as unknown as CloneIntakeEnvelope,
          mint: mint as unknown as CloneMintEnvelope,
          themeBind: themeBind as unknown as CloneThemeBindEnvelope,
          restamp: restamp as unknown as CloneRestampEnvelope
        });
        let plan: ObjectPublishPlan;
        try {
          // T15.11 (#190, ADR §6.3) — the run's OWN snapshot, never a live charter re-resolve: see
          // publishableTypeCharter.ts / executionTypes.ts's publishableTypes header for why.
          plan = buildObjectPublishPlan({
            report: sourceReport,
            target: projectId,
            publishableTypes: run.publishingPolicySnapshot?.publishableTypes,
            workflowId: run.workflowId
          });
        } catch (error) {
          return refused("clone_publish_plan_invalid", error instanceof Error ? error.message : String(error));
        }
        const output = {
          artifact: "dry_run_publish_payload.v1",
          summary: `Deterministic object publish plan for ${projectId}: ${plan.publish.length} object(s) publishable, ${plan.withheld.length} withheld.`,
          clientProjectId: projectId,
          clientObjectType: "clone_structure_batch",
          contractSource: { source: "clone_conductor", targetProjectId: projectId },
          dryRun: true,
          clientObject: { objectPublishPlan: plan },
          blockers: [],
          notes: [
            `Assembled deterministically (workspace/objectPublishExecution.ts) from recipe_mint/theme_bind/layout_restamp's own reports — the object-scoped self-check carried into the canonical path by T15.6. clone_conductor's chartered publishable types (T15.11/#190, ADR-2026-08-25-publish-autonomy §6.3, snapshotted onto this run at creation): ${[...(run.publishingPolicySnapshot?.publishableTypes ?? [])].sort().join(", ") || "(none — pre-T15.11 run, falling back to page/navigation)"}.`,
            plan.withheld.length ? `${plan.withheld.length} object(s) withheld — each is named with its reason in clientObject.objectPublishPlan.withheld.` : "Nothing was withheld: every candidate object's own validation passed, nothing quarantined it, and its type is inside the studio's charter."
          ]
        };
        return { kind: "completed", output };
      }
      case "publication_controller": {
        const payload = envelopeOf(run, "publish_payload", "dry_run_publish_payload.v1");
        if (isOutcome(payload)) return payload;
        const plan = readObjectPublishPlan(payload);
        if (!plan) {
          return refused("clone_publish_plan_missing", "publish_payload produced no objectPublishPlan; publication_controller cannot decide without one.");
        }
        const output = {
          artifact: "publication_decision.v1",
          summary: `Clone publication decision for ${payload.clientProjectId}: ${plan.publish.length} object(s) cleared to publish, ${plan.withheld.length} withheld (named at publish_payload). Decision: go.`,
          decision: "go",
          state: "ready_for_publish_execution",
          blockers: [],
          notes: [
            "Deterministic (cloneConductorRoutes.ts): the object-scoped self-check already ran at publish_payload (workspace/objectPublishExecution.ts). This decision is run-scoped only — is there a viable plan to execute — and is never a re-judgment of any one object's admission; that judgment belongs to publish_executor's own per-object gate.",
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
          return refused("clone_publish_plan_missing", "publish_payload produced no objectPublishPlan; publish_executor cannot execute without one.");
        }
        const { config } = await resolveCloneAuthority(targetProjectId);
        const callTool: CallToolFn = (tool, args) => new ProjectMcpAdapter(config).callTool(tool, args);
        const result = await executeObjectPublish({ plan, callTool });
        const authority = resolvePublishAuthority(run);
        const publishCommitted = result.published.length > 0;
        const status = publishCommitted ? "published_pending_release" : result.failed.length > 0 ? "blocked" : "skipped";
        // T15.31 (#207; ADR-2026-08-25-structure-studio §4.1) — "the studio's publish step deposits
        // there [the cross-tenant library] in addition to the minting tenant." Runs ONLY when
        // something actually went live above (publishCommitted) — a run whose plan withheld or failed
        // every candidate deposits nothing, and a refused deposit (e.g. unstateable provenance) never
        // aborts this stage; it is named in the ledger below for clone_report to surface.
        //
        // T15.30 (#206) — which entry drove this run is `facts.mode`, resolved HERE (T15.34/#210
        // moved this off the top of runCloneStage — see resolveRunProjectId's own header — so this is
        // the SAME resolveRunFacts call the "intake" case makes, not a cached value from it): a
        // clone-driven run's captureRunId (and, via it, its sourceUrl) is resolved exactly as before,
        // and a demand-driven run's sourceUrl (when the brief stated one) is read directly off
        // `facts.structureBrief` — no capture run to consult. This stage cannot be reached without
        // clone_intake having already succeeded (recipe_mint/publish_payload/publish_executor all
        // depend on it transitively), so resolveRunFacts is guaranteed to resolve the same mode here
        // it did there.
        const facts = resolveRunFacts(run);
        if (isOutcome(facts)) return facts;
        const mintForDeposit = envelopeOf(run, "recipe_mint", CLONE_ARTIFACTS.mint);
        const library = publishCommitted && !isOutcome(mintForDeposit)
          ? await depositPublishedTemplatesStep(
              facts.mode === "clone"
                ? { sourceProjectId: targetProjectId, driven: "clone", captureRunId: facts.captureRunId, mint: mintForDeposit as unknown as CloneMintEnvelope, publishedObjects: result.published }
                : { sourceProjectId: targetProjectId, driven: "demand", sourceUrl: structureBriefSourceUrl(facts.structureBrief), mint: mintForDeposit as unknown as CloneMintEnvelope, publishedObjects: result.published },
              {}
            )
          : undefined;
        const output = {
          artifact: "publish_execution.v1",
          summary: `Clone object publish for ${targetProjectId}: ${result.published.length} object(s) published, ${result.failed.length} failed, ${result.withheld.length} withheld. ${publishCommitted ? "release_executor performs the release next, downstream in the shared tail." : "Nothing published — release_executor will skip."}`,
          status,
          clientProjectId: targetProjectId,
          clientObjectType: "clone_structure_batch",
          contractSource: { source: "clone_conductor", targetProjectId },
          approvalMatched: authority.authorized,
          publishAuthority: {
            mode: run.publishingPolicySnapshot?.autonomyMode ?? "operator-gated",
            source: authority.authorized ? authority.source : null,
            operatorDecision: run.operatorPublishDecision ?? null
          },
          publishPolicyChecked: true,
          // Read by releaseExecution.ts UNCHANGED — release_executor needs no clone-specific code at
          // all, because this is the exact field the DTC/capture paths' own publish_executor stamps too.
          publishCommitted,
          // Custom field (schema additionalProperties:true): the multi-object ledger a single
          // clientObjectId cannot carry. clone_report reads this to build its publication block.
          objectPublish: { published: result.published, failed: result.failed, withheld: result.withheld, trace: result.trace },
          // T15.31 (#207) — the cross-tenant library deposit ledger, present only when this stage
          // actually attempted one (publishCommitted). clone_report reads this back verbatim.
          ...(library ? { library } : {}),
          blockers: result.failed.map((entry) => `${entry.objectType}/${entry.objectId}: ${entry.reason}${entry.detail ? ` (${entry.detail})` : ""}`),
          notes: [
            "Executed deterministically (workspace/objectPublishExecution.ts) through checkout -> object_publish -> checkin per object: one object's failure never withholds the rest, and each lease is released in a `finally`. trigger_netlify_build, deploy and release_to_production are all unreachable from this node — release_executor, downstream in the shared tail, is the ONE node authorized to release (Board decision B2, amended by ADR-2026-08-25-publish-autonomy §4)."
          ]
        };
        return { kind: "completed", output };
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
        // T15.10 — what actually went live, read from the shared tail's OWN records — absent on a run
        // whose publish_executor refused or was gated off, which the report renders as "nothing
        // published" rather than silence.
        const publishExecution = stageOutput(run, "publish_executor");
        const releaseExecution = stageOutput(run, "release_executor");
        // T15.34 (#210) — the pdf-template branch's own stage outputs, read back exactly like the
        // structure branch's above. All absent (undefined) on a run that briefed no pdf template at
        // all — pdf_template_intake still ran (it is never skipped) and its own envelope names zero
        // entries in that case, which buildCloneReportStep reads as "no pdf-template work this run"
        // (see its own header).
        const pdfTemplateIntake = stageOutput(run, "pdf_template_intake");
        const pdfTemplateMint = stageOutput(run, "pdf_template_mint");
        const pdfTemplatePublish = stageOutput(run, "pdf_template_publish");
        const pdfTemplateLibrary = pdfTemplatePublish && isRecord(pdfTemplatePublish.library) ? (pdfTemplatePublish.library as unknown as LibraryDepositLedger) : undefined;
        const output = buildCloneReportStep({
          intake: intake as unknown as CloneIntakeEnvelope,
          mint: mint as unknown as CloneMintEnvelope,
          themeBind: themeBind as unknown as CloneThemeBindEnvelope,
          restamp: restamp as unknown as CloneRestampEnvelope,
          design,
          adjudication,
          publishExecution: publishExecution?.artifact === "publish_execution.v1" ? publishExecution : undefined,
          releaseExecution: releaseExecution?.artifact === "release_execution.v1" ? releaseExecution : undefined,
          // T15.33 (#209; ADR §6.3) — stated on every capabilityRequests evidence row this stage emits.
          runId: run.runId,
          pdfTemplateIntake: pdfTemplateIntake?.artifact === PDF_TEMPLATE_ARTIFACTS.intake ? pdfTemplateIntake : undefined,
          pdfTemplateMint: pdfTemplateMint?.artifact === PDF_TEMPLATE_ARTIFACTS.mint ? pdfTemplateMint : undefined,
          pdfTemplatePublish: pdfTemplatePublish?.artifact === PDF_TEMPLATE_ARTIFACTS.publish ? pdfTemplatePublish : undefined,
          pdfTemplateLibrary        });
        // T15.32 (#208) — the studio's terminal-stage client-memory write (see
        // writeTemplateMemoryRecords's own header above). `output.library` is the SAME ledger
        // publish_executor already deposited (report reads it back verbatim, never re-derives it —
        // buildCloneReportStep's own header, above); both `deposited` (a new library version this run
        // minted) and `unchanged` (this run re-published a version the library already had) mean the
        // TARGET tenant owns that template as of this run, so both feed memory. Deliberately NOT
        // folded into `output` itself beyond the one summary field below — the memory envelope's own
        // `updatedAt` (a wall-clock ledger fact, ADR §5.3) must never enter anything this stage's
        // output carries, so only a clock-free attempt/count summary is recorded here, never the
        // envelope or its timestamp.
        // T15.34 (#210) — pdfTemplates.library folds in HERE, alongside output.library, so a
        // published pdf_template reaches the SAME per-tenant memory write under `objectType:
        // "pdf_template"` (memoryEnvelope.ts's templateArtifactValueSchema already names it, #208) —
        // "what has this client got" stays ONE answer, never two ledgers a reader has to reconcile.
        const structureEntries = output.library ? [...output.library.deposited, ...output.library.unchanged] : [];
        const pdfEntries = output.pdfTemplates?.library ? [...output.pdfTemplates.library.deposited, ...output.pdfTemplates.library.unchanged] : [];
        const clientMemory = structureEntries.length + pdfEntries.length > 0
          ? await writeTemplateMemoryRecords({
              targetProjectId,
              entries: [...structureEntries, ...pdfEntries]
            })
          : undefined;
        return { kind: "completed", output: { ...output, ...(clientMemory ? { clientMemory } : {}) } as unknown as Record<string, unknown> };
      }
    }
  } catch (error) {
    if (error instanceof CloneRefusal) return refused(error.code, error.message);
    return refused("threw", error instanceof Error ? error.message : String(error));
  }
}
