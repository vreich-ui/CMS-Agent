// THE ROUTE REGISTRY (W1.1, 2026-09-09) — what a node's dispatch is actually made of.
//
// THE DEFECT THIS EXISTS FOR. A dispatch claim is stamped ONCE, before the work starts, with one
// timeout describing "how long could this possibly take". That was true when a dispatch was one model
// call. It stopped being true as soon as routes grew sequential phases inside a single dispatch:
// article_body is model -> validate -> revision, artifact_materializer is adopt -> create -> poll per
// slot, release_executor is call -> poll. The claim describes phase 1 and the node keeps working
// through phases 2 and 3 underneath it, so `assessRunStall` reads a live node as a dead driver and
// the continuation tick re-dispatches it. That is the stall incident, and it is a MISMATCH between
// the claim and the work — not a threshold that is set too low.
//
// WHY NOT A BIGGER THRESHOLD. Two tempting non-fixes, both rejected:
//   1. Widen the initial claim to the worst case. article_body's worst case is ~645s, so a genuinely
//      dead driver would then be hidden for eleven minutes before anything reclaimed it. The claim
//      would stop lying about live work by starting to lie about dead work.
//   2. Derive the stall threshold from the node's measured p95 x 2. Measured against the ledger as of
//      2026-09-09, p95 x 2 is BELOW `timeoutMs + STALL_MARGIN_MS` for every node on
//      publishing_conductor — so under the rule that a threshold may never be shorter than today's,
//      it is a no-op that changes nothing. The one apparent exception (artifact_plan, 235s against
//      210s) was an era-mixed p95 from before that node's route went deterministic, which W0.1's
//      routeEra now prevents from ever being computed again.
//
// WHAT THIS FILE IS. Each route declares its phases and what each phase's claim window should be, and
// the executor re-stamps the claim AT each phase boundary. Stall detection then stays honest at the
// granularity of the work actually in flight: a phase that dies is reclaimed on that phase's own
// clock, and a phase that is working is never called dead. `reclaimForPhase` already did exactly this
// for article_body alone, with its phase values hard-coded at the loop; this generalises the shape and
// moves the numbers somewhere a reader can see them all at once.
//
// It is also the place the route-identity constants now live (they were spread between executor.ts's
// dispatch block and its timing helpers), which is what lets nodeTimings attribute a sample to the
// program that produced it without importing the executor.
import { MAX_ENGINE_REVALIDATION_CYCLES } from "./articleBodyValidation.js";
import { MODEL_ROUTE_ERA } from "./nodeTimings.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import { resolveNodeExecution, routeEraOf, type NodeExecutionKind } from "./nodeExecution.js";

// Grace period past a dispatched node's own timeout before the dispatch is considered dead. The
// runner's Promise.race timeout ends a live node at timeoutMs, so a "running" claim older than
// timeoutMs + this margin means the driver process was killed mid-node, not that work is still
// happening.
//
// (The margin used to be justified by "the ~300s serverless ceiling". That ceiling was a Netlify
// Functions fact and has not applied since the engine moved to Cloud Run jobs, whose task timeout is
// an explicit deploy flag — see TASK_TIMEOUT_MS in runContinuation.ts. The margin survives on its own
// merits: a driver needs slack past its node's timeout to persist the result.)
export const STALL_MARGIN_MS = 90_000;

// The default a node gets when it declares no timeout of its own — the same resolution the runner
// applies, so the claim written to the run record describes exactly how long a live execution could
// possibly take. Every one of the 25 publishing nodes declares its own; this covers the rest.
export const DEFAULT_NODE_TIMEOUT_MS = 120_000;

export const nodeTimeoutMs = (node: WorkspaceNode): number => {
  const merged = { ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) } as Record<string, unknown>;
  const timeout = merged.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) ? timeout : DEFAULT_NODE_TIMEOUT_MS;
};

// T14.4 — a deterministic capture/clone stage is NOT a fast local computation. capture_emit_live
// probes and ingests every asset on the target site and then walks creates/reuses over the project
// MCP; on zilberman that is 100-200s of real network work. The model default would let the stall
// assessor call such a stage dead while it is still working, so the claim these stages publish gets a
// floor. A node that configures a LONGER timeout keeps it.
export const DETERMINISTIC_STAGE_MIN_TIMEOUT_MS = 300_000;
export const deterministicStageTimeoutMs = (node: WorkspaceNode): number => Math.max(nodeTimeoutMs(node), DETERMINISTIC_STAGE_MIN_TIMEOUT_MS);

// T3 — the wall-clock the engine-owned VALIDATE phase of the article_body loop can legitimately
// occupy after the model has already returned: one validator call per revalidation cycle plus the
// initial one, at the 15s per-call abort publishPayload.ts applies (OBJECT_VALIDATE_TIMEOUT_MS), plus
// one call's margin for the loop's own bookkeeping. The REVISION phase is a full second model
// dispatch and claims a model-sized window instead.
export const ARTICLE_BODY_VALIDATION_PHASE_TIMEOUT_MS = (MAX_ENGINE_REVALIDATION_CYCLES + 2) * 15_000;

