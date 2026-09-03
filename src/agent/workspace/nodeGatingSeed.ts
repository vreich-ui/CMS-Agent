// W4 / W6.3 (determinism program, 2026-08-12) — THE GATING POLICY SEED.
//
// WHAT THIS IS. The conductor's node-gating policy, as data, in one file: which nodes carry a
// `skipWhen` predicate (skipPredicates.ts evaluates them) and which nodes declare the contract
// prefetch. It is the CODE SEED for that policy — the same role nodes.ts plays for prompts and
// schemas, kept separate for two reasons that both matter more than tidiness:
//
//   1. It is READABLE. nodes.ts is 155KB of prompts; a policy buried in it is a policy nobody
//      reviews. The whole gating decision surface — six nodes, four rules — fits on one screen here,
//      next to the reasoning for each entry.
//   2. It is OVERRIDABLE FROM THE STORE, immediately. These entries are DEFAULTS: they apply only
//      where the node's own metadata does not already declare the key. The live workspace is
//      store-sourced, so an operator who wants a policy off sets `skipWhen: []` on that node in the
//      store and it is off on the next dispatch — no deploy, no re-seed. A store row always wins.
//
// THE ONE OPERATIONAL DIFFERENCE, STATED PLAINLY: because this is code rather than seeded node
// metadata, the policy takes effect when the branch DEPLOYS, not at the next deliberate re-seed. That
// is a real change in when gating starts, so it is written here rather than discovered later. It is
// safe in the direction that matters: every predicate fails toward RUNNING (skipPredicates.ts rule
// 3), so a run that declares nothing behaves exactly as it did before — no reviewer is dropped, no
// research is skipped. Only a run whose own facts positively say a node has nothing to do is gated.
//
// MIGRATION. When a re-seed wave writes these predicates onto the live node rows (see
// docs/plan/WORK-ORDER-2026-08-12-determinism.md), the store values take precedence automatically and
// this table becomes the fallback for a store that has not been seeded yet. Nothing needs deleting.
import type { WorkspaceNode } from "./nodeTypes.js";
import type { SkipPredicate } from "./skipPredicates.js";

export type NodeGatingSeedEntry = {
  skipWhen?: SkipPredicate[];
  contractPrefetch?: true;
  // The editorial-voice prefetch (voicePrefetch.ts) — voice_<project> fetched deterministically before
  // the agent loop. Declared here so a store overlay that rewrites the node's metadata (say, to flip
  // approvalRequired) cannot silently switch the voice off; the seed is the floor.
  voicePrefetch?: true;
  // C5 (BRIEF §3.5): the site-level prefetch (sitePrefetch.ts) — the site's visual standards, its PDF
  // templates and its image-model policy contexts, fetched deterministically before the agent loop and
  // merged into the node's `prefetchedContract`. Declared here for the same reason voicePrefetch is:
  // a store overlay that rewrites a node's metadata wholesale must not be able to switch it off by
  // omission. The seed is the floor.
  sitePrefetch?: true;
  // Why this node carries this policy. Kept in the data, not in a comment, so it travels into the
  // audit record and into anything that renders the policy.
  rationale: string;
};

// The docs/runbook vocabulary the EV-floor exemption also covers. Deliberately the same list the
// review tiering treats as docs class (skipPredicates.DOCS_CONTENT_CLASSES) plus own_property, which
// is the class the standing waiver names.
const EV_EXEMPT_CONTENT_CLASSES = ["own_property", "docs", "doc", "documentation", "runbook", "reference", "internal_docs", "changelog", "release_notes"];

