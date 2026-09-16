import { resolveExecutionKind, resolveRouteEra, resolveRouteId, routeManifest, type RouteRequiredTool } from "./routeRegistry.js";
import { MODEL_ROUTE_ERA } from "./nodeTimings.js";
import type { WorkspaceNode } from "./nodeTypes.js";

// W4 — WHAT A DETERMINISTIC NODE ACTUALLY DOES.
//
// A model node explains itself: its prompt is right there in the inspector. A deterministic node's
// behaviour is engine code, and until now the Workbench showed an operator an empty Prompt tab, an
// empty Tools tab (a deterministic route consults no node grant) and nothing else — for a node that
// might crawl a site, mint objects on a tenant, or publish a template. "Deterministic" was a glyph,
// not an explanation.
//
// This is the explanation, and it is CANONICAL — code, not a store field an operator can edit into
// disagreeing with the executor. Two sources, deliberately:
//
//   * The tenant verbs and their risks come from ROUTE_MANIFESTS, never re-typed here. That list is
//     maintained next to the claim windows it also governs and is attributed from source; copying
//     it would guarantee the copy goes stale, and a stale "which verbs can this node reach" answer
//     is worse than none.
//   * The numbered steps are written here, per node, in the operator's language rather than the
//     engine's.
//
// Every deterministic node in every registered workflow must resolve to an entry — asserted by
// tests/agent/workspace/nodeAlgorithms.test.ts, which walks the registry rather than a list, so a
// new deterministic node cannot ship without one.

export type NodeAlgorithm = {
  nodeId: string;
  /** One sentence: what this node is for. */
  summary: string;
  /** Repo-relative module that implements it, so a reader can go and check. */
  source: string;
  /** What it reads before it does anything — dependency outputs, run facts, stored state. */
  reads: string[];
  /** Numbered, plain-language. The operator's account of the algorithm, not the engine's. */
  steps: string[];
  /** Tenant verbs the ENGINE calls directly — no node grant, no risk check, no tool ledger. */
  engineTools: RouteRequiredTool[];
  /** The route manifest phase this node is, when it belongs to a staged route. */
  route?: { routeId: string; phaseId?: string };
  /** True when the route reaches the tenant but its verbs could not be attributed from source. */
  engineToolsUnverified?: boolean;
};

/** The hand-written half. Tool lists are NEVER here — see the header. */
type AlgorithmText = Pick<NodeAlgorithm, "summary" | "source" | "reads" | "steps">;