// K-A9 (2026-09-16) — the route VOCABULARY (which metadata keys declare a route, how a route maps to
// an era string, and how a node's execution kind is resolved) moved to nodeExecution.ts, so the store
// can derive the stored `executionKind`/`route` fields at parse time without importing this module
// (this module reaches nodeTimings -> the repository manager -> the store). Re-exported here under
// their historical names: every existing import of these from routeRegistry.js still resolves, and
// this file remains where a reader is sent for what each route actually IS.
export { DETERMINISTIC_ROUTE_METADATA_KEYS, ROUTE_ERA_METADATA_KEYS, deriveRouteFromMetadata, deriveStoredExecutionFields, resolveNodeExecution, routeEraOf, routeFromEra } from "./nodeExecution.js";
export type { NodeExecutionKind, NodeRoute } from "./nodeExecution.js";

export const declaresDeterministicRoute = (node: WorkspaceNode): boolean =>
  resolveNodeExecution(node).executionKind === "deterministic";

// W0.1 — WHICH PROGRAM a timing sample describes, as a stable string. A nodeId is not a program:
// contract_intelligence was a model dispatch and is now a deterministic mapping, and publish_executor
// is a gate on one workflow and an execute route on another. The era string is the route's declaring
// key plus its mode when the declaration is string-valued (captureStageDeterministic:"crawl" and
// :"emit_live" are separate stages sharing a key, and separate programs). A node with no route is a
// model dispatch, which is a KNOWN era rather than an unknown one.
//
// K-A9: reads the node's resolved execution (stored field first, metadata second) rather than
// scanning metadata directly. For a row with no stored field that is the identical scan it always
// was — which is the property tests/agent/workspace/storedNodeExecution.test.ts pins across every
// canonical node.
export const resolveRouteEra = (node: WorkspaceNode): string => {
  const route = resolveNodeExecution(node).route;
  return route ? routeEraOf(route) : MODEL_ROUTE_ERA;
};

// ---------------------------------------------------------------------------------------------
// PHASE MANIFESTS
// ---------------------------------------------------------------------------------------------

// How a phase's claim window is computed. Named rather than inlined so a manifest states the INTENT
// ("this phase is a full model dispatch") instead of a number that has to be re-derived by a reader.
export type PhaseTimeoutSource =
  // A full model dispatch: the node's own configured timeout.
  | "node_timeout"
  // Deterministic route work over the project MCP: the node's timeout with the stage floor applied.
  | "deterministic_stage"
  // A fixed window this phase's own bounded work justifies.
  | { fixedMs: number };

export type RoutePhase = {
  id: string;
  description: string;
  timeout: PhaseTimeoutSource;
  // W3.1 — the tenant verbs THIS phase calls, where a route's stages differ. capture and clone are
  // one stage per dispatch and the stages are not alike: clone_intake reads, theme_bind applies a
  // site-wide theme. Attributing the whole route's verb set to every stage would report clone_intake
  // as reaching an admin verb it never touches, which is precisely the kind of "close enough" claim
  // an audit exists to stop making.
  requiredTools?: RouteRequiredTool[];
  // Set where this phase DOES reach the tenant but its verbs could not be attributed from source with
  // confidence. Stated rather than guessed: an empty list here would read as "makes no tenant calls",
  // which for capture_emit_live is false — it creates objects and ingests every asset on the site.
  requiredToolsUnverified?: true;
};

// W3.1 — the TENANT VERBS a route calls on the project MCP while it runs.
//
// These are not registry tools and they are not node grants. A deterministic route reaches the tenant
// through ProjectMcpAdapter directly: no node grant is consulted, no risk level is checked, and
// nothing lands in the tool execution ledger. `tool.list_executions` structurally cannot show a
// publish, a release, a crawl, a mint or a theme apply, because none of them goes through the tool
// executor at all. Declaring them here is the first half of closing that: it makes the set knowable,
// and it is what an operator's "which nodes need this verb" question is answered from.
//
// Declaring is NOT enforcing. Nothing in this wave routes a call differently or blocks one; the
// choke point that makes every tenant call pass one gate and land in one ledger is the next wave.
export type RouteRequiredTool = {
  verb: string;
  // The risk the verb carries on the tenant, in the registry's own vocabulary. `publish` and `admin`
  // are the two that a node's own riskLevel is supposed to gate — and today does not, on this path.
  risk: "read" | "write" | "publish" | "admin";
  description: string;
};