export const NODE_GATING_SEED: Record<string, NodeGatingSeedEntry> = {
  // Live evidence (run_1786468126136_ev9goe): zero web calls, output said browsing was not needed,
  // $0.06 to conclude there was nothing to conclude.
  research: {
    skipWhen: [{ when: "no_external_claims" }],
    rationale: "research is dispatched only when something in the run indicates an external claim to verify. Explicit declaration first; docs/runbook content class as the documented fallback; an unclassified run still researches."
  },
  // The standing own-property EV/aggression waiver (publicationController's
  // own_property_ev_and_aggression_exemption) already decides the answer for these classes, so paying
  // a model to compute an EV floor that could not block anything is paying for a discarded number.
  monetization_strategy: {
    skipWhen: [{
      when: "content_class_in",
      classes: EV_EXEMPT_CONTENT_CLASSES,
      reason: "monetization_strategy skipped: this run's content class is exempt from the EV floor by the standing own-property/docs ruling, so the EV floor it would compute could not block anything."
    }],
    rationale: "Keyed on the SAME declared content-class signal the waiver itself reads (readDeclaredContentClass) — not a second, monetization-specific signal that could disagree with it."
  },
  // This node's own output states its zero-media rule as an if-statement. The rule is now evaluated
  // BEFORE the dispatch instead of by it.
  artifact_plan: {
    skipWhen: [{ when: "no_media_slots" }],
    rationale: "artifact_plan is dispatched only when there is an artifact to plan: an explicit media declaration, or a client object that actually carries a media reference. An unscannable body or a mock placeholder is never evidence of absence."
  },
  // W8 — the materializer carries the SAME predicate, for the same reason and off the same signal. It is
  // free (no model turn), so skipping it saves no money; what it saves is a node that would dispatch,
  // find an empty spec and complete with an empty plan, and a `publishRequestId` mint path that keys on
  // artifact_plan skipping. Both nodes skipping together keeps the zero-media run's shape as it was.
  artifact_materializer: {
    skipWhen: [{ when: "no_media_slots" }],
    rationale: "artifact_materializer executes artifact_plan's spec; when there is no media declared there is no spec, and the node it would execute for was itself skipped."
  },
  // REVIEW QUARTET TIERING — operator policy, Wolf 2026-08-12. The tier table lives in
  // skipPredicates.ts; these three entries only ask whether the node is in the selected tier.
  // trust_factual deliberately has NO entry: it is the one reviewer every tier runs.
  human_texture: { skipWhen: [{ when: "review_tier_excludes" }], rationale: "Runs for standard editorial and money class; docs/runbook class runs trust_factual only." },
  emotional_resonance: { skipWhen: [{ when: "review_tier_excludes" }], rationale: "Runs for MONEY class only: the dial that matters least when nothing is being sold." },
  reader_simulation: { skipWhen: [{ when: "review_tier_excludes" }], rationale: "Runs for standard editorial and money class; docs/runbook class runs trust_factual only." },
  // W6.3's topology half. The client ceiling used to reach the run only at contract_intelligence,
  // which runs AFTER this node — so article_brief.v1's required `resolved` vector was authored with no
  // ceiling in existence anywhere in the run, shipped unclamped, and the aggression_ceiling blocker
  // surfaced after the draft had been written against it. Declaring the prefetch here makes the
  // ceiling a fact of the dispatch that WRITES the brief: the executor fetches and reduces the
  // contract before the node's agent loop starts (run-scoped cache, so contract_intelligence's own
  // prefetch later in the run is free) and resolves min(ceiling, target) against placement_resolver's
  // target, which is already a declared dependency of brief_architect. No DAG edge is moved: see the
  // work order's re-seed section for what a full contract_intelligence reorder would additionally
  // require (publishingTail.ts declares the tail's edges as a hard invariant).
  brief_architect: { contractPrefetch: true, voicePrefetch: true, rationale: "The aggression ceiling must exist before the brief that spends it is written; the client's editorial voice must be in hand for the same reason — the brief sets the tone guardrails every downstream writer reads." },
  // FINDING-C (C3, resolving C5's finding C) — contract_intelligence DOES declare the site prefetch,
  // and this is the line C5 left for whoever owns the publishing run's cost budget.
  //
  // WHY IT HAD TO BE THIS NODE. `artifact_plan`'s prompt reads the three site facts off
  // contract_intelligence's INPUTS-as-carried, and `artifact_materializer`'s deterministic engine
  // reads them off contract_intelligence's OUTPUT (artifactMaterialization.ts's readPdfTemplates /
  // readImagePolicyContexts both index `run.stageOutputs.contract_intelligence`). BRIEF §3.7 says the
  // same thing normatively: "Carried by contract_intelligence.v1 under the same names." Declaring the
  // prefetch on the CONSUMING nodes instead would have put the facts in artifact_plan's own input and
  // left the materializer's two readers — and therefore C2's deterministic PDF renderData mapping and
  // its usage-context enforcement — still reading an artifact that never carries them. One carrier,
  // the one every consumer already reads, beats two half-wired ones.
  //
  // COST, the first of C5's two stated objections. This adds getSitePrefetch's five client reads to
  // every publishing run, and `contractPrefetchIntegration.test.ts` pinned "exactly TWO remote fetches
  // per run". That test has been RE-BASELINED DELIBERATELY, not incidentally, and its assertion is now
  // the principle the number stood for rather than the number: every prefetch read happens AT MOST
  // ONCE per run, in deterministic conductor code, never inside a node's own agent loop. Two was a
  // consequence of there being two prefetches; F1's invariant was never "two", it was "not
  // five-plus-one from a naive per-node re-fetch", and the thing F1 actually cost money on was MODEL
  // TOKENS re-sent per turn (~60K/turn), which a run-scoped conductor-side read does not do. Five
  // extra JSON-RPC reads, once, outside any model loop, whose payloads are reduced to a few hundred
  // bytes before they enter a prompt, is not that failure mode.
  //
  // CONSIDERED AND REJECTED: gating this prefetch on the same `no_media_slots` signal that decides
  // whether artifact_plan runs at all, so a text-only run pays nothing. It would save five cheap reads
  // on some runs and buys a second place where "does this run have media?" is decided — one that can
  // disagree with the node that consumes the answer, and whose failure mode is silently returning to
  // exactly the inert state this change exists to end. Reliability of the facts is worth more than the
  // reads.
  //
  // PROMPT CONTRACT, the second objection, is closed in executor.ts rather than here: the site half is
  // now WITHHELD from `prefetchedContract` for a node that declares the contract prefetch and whose
  // contract prefetch failed, with its own named run-visible warning. This node's prompt sentence
  // ("if prefetchedContract is present: this is a validation and pass-through step") therefore stays
  // exactly true — `prefetchedContract` on this node still means the contract was fetched — and no
  // prompt op is needed for it.
  contract_intelligence: {
    sitePrefetch: true,
    rationale: "The site's visual standards, PDF templates and image-model policy contexts must ride the artifact every media node already reads (contract_intelligence.v1), or C1's reduced-contract fields and C2's usage-context/PDF-template policies are shape without substance on every publishing run."
  }
};