const TEXT: Record<string, AlgorithmText> = {
  // ---- publishing_conductor -----------------------------------------------------------------
  placement_resolver: {
    summary: "Computes the aggression TARGET vector for this placement from the request's traffic source and awareness stage — four dials, 0-1, never hand-set.",
    source: "src/agent/workspace/aggressionVector.ts",
    reads: ["the run's initial input (trafficSource, awarenessStage)", "input_triage's content_source.v1 envelope"],
    steps: [
      "Read trafficSource and awarenessStage from the run's input, falling back to input_triage's envelope.",
      "Refuse — as a blocker, never a default — if either is missing: a target guessed from content alone is not a target.",
      "Look up the fixed (trafficSource, awarenessStage) → dial mapping for claim_strength, urgency, emotional_agitation and cta_density.",
      "Emit placement_resolution.v1 echoing both inputs, the four dials, and the mapping applied as the rationale.",
      "Resolution against the client's ceiling happens downstream, where the contract is available — never here."
    ]
  },
  contract_intelligence: {
    summary: "Turns the client's already-fetched, already-reduced object contract into the rules every downstream node obeys — without a model turn when the prefetch succeeded.",
    source: "src/agent/workspace/deterministicContractIntelligence.ts",
    reads: ["the run's prefetchedContract (fetched deterministically before dispatch)", "resolvedAggression (ceiling and target)", "brief_architect's article_brief.v1"],
    steps: [
      "Take the prefetched, reduced client contract from the run's own facts — never re-fetch it, and never reconstruct it from memory.",
      "Carry its parts through verbatim: clientObjectType, bodySchema, id conventions, media convention, taxonomy, constraints, publish policy, contract source.",
      "Read the four-dial aggression ceiling from resolvedAggression.ceiling, or from the contract's own aggressionCeiling — never invent, round or relax a dial.",
      "Compare the brief's provisional resolved vector against that ceiling and emit a blocker naming every dial that exceeds it.",
      "Emit a blocker, not a default, when the contract carries no ceiling or declares fewer than four dials.",
      "Emit contract_intelligence.v1. If the deterministic prefetch failed, the node falls back to its model route instead."
    ]
  },
  artifact_materializer: {
    summary: "Executes artifact_plan's materialization spec slot by slot: adopt an existing artifact, else create one, then poll it — bounded, and resumable across dispatches.",
    source: "src/agent/workspace/artifactMaterialization.ts",
    reads: ["artifact_plan's materialization_spec.v1", "this run's stored slot state from earlier dispatches"],
    steps: [
      "Read the spec and reconcile it against the slot state this run already holds, so nothing already made is made twice.",
      "For each slot in turn: try to adopt an artifact a previous run produced for the same slot.",
      "If nothing was adopted, create one generation job for that slot.",
      "Poll that job once — once per dispatch, not in a loop: an unfinished job re-queues the node rather than holding the claim.",
      "Record every slot's outcome, and stop cleanly when the dispatch budget runs out so the next advance resumes where this one stopped."
    ]
  },
  publish_payload: {
    summary: "Assembles the publish payload from what the run produced, and validates it before anything is offered to a tenant.",
    source: "src/agent/workspace/publishExecution.ts",
    reads: ["every upstream node's stage output", "the run's contract intelligence", "the run's publish request id"],
    steps: [
      "Collect the produced artifacts and the article body the run's own nodes emitted.",
      "Shape them into the tenant's declared object contract — the client's contract, never a workspace-local schema.",
      "Validate the assembled payload against that contract and fail here rather than at the tenant.",
      "Emit the payload for publication_controller to decide on. Assembling it authorizes nothing."
    ]
  },
  publication_controller: {
    summary: "The publish DECISION. Reads the run's own gates and the operator's durable decision, and says go or no-go — nothing else in the engine may say it.",
    source: "src/agent/workspace/publishDecision.ts",
    reads: ["the run's publish gates", "the durable operator publish decision", "the project's publish policy"],
    steps: [
      "Evaluate every gate in the closed publish gate set against this run.",
      "Resolve publish authority: an explicit operator decision, or an autonomous snapshot the project's policy allows — nothing else.",
      "Refuse when the run carries any supplied (defaulted or overridden) output and is not a mock run: fixture content never publishes.",
      "Emit the decision. A no-go names the gate that produced it."
    ]
  },
  publish_executor: {
    summary: "Performs the publish the controller authorized — and only that one.",
    source: "src/agent/workspace/publisher.ts",
    reads: ["publication_controller's decision", "publish_payload's payload"],
    steps: [
      "Re-read the controller's decision from the run record rather than from a caller's flag.",
      "Stop unless that decision is affirmative and publish authority still resolves.",
      "Call the tenant's own publish verb with the validated payload.",
      "Record the receipt on the run, including what the tenant returned."
    ]
  },
  release_executor: {
    summary: "Releases the published object to production — the only place in engine code that calls release_to_production.",
    source: "src/agent/workspace/releaseExecution.ts",
    reads: ["publish_executor's receipt", "the project's release policy"],
    steps: [
      "Read the publish receipt; without one there is nothing to release.",
      "Call the tenant's release verb for the published object.",
      "Record the release receipt on the run."
    ]
  },
  learning_recorder: {
    summary: "Writes what this run learned — observations and the run's own outcome — into the improvement store.",
    source: "src/agent/workspace/nodes.ts (learning_recorder route)",
    reads: ["the whole run record: node outcomes, errors, approvals, receipts"],
    steps: [
      "Summarize the run: which nodes produced, which were supplied, which failed, and how it ended.",
      "Record observations stamped with this run and its nodes, so a lesson can be traced back to what produced it.",
      "Never treat a supplied (defaulted or overridden) output as evidence about a node's real behaviour."
    ]
  },
  // ---- capture_conductor --------------------------------------------------------------------
  capture_crawl: {
    summary: "Creates the crawl job for the source site, then polls it once per dispatch until a snapshot exists.",
    source: "src/agent/capture/captureConductorRoutes.ts",
    reads: ["the run's source URL and crawl options", "this run's stored crawl-job ledger"],
    steps: [
      "Adopt the crawl job this run already started, if there is one, instead of starting another.",
      "Otherwise create the crawl job against pdf-tool.",
      "Poll its status exactly once, then stop: an unfinished crawl re-queues the node rather than holding the claim open.",
      "When it is finished, fetch the snapshot and hand it on."
    ]
  },
  capture_map: {
    summary: "Builds the block mapping from the crawl snapshot. Local computation — no tenant call.",
    source: "src/agent/capture/captureEngine.ts",
    reads: ["capture_crawl's snapshot"],
    steps: ["Walk the snapshot's pages and sections.", "Classify each region into the block vocabulary.", "Emit the mapping, with the regions it could not place named rather than dropped."]
  },
  capture_map_refine: {
    summary: "Re-maps the snapshot with block_classifier's suggestions applied. Local computation.",
    source: "src/agent/capture/captureEngine.ts",
    reads: ["capture_map's mapping", "block_classifier's suggestions"],
    steps: ["Take the first mapping and the classifier's proposed corrections.", "Apply each correction that names a region the mapping actually holds.", "Emit the refined mapping and what changed."]
  },
  capture_theme: {
    summary: "Derives the site's theme — colour, type, spacing — from the crawl snapshot. Local computation.",
    source: "src/agent/capture/engine/theme.js",
    reads: ["capture_crawl's snapshot"],
    steps: ["Collect the computed styles the crawl recorded.", "Reduce them to the theme vocabulary the target site accepts.", "Emit the theme."]
  },
  capture_emit_dry: {
    summary: "Plans the emission without touching the tenant: what would be created, reused or skipped.",
    source: "src/agent/capture/captureEngine.ts",
    reads: ["the refined mapping", "the derived theme"],
    steps: ["Build the emission plan from the mapping and theme.", "Decide per item whether it would be created or reused.", "Emit the plan. Nothing is written anywhere — this stage is handed no transport at all."]
  },
  capture_emit_live: {
    summary: "Performs the emission: probes and ingests every asset, then creates or reuses each object on the target site. The long tail of this route, and resumable.",
    source: "src/agent/capture/engine/emit.mjs",
    reads: ["the emission plan", "the target site's inventory and contracts", "this run's media ledger from earlier dispatches"],
    steps: [
      "Read the target's inventory and contract per object type — reuse first, create second.",
      "For each asset: probe it at the source, then ingest it into the target's artifact store, skipping anything already in this run's ledger.",
      "Validate each candidate body against the target's own validator before it is written, and again after.",
      "Create the emitted objects as drafts, or check out, patch and check in an existing one when reusing.",
      "Stop cleanly on the media budget with a manifest ledger, so the next dispatch resumes instead of starting the emission again."
    ]
  },
  capture_score: {
    summary: "Scores the emission against the source, locally, and dispatches the visual half to the platform's capture-preview job.",
    source: "src/agent/capture/captureEngine.ts",
    reads: ["the emission result", "the crawl snapshot", "the visual comparison job's result across advances"],
    steps: ["Score structure and content locally against the snapshot.", "Dispatch the visual comparison to the platform job and collect its result on a later advance.", "Emit the score and the gap report."]
  },
  capture_report: {
    summary: "Summarizes the capture run. Local computation.",
    source: "src/agent/capture/captureEngine.ts",
    reads: ["every earlier stage's output"],
    steps: ["Collect each stage's result.", "Emit one report: what was captured, what was emitted, what scored badly and what was skipped."]
  },
  // ---- clone_conductor ----------------------------------------------------------------------
  clone_intake: {
    summary: "Reads the source structure and what the target already holds, so the clone can reuse rather than duplicate.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["the run's source and target project ids", "the block/type registry"],
    steps: ["Read the source objects.", "Read the target's inventory.", "Read the block and type registry.", "Emit what exists on each side and what the clone will therefore have to mint."]
  },
  recipe_mint: {
    summary: "Creates the cloned structure on the target from the designed recipes.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["recipe_designer's recipes", "clone_intake's inventory"],
    steps: ["Lock each object before writing it.", "Create the cloned objects and imagery drafts.", "Emit what was minted, with the ids the target assigned."]
  },
  theme_bind: {
    summary: "Applies the reconciled theme to the target SITE — the one admin-risk verb on this route.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["theme_reconciler's theme", "the target site's current theme object"],
    steps: ["Read the theme's object on the target.", "Lock it.", "Apply the theme site-wide.", "Release the lock and record what was applied."]
  },
  layout_restamp: {
    summary: "Re-stamps layouts onto the cloned objects.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["the minted objects", "the bound theme"],
    steps: ["Read each object being restamped.", "Lock it, patch the layout, release the lock.", "Record every object restamped and every one skipped."]
  },
  clone_report: {
    summary: "Summarizes the clone. Local computation.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["every earlier stage's output"],
    steps: ["Collect each stage's result.", "Emit one report: what was cloned, what was reused, what failed."]
  },
  pdf_template_intake: {
    summary: "Reads the PDF template brief out of the run's own input. Local computation.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["the run's initial input"],
    steps: ["Read the brief.", "Normalize it into the template contract's shape.", "Emit it, naming anything the brief left unspecified."]
  },
  pdf_template_mint: {
    summary: "Creates the PDF template, starts a validation run against worst-case sample data, and polls that report.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["the intake brief", "pdf_template_designer's renderer payloads where present"],
    steps: ["Mint the draft template in pdf-tool's template store.", "Start a validation run against the brief's worst-case sample data.", "Poll the validation report a bounded number of times.", "Emit the template ref and its validation outcome."]
  },
  pdf_template_publish: {
    summary: "Publishes the PDF template so it goes live in pdf-tool's template store.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["pdf_template_mint's template ref and validation outcome"],
    steps: ["Stop unless the template validated.", "Publish it.", "Record the published version."]
  },
  // ---- pdf_template_studio ------------------------------------------------------------------
  pdf_template_library_deposit: {
    summary: "Step B of the studio's two-step publication: deposits each published template into the cross-tenant template library.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["the published template refs", "the cross-tenant TemplateLibraryStore"],
    steps: ["Take only templates that actually published.", "Deposit each into the shared library store.", "Record every deposit, and every one refused."]
  },
  pdf_template_family_report: {
    summary: "Assembles the family's terminal per-variant ledger — one outcome per variant, nothing aggregated away.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["every variant's mint, publish and deposit outcome"],
    steps: ["Collect each variant's terminal outcome.", "Classify it: reused, published, contract-rejected, mint-rejected, publish-failed, library-export-refused or plan-rejected.", "Emit the ledger with the family's partial/all-failed state computed from it."]
  },
  // ---- image_template_revision_studio -------------------------------------------------------
  image_revision_intake: {
    summary: "Resolves the source image once, then fetches every target template's current version from the shared template library.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["the run's source image reference", "the target template refs", "the cross-tenant TemplateLibraryStore"],
    steps: ["Resolve the source image a single time.", "Fetch each target template's current version from the library.", "Emit the work list, naming any template that could not be resolved."]
  },
  image_revision_compile_preview: {
    summary: "Compiles the recurring-header image edit locally and renders a before/after preview.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["intake's work list", "each template's current version"],
    steps: ["Compute the edit for each template — local computation.", "Render a before/after preview through the injectable preview provider.", "Emit the previews for an approval decision. Nothing is written to pdf-tool here."]
  },
  image_revision_apply: {
    summary: "For approved items: mints, validates and publishes the next template version, then verifies it in the library.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["the approved preview items"],
    steps: ["Take only items that were previewed and approved.", "Mint the next version's draft and validate it.", "Publish it.", "Verify the published version is what the library now holds."]
  },
  image_revision_report: {
    summary: "Assembles the terminal per-item ledger — one outcome per template ref. Local computation.",
    source: "src/agent/capture/cloneConductorRoutes.ts",
    reads: ["every item's apply outcome"],
    steps: ["Collect one outcome per template ref.", "Compute the run's partial / all-failed state from those outcomes.", "Emit the ledger."]
  },
  // ---- visual_identity ----------------------------------------------------------------------
  visual_standard_materializer: {
    summary: "Materializes the proposed visual standard into the site's own brand imagery objects.",
    source: "src/agent/workspace/visualStandardMaterialization.ts",
    reads: ["the proposed visual standard", "the site's brand imagery override policy"],
    steps: ["Read the proposed standard and the site's override policy.", "Create or update the brand imagery objects the standard declares.", "Record what was applied and what the policy refused."]
  },
  // ---- asset_lookup_studio ------------------------------------------------------------------
  asset_lookup_search: {
    summary: "Searches the image banks for candidates matching the brief, deterministically and without a model turn.",
    source: "src/agent/workspace/assetLookupNodes.ts",
    reads: ["the run's search brief", "the project's image search policy"],
    steps: ["Read the brief and the project's search policy.", "Query the configured image banks.", "Rank the candidates by the policy's own criteria.", "Emit the ranked candidate set with its provenance."]
  },
  asset_lookup_adopt: {
    summary: "Imports the chosen candidates into the project's artifact store and records what was adopted.",
    source: "src/agent/workspace/assetLookupNodes.ts",
    reads: ["the selected candidates", "the project's artifact store"],
    steps: ["Take the selected candidates only.", "Import each one into the project's artifact store by URL.", "Emit the adopted asset refs, naming every import that failed."]
  },
  // ---- document_render_studio ---------------------------------------------------------------
  document_render_execute: {
    summary: "Renders the requested document against its template and render data.",
    source: "src/agent/workspace/documentRenderWorkflow.ts",
    reads: ["the run's template ref and render data"],
    steps: ["Validate the render data against the template's declared schema.", "Render the document.", "Emit the rendered artifact ref, or the validation failure that stopped it."]
  },
  document_render_report: {
    summary: "Summarizes the render. Local computation.",
    source: "src/agent/workspace/documentRenderWorkflow.ts",
    reads: ["the render outcome"],
    steps: ["Collect the render outcome.", "Emit one report: what rendered, what did not, and why."]
  }
};