export type RouteManifest = {
  id: string;
  description: string;
  phases: RoutePhase[];
  // W3.1 — HOW THIS ROUTE'S PHASES RELATE, which two different readers need to know:
  //   "sequential" — the phases run one after another INSIDE one dispatch (article_body's
  //     model -> validate -> revision). This is the shape a single stamped claim misdescribes, so
  //     these are the routes the W1 stall invariant walks.
  //   "alternative" — the phases are mutually exclusive: the conductor dispatches the node once per
  //     stage and the node IS one of them (capture and clone). Their claims were never at risk from
  //     phase drift, and walking them as a sequence would model a dispatch that never happens.
  // Defaults to "sequential" when omitted, because that is the shape that needs the guarantee.
  phaseKind?: "sequential" | "alternative";
  // Absent means "this route makes no tenant calls", not "unknown".
  requiredTools?: RouteRequiredTool[];
};

// What a route module is handed so it can move its own claim forward at a phase boundary. Deliberately
// this small: a route names the phase it is entering and knows nothing about claims, run records or
// saves — the executor owns all three. Always safe to call and always safe NOT to call; a route that
// never calls it behaves exactly as it did before phases existed.
export type PhaseClaim = (phaseId: string) => Promise<void>;

export const resolvePhaseTimeoutMs = (timeout: PhaseTimeoutSource, node: WorkspaceNode): number => {
  if (typeof timeout === "object") return timeout.fixedMs;
  return timeout === "node_timeout" ? nodeTimeoutMs(node) : deterministicStageTimeoutMs(node);
};