type GatedNode = Pick<WorkspaceNode, "id"> & { metadata?: Record<string, unknown> | undefined };

// The node's metadata as the conductor sees it: the node's own metadata, with any seed key it does
// NOT declare filled in. Declaring the key — including declaring it empty — always wins.
export function gatedMetadata(node: GatedNode): Record<string, unknown> | undefined {
  const seed = NODE_GATING_SEED[node.id];
  if (!seed) return node.metadata;
  const metadata = node.metadata ?? {};
  const merged: Record<string, unknown> = { ...metadata };
  if (seed.skipWhen !== undefined && !Object.prototype.hasOwnProperty.call(metadata, "skipWhen")) merged.skipWhen = seed.skipWhen;
  if (seed.contractPrefetch !== undefined && !Object.prototype.hasOwnProperty.call(metadata, "contractPrefetch")) merged.contractPrefetch = seed.contractPrefetch;
  if (seed.voicePrefetch !== undefined && !Object.prototype.hasOwnProperty.call(metadata, "voicePrefetch")) merged.voicePrefetch = seed.voicePrefetch;
  if (seed.sitePrefetch !== undefined && !Object.prototype.hasOwnProperty.call(metadata, "sitePrefetch")) merged.sitePrefetch = seed.sitePrefetch;
  return merged;
}

// The prefetch declaration, read through the same merge — so the executor asks one question in one
// place rather than checking metadata here and a seed table there.
export const declaresContractPrefetch = (node: GatedNode): boolean => gatedMetadata(node)?.contractPrefetch === true;
export const declaresVoicePrefetch = (node: GatedNode): boolean => gatedMetadata(node)?.voicePrefetch === true;
export const declaresSitePrefetch = (node: GatedNode): boolean => gatedMetadata(node)?.sitePrefetch === true;