/** The tenant verbs a node's route phase declares, straight from ROUTE_MANIFESTS — never re-typed. */
const engineToolsFor = (node: WorkspaceNode): { tools: RouteRequiredTool[]; unverified: boolean; route?: { routeId: string; phaseId?: string } } => {
  const era = resolveRouteEra(node);
  if (era === MODEL_ROUTE_ERA) return { tools: [], unverified: false };
  const routeId = resolveRouteId(node);
  const phaseId = era.includes(":") ? era.split(":")[1] : undefined;
  if (!routeId) return { tools: [], unverified: false };
  const manifest = routeManifest(routeId);
  const phase = phaseId ? manifest?.phases.find((candidate) => candidate.id === phaseId) : undefined;
  return {
    tools: phase?.requiredTools ?? [],
    unverified: Boolean(phase?.requiredToolsUnverified),
    route: { routeId, ...(phaseId ? { phaseId } : {}) }
  };
};

/**
 * The algorithm for one node, or null for a model node (whose explanation is its prompt).
 *
 * A deterministic node with no entry returns null rather than a plausible-looking blank, because a
 * blank algorithm panel that says nothing is worse than an absent one that says so — and the
 * registry-walking test makes sure that case never reaches an operator.
 */
export function algorithmFor(node: WorkspaceNode): NodeAlgorithm | null {
  if (resolveExecutionKind(node) !== "deterministic") return null;
  const text = TEXT[node.id];
  if (!text) return null;
  const { tools, unverified, route } = engineToolsFor(node);
  return {
    nodeId: node.id,
    ...text,
    engineTools: tools,
    ...(route ? { route } : {}),
    ...(unverified ? { engineToolsUnverified: true as const } : {})
  };
}

/** For the registry-walking test and for any audit that wants the whole set. */
export const describedNodeIds = (): string[] => Object.keys(TEXT).sort();
