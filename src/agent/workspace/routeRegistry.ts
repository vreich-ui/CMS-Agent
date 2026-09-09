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
};

export type RouteManifest = {
  id: string;
  description: string;
  phases: RoutePhase[];
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
    description: "capture_conductor's deterministic stages (crawl, map, map_refine, theme, emit_live, score). Phase ids are the stage values.",
    phases: [
      { id: "stage", description: "One stage's deterministic work over the project MCP. Every stage value resolves here.", timeout: "deterministic_stage" }
    ]
  },
  {
    id: "clone_stage",
    description: "clone_conductor's deterministic stages (intake, mint, theme_bind, restamp, pdf_*). No external job plane, so no polling phase. Phase ids are the stage values.",
    phases: [
      { id: "stage", description: "One stage's deterministic work over the project MCP. Every stage value resolves here.", timeout: "deterministic_stage" }
    ]
  },
  {
    id: "artifact_materializer",
    description: "Per slot, per dispatch: adopt an in-flight job, else create one, then poll it once. Bounded per slot — but a multi-slot spec walks that sequence several times inside ONE dispatch, which is the same shape article_body had.",
    phases: [
      { id: "plan", description: "Read the spec and reconcile stored slot state.", timeout: "deterministic_stage" },
      { id: "slot", description: "One slot's adopt/create/poll cycle. Re-stamped per slot, so a ten-slot spec is ten windows rather than one.", timeout: "deterministic_stage" }
    ]
  },
  {
    id: "visual_standard_materializer",
    description: "visual_identity's second node: six tenant verbs including site_apply_brand_imagery.",
    phases: [
      { id: "materialize", description: "The tenant-side application of the visual standard.", timeout: "deterministic_stage" }
    ]
  },
  {
    id: "release_executor",
    description: "release_to_production followed by deploy_status polling, in one dispatch. The call and the poll are separate waits and get separate windows.",
    phases: [
      { id: "release", description: "The release_to_production call itself, under its idempotency key.", timeout: "deterministic_stage" },
      { id: "poll", description: "deploy_status polling by commit after the call.", timeout: "deterministic_stage" }
    ]
  }
] as const;

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

// Routes with more than one phase are the ones a single stamped claim can misdescribe. Used by the
// invariant test, which walks every manifest rather than a hand-kept list.
export const multiPhaseRouteIds = (): string[] => ROUTE_MANIFESTS.filter((manifest) => manifest.phases.length > 1).map((manifest) => manifest.id);
