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

// The metadata keys that declare a node terminates in a deterministic route rather than a model
// dispatch. Order matters: a node in a COMPOSED workflow can carry more than one (the shared
// publishing tail inherits the DTC keys while also declaring its own capture/clone stage), and
// resolveRouteEra reads this list in order so such a node resolves to the SAME era on every sample
// rather than to whichever key an unordered iteration reached first.
export const DETERMINISTIC_ROUTE_METADATA_KEYS = [
  "contractIntelligenceDeterministic",
  "placementResolverDeterministic",
  "publishPayloadDeterministic",
  "publicationControllerDeterministic",
  "publishExecutorDeterministic",
  "releaseExecutorDeterministic",
  "learningRecorderDeterministic",
  // T12.9: the capture_conductor stages (captureConductorRoutes.ts). String-valued ("crawl", ...),
  // which declaresDeterministicRoute below already treats as declared.
  "captureStageDeterministic",
  // T13.1: the clone_conductor stages (cloneConductorRoutes.ts). Same string-valued declaration.
  "cloneStageDeterministic",
  // C5: visual_identity's second node (visualStandardMaterialization.ts). Boolean-valued, like
  // artifact_materializer's own route flag.
  "visualStandardMaterializerDeterministic",
  // W1.4 (2026-09-09) — artifact_materializer, which had been missing from this list since it was
  // written while every one of its siblings was in it.
  //
  // The list has exactly two consumers, and the materializer needed both:
  //   - plannedNodeTimeoutMs: it was planned at the 120s MODEL default, not the 300s deterministic
  //     stage floor its own serial dispatch already claims (executor.ts stamps
  //     deterministicStageTimeoutMs for it explicitly, so the two disagreed about the same node).
  //   - isConcurrentDispatchEligible: it was the ONE deterministic route eligible for concurrent
  //     batching, and the batch path claims once at nodeTimeoutMs with claim=false — so a batched
  //     materializer ran a whole multi-slot adopt/create/poll walk under a 120s + 90s deadline with
  //     no per-slot re-stamping, while the same node dispatched serially gets 390s PER SLOT. The
  //     tick then reclaimed a live materialization and re-dispatched it: recoverable (job ids are
  //     persisted before polling and adoption is tried first, so no duplicate tenant artifact), but
  //     it burns the node's maxPollDispatches budget and reads as a stall.
  //
  // Reachable in practice: artifact_materializer's dependencies (artifact_plan,
  // contract_intelligence, brief_architect) and review_aggregator's (the review quartet) are disjoint
  // chains, so both become runnable in the same advance and the canonical prefix takes them together.
  //
  // The cost is parallelism, not money: the materializer no longer overlaps with the review chain on
  // runs where it would have. That is the same trade every other deterministic route already makes,
  // and it is the trade the batch path's single-claim design requires — one claim stamped for four
  // nodes at once cannot be re-stamped per phase by one of them without racing its siblings.
  "artifactMaterializerDeterministic"
] as const;

export const declaresDeterministicRoute = (node: WorkspaceNode): boolean =>
  DETERMINISTIC_ROUTE_METADATA_KEYS.some((key) => {
    const declared = node.metadata?.[key];
    return declared !== undefined && declared !== false;
  });

// Attribution and dispatch ask different questions — "what program produced this sample" and "how is
// this node dispatched" — and they briefly had different answers: artifact_materializer runs a
// deterministic bridge route but was missing from the dispatch list, so its samples were filed under
// the MODEL era. That was fixed by adding it to the list above rather than by splitting the two, since
// on inspection it belonged in both. This alias exists so the distinction stays visible: if a route
// ever needs attributing without changing how it is dispatched, it goes here and not above.
export const ROUTE_ERA_METADATA_KEYS = DETERMINISTIC_ROUTE_METADATA_KEYS;

// W0.1 — WHICH PROGRAM a timing sample describes, as a stable string. A nodeId is not a program:
// contract_intelligence was a model dispatch and is now a deterministic mapping, and publish_executor
// is a gate on one workflow and an execute route on another. The era string is the declaring metadata
// key plus its value when the declaration is string-valued (captureStageDeterministic:"crawl" and
// :"emit_live" are separate stages sharing a key, and separate programs). A node declaring none is a
// model dispatch, which is a KNOWN era rather than an unknown one. Reads ROUTE_ERA_METADATA_KEYS, not
// the dispatch list — see that constant for why the two differ.
export const resolveRouteEra = (node: WorkspaceNode): string => {
  for (const key of ROUTE_ERA_METADATA_KEYS) {
    const declared = node.metadata?.[key];
    if (declared === undefined || declared === false) continue;
    return typeof declared === "string" ? `${key}:${declared}` : key;
  }
  return MODEL_ROUTE_ERA;
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
  // phase claim threaded into captureEmitLiveStep itself to be covered at that grain. It fits the
  // 300s + 90s window on the sites measured so far (100-200s on zilberman); a slower site is the case
  // that would need it.
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
      { id: "emit_live", description: "Probe and ingest every asset on the target site, then walk creates/reuses over the project MCP — the long tail of this route.", timeout: "deterministic_stage", requiredToolsUnverified: true },
      { id: "score", description: "Score the emission. Local computation.", timeout: "deterministic_stage", requiredTools: [] },
      { id: "report", description: "Summarize the run. Local computation.", timeout: "deterministic_stage", requiredTools: [] }
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
      { id: "pdf_intake", description: "Read the PDF template brief.", timeout: "deterministic_stage", requiredToolsUnverified: true },
      { id: "pdf_mint", description: "Create the PDF template.", timeout: "deterministic_stage", requiredToolsUnverified: true },
      { id: "pdf_publish", description: "Publish the PDF template.", timeout: "deterministic_stage", requiredToolsUnverified: true },
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
export type NodeExecutionKind = "model" | "deterministic";

export const resolveExecutionKind = (node: WorkspaceNode): NodeExecutionKind =>
  declaresDeterministicRoute(node) ? "deterministic" : "model";

// Which manifest a node's route belongs to. Returns undefined for a model dispatch, and for a
// deterministic node whose route has no manifest yet — the two are distinguished by executionKind.
export const resolveRouteId = (node: WorkspaceNode): string | undefined => {
  const era = resolveRouteEra(node);
  if (era === MODEL_ROUTE_ERA) return undefined;
  const key = era.split(":")[0];
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