// Route ids are the engine's own names for these programs. They are NOT node ids: publish_executor
// and release_executor are shared by four workflows, and a capture stage is one route with several
// stage values.
export const ROUTE_MANIFESTS: readonly RouteManifest[] = [
  {
    id: "article_body",
    description: "The engine-owned validate -> revise -> revalidate loop that runs after article_body's model dispatch returns. The route the stall incident was diagnosed on.",
    phases: [
      { id: "model", description: "The node's own agent loop.", timeout: "node_timeout" },
      // Deliberately NARROWER than the model window, and that is the point of per-phase claims: the
      // validate phase can only make bounded validator calls, so a driver that dies here is reclaimed
      // in ~150s instead of being hidden for the eleven minutes one worst-case claim would cost.
      { id: "validate", description: "Up to MAX_ENGINE_REVALIDATION_CYCLES + 1 client validator calls at the 15s per-call abort.", timeout: { fixedMs: ARTICLE_BODY_VALIDATION_PHASE_TIMEOUT_MS } },
      { id: "revision", description: "One bounded revision turn — a FULL second model dispatch, so a model-sized window.", timeout: "node_timeout" }
    ]
  },
  // capture and clone are ONE STAGE PER DISPATCH — the conductor re-dispatches the node for the next
  // stage rather than walking the stages inside one claim — so their phase is the stage itself and the
  // phase ids are the stage values. Re-stamping at the stage boundary is still worth doing: it starts
  // the claim clock AFTER the run-facts resolution and dependency-envelope reads that precede the
  // tenant call, and it puts the stage's name on the run record (`claim_phase_restamped:
  // capture_stage:emit_live`) so a stall can be attributed to a stage without opening the node.
  //
  // NOT CLAIMED HERE, and named so it is not mistaken for done: capture_emit_live's internal
  // probe -> ingest -> create walk is genuinely several waits inside one step call, and would need a
  // phase claim threaded into captureEmitLiveStep itself to be covered at that grain. On zilberman
  // it grew to ~330-350 sequential round-trips (295 create_artifact_from_url calls alone) and
  // stopped fitting this window at all — every dispatch was reclaimed as stale_dispatch_reclaimed
  // and restarted the whole emission from zero, forever. A phase claim alone would not have fixed
  // that (the work still would not finish in one dispatch); what actually fixed it is RESUMPTION,
  // not a wider or finer-grained claim: materializeMedia now enforces its own soft budget
  // (emit.mjs's MEDIA_MATERIALIZE_BUDGET_MS, comfortably under this window) and stops cleanly with
  // a manifestRef -> artifactRef ledger when assets remain, which captureConductorRoutes.ts persists
  // under CAPTURE_EMIT_LIVE_LEDGER_STAGE_KEY and re-queues the node with — the same pattern
  // CAPTURE_CRAWL_JOB_STAGE_KEY already uses for capture_crawl. The next dispatch skips every asset
  // already in the ledger, so a media-heavy site converges over several dispatches instead of
  // looping. A stage whose non-media work alone cannot fit this window is still the case a phase
  // claim would be needed for; none has been measured yet.
  {
    id: "capture_stage",
    description: "capture_conductor's deterministic stages. One stage per dispatch, so the phase IS the stage and the phase ids are the stage values.",
    phaseKind: "alternative",
    phases: [
      { id: "crawl", description: "Create or poll the pdf-tool crawl job.", timeout: "deterministic_stage", requiredTools: [
        { verb: "create_capture_job", risk: "write", description: "The crawl job itself." },
        { verb: "get_capture_job_status", risk: "read", description: "Polled once per dispatch." },
        { verb: "get_capture_snapshot", risk: "read", description: "The crawl's result." }
      ] },
      { id: "map", description: "Build the block mapping from the snapshot. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "map_refine", description: "Re-map with block_classifier's suggestions. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "theme", description: "Derive the theme from the snapshot. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "emit_dry", description: "Plan the emission without touching the tenant.", timeout: "deterministic_stage", requiredTools: [] },
      // W3.2.0 — ATTRIBUTED FROM SOURCE, no longer unverified. The stage is captureEmitStep(live:true)
      // (captureEngine.ts) and nothing else; every tenant call it makes goes through the ONE transport
      // it builds (buildAdapterTransport -> callProjectTool -> ProjectMcpAdapter.callTool), and the
      // vendored emitter behind it (capture/engine/emit.mjs) names its verb at every one of its
      // fourteen `transport.call(...)` sites as a string LITERAL — nine distinct verbs, no dynamic
      // dispatch, so this list is exhaustive rather than representative. The asset "probe" in this
      // stage's description is an HTTP HEAD/GET against the source site (createAssetProbe), not a
      // tenant verb; the tenant-side half of media is create_artifact_from_url.
      //
      // emit_dry above stays [] and that is checked, not assumed: buildEmissionPlan is synchronous and
      // is handed no transport at all (captureEngine.ts returns the dry-run report before
      // executeEmission is reached).
      { id: "emit_live", description: "Probe and ingest every asset on the target site, then walk creates/reuses over the project MCP — the long tail of this route.", timeout: "deterministic_stage", requiredTools: [
        { verb: "object_inventory", risk: "read", description: "Derive the target site binding and the reuse-first inventories." },
        { verb: "object_contract", risk: "read", description: "The target's own contract per required object type, validate-before-create." },
        { verb: "object_get", risk: "read", description: "Route-collision probing and reuse of an existing object." },
        { verb: "object_validate", risk: "read", description: "Validate each candidate body before and after it is written." },
        { verb: "object_create", risk: "write", description: "Mint the emitted drafts (never published — forbidden verbs are refused pre-transport)." },
        { verb: "object_checkout", risk: "write", description: "Lock an existing object before reusing it." },
        { verb: "object_patch", risk: "write", description: "Apply the reuse patch." },
        { verb: "object_checkin", risk: "write", description: "Release the reuse lock." },
        { verb: "create_artifact_from_url", risk: "write", description: "Ingest one source asset into the target's artifact store." }
      ] },
      // W2.1/G6-T2 — still no TENANT verb (hence []), but no longer purely local: the stage now
      // dispatches the platform repo's capture-preview workflow and polls it across advances, the
      // same pending-and-re-queue shape `crawl` uses for a pdf-tool job. The outbound calls are
      // GitHub's own API with cms-agent's CAPTURE_PREVIEW_GITHUB_TOKEN — not the project MCP — so
      // they are outside this manifest's vocabulary, which names tenant verbs only.
      { id: "score", description: "Score the emission. Local rubric + gap report; the visual half is dispatched to the platform capture-preview CI job and collected across advances.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "report", description: "Summarize the run. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      // The shared publishing tail's payload builder, retagged onto this route the same way
      // clone_conductor retags its own copy. Local computation; see the clone_stage twin below.
      { id: "publish_payload", description: "Assemble the deterministic object publish plan from the capture stages' reports. Local computation.", timeout: "deterministic_stage", requiredTools: [] }
    ]
  },
  {
    id: "clone_stage",
    description: "clone_conductor's deterministic stages. No external job plane, so no polling phase. One stage per dispatch; the phase ids are the stage values.",
    phaseKind: "alternative",
    phases: [
      { id: "intake", description: "Read the source structure and the target's inventory.", timeout: "deterministic_stage", requiredTools: [
        { verb: "object_get", risk: "read", description: "Read the source objects." },
        { verb: "object_inventory", risk: "read", description: "What the target already holds." },
        { verb: "registry_get", risk: "read", description: "Block/type registry." }
      ] },
      { id: "mint", description: "Create the cloned structure on the target.", timeout: "deterministic_stage", requiredTools: [
        { verb: "object_create", risk: "write", description: "Mint the cloned objects and imagery drafts." },
        { verb: "object_checkout", risk: "write", description: "Lock before writing." }
      ] },
      { id: "theme_bind", description: "Apply the derived theme to the target SITE — the one admin-risk verb on this route.", timeout: "deterministic_stage", requiredTools: [
        { verb: "object_get", risk: "read", description: "Read the theme's object." },
        { verb: "object_checkout", risk: "write", description: "Lock before writing." },
        { verb: "object_checkin", risk: "write", description: "Release the lock." },
        { verb: "site_apply_theme", risk: "admin", description: "Applies a theme site-wide." }
      ] },
      { id: "restamp", description: "Re-stamp layouts on the cloned objects.", timeout: "deterministic_stage", requiredTools: [
        { verb: "object_get", risk: "read", description: "Read what is being restamped." },
        { verb: "object_checkout", risk: "write", description: "Lock before patching." },
        { verb: "object_patch", risk: "write", description: "Apply the restamp." },
        { verb: "object_checkin", risk: "write", description: "Release the lock." }
      ] },
      // W3.2.0 — the pdf-template branch, attributed from source (capture/pdfTemplateEngine.ts). These
      // verbs are pdf-tool's OWN template store, reached over the same project MCP: create/validate/
      // publish_pdf_template never touch a CMS objectId and never pass through object_publish, which is
      // exactly why pdf_publish is a separate route stage from the shared publishing tail.
      //
      // pdf_intake really does call nothing: pdfTemplateIntakeStep is synchronous, takes no deps, and
      // reads the brief out of run.initialInput. [] here is a verified assertion, not a default.
      { id: "pdf_intake", description: "Read the PDF template brief from the run's own input. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "pdf_mint", description: "Create the PDF template, then validate it and poll the validation report.", timeout: "deterministic_stage", requiredTools: [
        { verb: "create_pdf_template", risk: "write", description: "Mint the draft template in pdf-tool's template store." },
        { verb: "validate_pdf_template", risk: "write", description: "Start a validation run against the brief's worst-case sample data (every renderer except pdfme)." },
        { verb: "get_pdf_template_validation", risk: "read", description: "Bounded deterministic poll of that validation report." }
      ] },
      { id: "pdf_publish", description: "Publish the PDF template.", timeout: "deterministic_stage", requiredTools: [
        { verb: "publish_pdf_template", risk: "publish", description: "Goes live in pdf-tool's template store. Gated by the executor's generic publish-risk gate on the node's own riskLevel, and by the project's publishEnabled kill switch." }
      ] },
      // A7 (Stage A task list) — the PDF template STUDIO's own five phases, additive to the four
      // pdf-tool phases above (pdf_intake/pdf_mint/pdf_publish/report), which clone_conductor's own
      // PDF branch keeps using unchanged. See pdfTemplateFamilyEngine.ts / pdfTemplateStudioNodes.ts
      // for what each stage does.
      { id: "pdf_family_plan", description: "Expand a family brief into variants and decide reuse/revision per variant. Reads the cross-tenant TemplateLibraryStore (an internal, blob-backed store, not a project MCP verb) and the run's own initialInput; no tenant call.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "pdf_mint_validated", description: "Contract-validate pdf_template_designer's proposed renderer payloads locally, then create+validate the survivors exactly as pdf_mint above.", timeout: "deterministic_stage", requiredTools: [
        { verb: "create_pdf_template", risk: "write", description: "Mint the draft template in pdf-tool's template store." },
        { verb: "validate_pdf_template", risk: "write", description: "Start a validation run against the brief's worst-case sample data (every renderer except pdfme)." },
        { verb: "get_pdf_template_validation", risk: "read", description: "Bounded deterministic poll of that validation report." }
      ] },
      { id: "pdf_publish_only", description: "STEP A of the studio's two-step publication: publish_pdf_template only, never the library deposit.", timeout: "deterministic_stage", requiredTools: [
        { verb: "publish_pdf_template", risk: "publish", description: "Goes live in pdf-tool's template store. Gated by the executor's generic publish-risk gate on the node's own riskLevel, and by the project's publishEnabled kill switch." }
      ] },
      { id: "pdf_library_deposit", description: "STEP B of the studio's two-step publication, and its own separate node: deposits each published template into the cross-tenant TemplateLibraryStore (#207) — an internal, blob-backed store, not a project MCP verb; no tenant call.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "pdf_family_report", description: "Assemble the family's terminal per-variant ledger (reused/published/contract_rejected/mint_rejected/publish_failed/library_export_refused/family_plan_rejected) and the two-step publication summary. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      // A9 (Stage A task list) — the image-on-every-page batch operation's own four phases. See
      // imageTemplateRevisionEngine.ts / imageTemplateRevisionNodes.ts for what each stage does.
      { id: "image_revision_intake", description: "Resolve the source image once, then fetch every target template's current version from the cross-tenant TemplateLibraryStore (an internal, blob-backed store, not a project MCP verb) and an injectable asset-catalog provider; no pdf-tool call.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "image_revision_compile_preview", description: "Compile the recurring-header image edit (local computation) and render a before/after preview via an injectable provider; no pdf-tool call from this stage itself.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "image_revision_apply", description: "For previewed-and-approved items: mint + validate + publish the next template version exactly as pdf_mint_validated/pdf_publish_only do, then verify image presence via an injectable provider.", timeout: "deterministic_stage", requiredTools: [
        { verb: "create_pdf_template", risk: "write", description: "Mint the next version's draft in pdf-tool's template store." },
        { verb: "publish_pdf_template", risk: "publish", description: "Goes live in pdf-tool's template store. Gated by the executor's generic publish-risk gate on the node's own riskLevel, and by the project's publishEnabled kill switch." }
      ] },
      { id: "image_revision_report", description: "Assemble the terminal per-item ledger (one outcome per templateRef, partial/allFailed computed from it). Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      // A5 (Milestone A remainder) — asset_lookup_studio's two stages, attributed from source
      // (capture/assetLookupEngine.ts). assetLookupSearchStep names search_artifacts and
      // get_artifact_metadata; assetLookupAdoptStep names object_checkout, object_patch and
      // object_checkin. Both are string LITERALS at the callProjectTool site, no dynamic dispatch.
      { id: "asset_lookup_search", description: "Search the tenant's artifact store for a candidate and read its metadata. Reads only.", timeout: "deterministic_stage", requiredTools: [
        { verb: "search_artifacts", risk: "read", description: "Find candidate artifacts by tag." },
        { verb: "get_artifact_metadata", risk: "read", description: "Read the chosen candidate's stored metadata." }
      ] },
      { id: "asset_lookup_adopt", description: "Adopt the chosen artifact onto the target object under a lock.", timeout: "deterministic_stage", requiredTools: [
        { verb: "object_checkout", risk: "write", description: "Lock the adopting object before patching." },
        { verb: "object_patch", risk: "write", description: "Write the adopted artifact reference onto it." },
        { verb: "object_checkin", risk: "write", description: "Release the lock." }
      ] },
      // A8 (gap-1 close) — document_render_studio's two stages, attributed from source
      // (capture/documentRenderEngine.ts). documentRenderExecuteStep names document_render and
      // nothing else; buildDocumentRenderReportStep is SYNCHRONOUS and is handed no deps at all, so
      // its [] is a verified assertion rather than a default.
      { id: "document_render_execute", description: "Render the owning object's document through the tenant's own render verb.", timeout: "deterministic_stage", requiredTools: [
        { verb: "document_render", risk: "write", description: "Renders the document and attaches it as an artifact under this request; publishes nothing." }
      ] },
      { id: "document_render_report", description: "Assemble the render's terminal ledger from the execute envelope. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      // T5 (2026-09-16 annotate-bridge plan) — image_annotation_studio's three stages, attributed
      // from source (capture/imageAnnotationEngine.ts): imageAnnotationAnalyzeStep names
      // analyze_image_layout, imageAnnotationDrawStep names annotate_image, imageAnnotationVerifyStep
      // names check_image_text. One verb per stage, each a string literal at its callProjectTool site.
      //
      // THIS BLOCK IS THE ONE THAT PAID FOR THE PHASE-PARITY GUARD BELOW. image_annotation shipped
      // live-verified (#368/#377) with no manifest phases, so `annotate_image` appeared in no route
      // manifest, so `declaredRouteVerbs()` never named it, so the derived genesis profile never
      // granted it — and every tenant carrying `defaultToolPolicy: "blocked"` reported
      // `image_annotate: not_configured` while dr-lurie and platform (`defaultToolPolicy: "allowed"`)
      // reported nothing at all. The derivation worked exactly as designed; what it derived FROM was
      // incomplete, which is the failure the v4 header claimed to have ended and had not.
      { id: "image_annotation_analyze", description: "Read the base image's 6x6 luminance/busyness grid and choose a placement per annotation. Writes nothing.", timeout: "deterministic_stage", requiredTools: [
        { verb: "analyze_image_layout", risk: "read", description: "Reads the grid and ranked safe zones; persists nothing." }
      ] },
      { id: "image_annotation_draw", description: "Draw the chosen placements over the base image, saving the result as a NEW image artifact.", timeout: "deterministic_stage", requiredTools: [
        { verb: "annotate_image", risk: "write", description: "Writes a NEW image artifact on the tenant's artifact plane; the base image is never modified and nothing is published." }
      ] },
      { id: "image_annotation_verify", description: "Read the drawn strings back out of the annotated image — the operation's own completion evidence.", timeout: "deterministic_stage", requiredTools: [
        { verb: "check_image_text", risk: "read", description: "OCR read-back of the drawn strings; persists nothing and gates nothing." }
      ] },
      // The shared publishing tail's payload builder, retagged onto this route by
      // cloneConductorNodes.ts. It reads prior stage envelopes and the project record's own
      // publish-enabled kill switch, then assembles the plan locally — cloneConductorRoutes.ts's
      // `publish_payload` case makes no callProjectTool at all, so [] is verified, not assumed.
      { id: "publish_payload", description: "Assemble the deterministic object publish plan from the earlier stages' reports. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "report", description: "Summarize the clone. Local computation.", timeout: "deterministic_stage", requiredTools: [] }
    ]
  },
  {
    id: "artifact_materializer",
    description: "Per slot, per dispatch: adopt an in-flight job, else create one, then poll it once. Bounded per slot — but a multi-slot spec walks that sequence several times inside ONE dispatch, which is the same shape article_body had.",
    phases: [
      { id: "plan", description: "Read the spec and reconcile stored slot state.", timeout: "deterministic_stage" },
      { id: "slot", description: "One slot's adopt/create/poll cycle. Re-stamped per slot, so a ten-slot spec is ten windows rather than one.", timeout: "deterministic_stage" }
    ],
    requiredTools: [
      { verb: "get_agent_artifact_by_slot", risk: "read", description: "Adopt an artifact a previous run already made." },
      { verb: "create_agent_artifact_job", risk: "write", description: "Generate one when adoption found nothing." },
      { verb: "get_agent_artifact_job_status", risk: "read", description: "Polled once per dispatch per slot." }
    ]
  },
  {
    id: "visual_standard_materializer",
    description: "visual_identity's second node: six tenant verbs including site_apply_brand_imagery.",
    phases: [
      { id: "materialize", description: "The tenant-side application of the visual standard.", timeout: "deterministic_stage" }
    ],
    // THE SHARPEST CASE IN THE AUDIT. This node is riskLevel `admin`, carries allowedTools: [], and
    // reaches the tenant six times anyway — including site_apply_brand_imagery, which restyles the
    // whole site. Its grant list says it can do nothing; the engine does all of it.
    requiredTools: [
      { verb: "object_create", risk: "write", description: "Create the standard's object." },
      { verb: "object_checkout", risk: "write", description: "Lock before patching." },
      { verb: "object_patch", risk: "write", description: "Write the standard." },
      { verb: "object_checkin", risk: "write", description: "Release the lock." },
      { verb: "object_get", risk: "read", description: "Read the current standard." },
      { verb: "site_apply_brand_imagery", risk: "admin", description: "Applies imagery site-wide." }
    ]
  },
  {
    id: "release_executor",
    description: "release_to_production followed by deploy_status polling, in one dispatch. The call and the poll are separate waits and get separate windows.",
    phases: [
      { id: "release", description: "The release_to_production call itself, under its idempotency key.", timeout: "deterministic_stage" },
      { id: "poll", description: "deploy_status polling by commit after the call.", timeout: "deterministic_stage" }
    ],
    requiredTools: [
      { verb: "release_to_production", risk: "publish", description: "Goes live. In engine code only release_executor calls it (AGENTS.md invariant 4)." },
      { verb: "deploy_status", risk: "read", description: "Polled by commit to confirm the build landed." }
    ]
  }
] as const;

// W3.1 — HOW A NODE RUNS, as one word.
//
// The engine already answers this, but only by asking `declaresDeterministicRoute` at four separate
// points in the dispatch block. Naming it makes the question askable from outside the executor —
// which is what an audit, a validator and (next wave) a choke point all need.
export const resolveExecutionKind = (node: WorkspaceNode): NodeExecutionKind => resolveNodeExecution(node).executionKind;

// Which manifest a node's route belongs to. Returns undefined for a model dispatch, and for a
// deterministic node whose route has no manifest yet — the two are distinguished by executionKind.
export const resolveRouteId = (node: WorkspaceNode): string | undefined => {
  const route = resolveNodeExecution(node).route;
  if (!route) return undefined;
  const key = route.id;
  const byKey: Record<string, string> = {
    captureStageDeterministic: "capture_stage",
    cloneStageDeterministic: "clone_stage",
    artifactMaterializerDeterministic: "artifact_materializer",
    visualStandardMaterializerDeterministic: "visual_standard_materializer",
    releaseExecutorDeterministic: "release_executor"
  };
  return byKey[key];
};

const MANIFEST_BY_ID = new Map(ROUTE_MANIFESTS.map((manifest) => [manifest.id, manifest]));

export const routeManifest = (routeId: string): RouteManifest | undefined => MANIFEST_BY_ID.get(routeId);

// The phase's window, or — when a route re-stamps for a phase its manifest does not declare — the
// route's FIRST phase, which is the fail-open direction: an unknown phase gets the widest window the
// route legitimately uses rather than a narrow one that could reclaim live work. A route id that is
// not in the registry at all resolves to undefined and the caller leaves the existing claim alone.
export const phaseTimeoutMsFor = (routeId: string, phaseId: string, node: WorkspaceNode): number | undefined => {
  const manifest = MANIFEST_BY_ID.get(routeId);
  if (!manifest) return undefined;
  const phase = manifest.phases.find((candidate) => candidate.id === phaseId) ?? manifest.phases[0];
  return phase ? resolvePhaseTimeoutMs(phase.timeout, node) : undefined;
};

// W3.1 — the tenant verbs a NODE reaches, which for a staged route is its stage's verbs and not the
// whole route's. Returns undefined when the route declares them per phase and this node's phase is
// marked unverified — "we did not establish this" and "this makes no tenant calls" must not read the
// same, which is the whole point of requiredToolsUnverified.
export const routeRequiredToolsFor = (routeId: string, phaseId?: string): RouteRequiredTool[] | undefined => {
  const manifest = MANIFEST_BY_ID.get(routeId);
  if (!manifest) return undefined;
  const phase = phaseId ? manifest.phases.find((candidate) => candidate.id === phaseId) : undefined;
  if (phase) {
    if (phase.requiredToolsUnverified) return undefined;
    if (phase.requiredTools) return [...phase.requiredTools];
  }
  // A route whose phases do not declare their own (artifact_materializer, release_executor,
  // visual_standard_materializer) calls the same verbs whichever phase it is in.
  return manifest.requiredTools ? [...manifest.requiredTools] : [];
};

// Routes whose phases run SEQUENTIALLY inside one dispatch — the ones a single stamped claim can
// misdescribe. Used by the W1 invariant test, which walks every manifest rather than a hand-kept
// list. A route whose phases are alternatives (one stage per dispatch) is excluded: its claim covers
// exactly the one phase that runs, so there is nothing for a sequence walk to prove.
export const multiPhaseRouteIds = (): string[] => ROUTE_MANIFESTS
  .filter((manifest) => (manifest.phaseKind ?? "sequential") === "sequential" && manifest.phases.length > 1)
  .map((manifest) => manifest.id);

// TENANT ROUTE PARITY (2026-09-16) — every tenant MCP verb any deterministic route can speak, derived
// from the manifests rather than hand-kept. Moved here from genesisParity.ts so the tenant policy
// modules can read it without importing the parity checker (a cycle: parity reads the profile).
//
// This is the list a tenant must be able to speak to run the fleet's workflows at all, and the reason
// it is DERIVED: a route that starts speaking a new verb grants it on every tenant at the next deploy
// instead of stalling one tenant at a time, months apart, with an ok:true on every config write in
// between.
export const declaredRouteVerbs = (): string[] =>
  [
    ...new Set(
      ROUTE_MANIFESTS.flatMap((manifest) => [
        ...(manifest.requiredTools ?? []).map((tool) => tool.verb),
        ...manifest.phases.flatMap((phase) => (phase.requiredTools ?? []).map((tool) => tool.verb))
      ])
    )
  ].sort();

// ROUTE MANIFEST PHASE PARITY (2026-09-17) — the guard that makes `declaredRouteVerbs()` honest.
//
// THE DEFECT THIS EXISTS FOR, in one sentence: a new deterministic STAGE can ship without a manifest
// PHASE, and when it does it contributes zero verbs to the derived tenant policy — silently, with
// `ok:true` on every config write, exactly like the hand-kept list the derivation replaced.
//
// image_annotation is the instance that paid for it. Its three stages shipped live-verified with no
// phases here, so `annotate_image` was in no manifest, so no tenant with `defaultToolPolicy:
// "blocked"` was ever granted it — while dr-lurie and platform, which allow everything by default,
// showed no symptom at all. asset_lookup and document_render had the same hole and did NOT show a
// symptom either, because their verbs happened to be granted for unrelated reasons. A gap that only
// hurts when it coincides with a blocked-by-default tenant is exactly the kind that survives months.
//
// PURE BY CONSTRUCTION: takes the nodes, returns the gaps. It does not import the workflow registry
// (which reaches the node literals, which reach this module), so the caller supplies the canonical
// nodes — `tests/agent/workspace/routeManifestPhaseParity.test.ts` feeds it every registered
// workflow's.
export type RouteManifestPhaseGap = {
  /** The manifest the stage should have appeared in, or `undefined` when the node's route key maps
   *  to no manifest at all — the two are different problems and must not read the same. */
  routeId?: string;
  /** The declaring route key plus its stage value, e.g. `cloneStageDeterministic:image_annotation_draw`. */
  route: string;
  /** The stage value that has no phase. */
  stage: string;
  nodeId: string;
};

export const routeManifestPhaseGaps = (nodes: readonly WorkspaceNode[]): RouteManifestPhaseGap[] => {
  const gaps: RouteManifestPhaseGap[] = [];
  for (const node of nodes) {
    const execution = resolveNodeExecution(node);
    // A boolean-valued route declares no stage, so there is no per-stage phase to demand.
    if (execution.executionKind !== "deterministic" || !execution.route?.mode) continue;
    const stage = execution.route.mode;
    const route = `${execution.route.id}:${stage}`;
    const routeId = resolveRouteId(node);
    if (!routeId) {
      gaps.push({ route, stage, nodeId: node.id });
      continue;
    }
    if (!MANIFEST_BY_ID.get(routeId)?.phases.some((phase) => phase.id === stage)) {
      gaps.push({ routeId, route, stage, nodeId: node.id });
    }
  }
  return gaps;
};
