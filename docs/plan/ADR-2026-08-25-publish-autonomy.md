# ADR — Policy-driven publish autonomy on the one shared publishing tail

- **Status:** ACCEPTED (2026-08-25)
- **Task:** T15.4 (#184). The T15 series' first of two full-Opus decisions.
- **Implemented by:** T15.5 (#185), T15.6 (#186), T15.7 (#187), T15.8 (platform#615), T15.9 (#188), T15.10 (#189), T15.11 (#190). T15.28 (#204) inherits its publish semantics from here.
- **Verified against:** CMS-Agent `ac194ec`, platform `e9fb790`, pdf-tool `4a96297`.

---

## 1. The problem, stated exactly

Two of this system's principles have been traded against each other, and the trade produced a fork.

**Principle A — no human gates on the content path.** Wolf, 2026-08-25: *"this is agentic CMS — human review and check and if needed edit published content, but it needs to be assumed that the human is not involved."*

**Principle B — one publish path.** `publishingTail.ts:5-11`: the tail is "~46% of run cost and 100% of publish risk," extracted as ONE shared sub-graph *before* workflow #2 existed, precisely so that "every publish-gate fix would not have to land N times forever."

Today the shared tail is **fail-closed behind a human act**. `evaluatePublishExecutionGate` (`publishExecution.ts:88-98`) requires two things: an explicit controller `decision:"go"`, and `run.operatorPublishDecision === "approved"` — a field with exactly one setter, `workflow.set_operator_publish_decision`, which is a human calling a tool. Four of five recent publishing runs sit blocked on the second condition.

T14.5 satisfied Principle A for capture by sacrificing Principle B: it built a **second publish path** at `src/agent/capture/engine/publish.mjs`. That path is fail-open, calls `release_to_production` directly in violation of Board decision B2 (`publisher.ts:19-20`), and its node is tagged `riskLevel:"write"` so that `executor.ts:491`'s publish-risk machinery — `approvalsRequired`, the attention feed, the look-ahead gate — never sees it. It is invisible to every safety mechanism the tail owns.

**Both principles are correct. The fork is the error.** Autonomy is a *policy*, not an *architecture*. This ADR makes it a policy input to the one path, and authorizes deleting the second.

### 1.1 What the side path got right, and must survive its deletion

`publish.mjs:17-24` contains the single best sentence written about this problem:

> *"THERE IS STILL A GATE, AND IT IS NOT A HUMAN ONE. An object is published when the emission's OWN validation of it passed... That is the machine checking its own work, which is the thing that makes unattended operation safe rather than merely unattended."*

That is exactly right, and T15.7 must not delete it along with the file. **Removing the human gate does not remove the engine's self-check.** The two are separate gates that have been conflated. This ADR separates them permanently (§3).

---

## 2. Decision 1 — `autonomyMode` is the one knob, and it subsumes `operatorDefault`

### 2.1 The field

```ts
// ProjectPublishingPolicy, projectTypes.ts
autonomyMode: "autonomous" | "operator-gated";   // absent ⇒ "operator-gated"
```

### 2.2 It replaces `operatorDefault`, and not merely by renaming it

`publishingPolicy.operatorDefault?: "approved" | "require_explicit"` already exists (T2, 2026-08-13, `projectTypes.ts:89`) and is already applied at run creation by `applyOperatorPublishPolicyDefault` (`executor.ts:394-399`). Shipping `autonomyMode` alongside it would leave two fields meaning one thing, which is how the fork happened the first time. `operatorDefault` is therefore **deprecated and migrated**, not kept.

But the replacement is not a rename, because `operatorDefault` implements autonomy the wrong way and that wrongness must not be inherited:

```ts
// executor.ts:394-399 — what operatorDefault does today
return { ...run, operatorPublishDecision: "approved", operatorDecisionSource: "project_policy_default" };
```

**It fabricates an operator record.** A policy default writes `"approved"` into the field whose documented meaning (`publishDecision.ts:§2.2`) is "the operator's durable publish decision." T2 saw the hazard and mitigated it with `describeOperatorDecisionSource` so a receipt reads `approved (source: project_policy_default)` rather than a bare `approved`. That mitigation is doing real work, and it is doing it because the underlying model is wrong: *the run record claims a decision nobody made.*

Two further defects follow from the same root:

1. **It is a creation-time snapshot of the wrong thing.** The stamp happens once, at `buildInitialRun`. It also survives `workflow.reset_run` (`tools.ts:746` — "The decision survives workflow.reset_run"), which is correct for a real operator veto and wrong for a policy default.
2. **It cannot express withholding under autonomy** — which is fine, because it must never try to (see §2.4).

**Ruling.** `autonomyMode` is resolved **at gate-evaluation time and never written to `run.operatorPublishDecision`.** Absence stays absence. The operator record holds only what an operator actually said — nothing else may write it, in any mode, ever. `applyOperatorPublishPolicyDefault` is deleted in T15.5.

**Migration** (T15.5, mechanical): `operatorDefault:"approved"` → `autonomyMode:"autonomous"`; `"require_explicit"` or absent → `autonomyMode:"operator-gated"`. `project.update`'s `operatorPublishDefault` patch field (`tools.ts:461`) becomes `autonomyMode`, keeping the same narrow, by-name exposure — the rest of `publishingPolicy` stays server-controlled and unpatchable.

### 2.3 The authority resolver — one function, one place

T15.5 adds to `publishDecision.ts` — the module that exists precisely so "the publisher and the executor cannot drift apart":

```ts
export type PublishAuthority =
  | { authorized: true;  source: "operator_explicit" | "policy_autonomous" }
  | { authorized: false; code: string; reason: string };

export function resolvePublishAuthority(
  run:    Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "publishingPolicySnapshot">,
): PublishAuthority
```

Every caller that today asks `isOperatorPublishApproved(run)` asks this instead. `isOperatorPublishWithheld` is unchanged and keeps its own identity, because §2.4 makes it superior to everything.

### 2.4 Precedence — total, ordered, and not negotiable

Evaluated top to bottom; the first match wins.

| # | Condition | Result |
|---|---|---|
| 1 | `run.operatorPublishDecision === "withheld"` | **HALT** — `operator_withheld` |
| 2 | env kill-switch `<CLIENT>_PUBLISH_ENABLED=false` | **HALT** — `publishing_disabled_by_operator_env` |
| 3 | `publishingPolicy.publishEnabled === false` | **HALT** — `publishing_disabled_by_policy` |
| 4 | `run.operatorPublishDecision === "approved"` | **PROCEED** — source `operator_explicit` |
| 5 | decision absent **and** `autonomyMode === "autonomous"` | **PROCEED** — source `policy_autonomous` |
| 6 | decision absent **and** `autonomyMode === "operator-gated"` | **HALT** — `operator_approval_absent` |

**Rule 1 is absolute.** An explicit `withheld` halts in every mode, at every layer, regardless of policy, and is never overridden, defaulted away, or expired. It is the operator's veto and it is the only durable human control that survives autonomy. Rules 2 and 3 sit above policy deliberately: they are infrastructure and ownership controls, not content decisions.

Rules 4 and 5 are both *authorized*, and they are **not interchangeable** — see §5.

### 2.5 Determinism — the policy is snapshotted onto the run

The T15 invariant is consistency over liveness: two runs of the same URL must not diverge (#200). A policy read live at gate time would make the outcome depend on *when* the gate was reached.

**Ruling.** `autonomyMode` (with `publishEnabled` and the per-workflow publishable-type allowlist of §6) is captured onto the run at creation as `run.publishingPolicySnapshot`, and `resolvePublishAuthority` reads **only** the snapshot. A policy edit mid-run does not change that run's outcome. `workflow.reset_run` preserves the snapshot, as it preserves the operator decision.

Rules 1–3 are re-evaluated live, because a kill-switch that a snapshot could stale is not a kill-switch.

---

## 3. Decision 2 — the human gate goes; the machine's self-check stays and gets stronger

The controller gate is **unchanged by autonomy.** `readPublicationDecision` (`publishDecision.ts:§2.1`) still demands an explicit, structurally-present `decision:"go"` with no open blockers, and still refuses silence, prose, hedging, a wrong artifact label, a dry-run placeholder, and a `"go"` carrying blockers. Autonomy does not relax it by one clause.

This is the load-bearing distinction of this ADR:

> **`autonomyMode` governs whether a *human* must speak. It never governs whether the *engine* must be satisfied.**

So the gate at `publish_executor` becomes two independent conditions, both required:

1. **Machine self-check** — `readPublicationDecision(...)` is authorized. Never policy-relaxable.
2. **Authority** — `resolvePublishAuthority(...)` is authorized. Policy-driven, per §2.4.

And T15.6 must carry `publish.mjs`'s per-object self-check into the canonical deterministic path, because the tail's controller decision is run-scoped while `publish.mjs`'s gate is object-scoped, and the object-scoped one has no equivalent in the tail today:

- publish an object only when **that object's own** postcreate/postpatch validation passed;
- **never** publish an object this run quarantined;
- name every withheld object with its reason in the receipt — *"silence about a withheld object would be the same defect wearing a different hat"* (`publish.mjs:22-24`);
- one object's failure never withholds the rest; leases released in `finally`.

Losing any of these in T15.7's deletion is a regression, not a simplification.

---

## 4. Decision 3 — Board decision B2, amended: release becomes a governed tail step

### 4.1 What B2 says and why it is being amended, not repealed

`publisher.ts:19-20`: *"publishRun never releases — releasing to production is a SEPARATE gate whose verb must appear nowhere in this file or in any project's publish execution hook."*

B2's intent — a page write must not be able to trigger a production release as a side effect — is correct and is **retained in full**. What B2 lacked was a sanctioned place for release to happen, and that gap is what T14.5 filled by violating it. `publishExecution.ts:36-38` states the deadlock plainly:

> *"an engine-side 'executed' built on publishRun could never satisfy the evidence rule... The release+verification tail remains unbuilt and is still its own change."*

`enforcePublishExecutionEvidence` requires `verification.deployStatus === "ready"` **and** `productionConfirmed === true` — evidence only a release-and-verify sequence can produce, which B2 forbade anyone from performing. The system demanded proof of an act it prohibited. T14.5 resolved that by going around the tail. T15 resolves it by building the missing step.

### 4.2 The amendment

> **B2 (amended, 2026-08-25, per T15.4).** `publishRun` and every project publish-execution hook still never release; the verb `release_to_production` must appear nowhere in `publisher.ts` or in any project hook. Release is performed by exactly one node — `release_executor`, a governed step of the shared publishing tail — which releases once and verifies the deploy. `trigger_netlify_build` and `deploy` remain unreachable from every path: a build is something `release_to_production` decides to do, never something a workflow asks for directly.

Two verbs move from "unreachable" to "reachable by exactly one node." This is the same containment argument `publish.mjs:5-12` makes for itself — kept, and moved inside the tail where the safety machinery can see it.

### 4.3 `release_executor` (built in T15.6)

- **Position:** after `publish_executor`, before `learning_recorder`. The tail becomes:
  `publish_payload → publication_controller → publish_executor → release_executor → learning_recorder`
  and `learning_recorder.dependsOn` gains `release_executor`.
- **`riskLevel: "publish"`**, `kind: "releaser"` (so `isPublishExecutorNode`'s by-kind precedent extends cleanly).
- **Deterministic.** No model turn. It reads what `publish_executor` committed; it decides nothing a model could decide better.
- **Idempotent, and this is a correctness requirement.** Keyed on `(runId, requestId)`. A re-dispatch, retry, or continuation tick must never release twice. A second call returns the first result.
- **Skips honestly.** Nothing published ⇒ no release (`publish.mjs`'s `release: false` when the publish set is empty), recorded as `skipped` with the reason, not as success.
- **Produces the evidence the rule already demands:** `{ deployStatus, productionConfirmed, releaseId, deployedSha }` — the exact shape `enforcePublishExecutionEvidence` checks for.
- **Never throws past its loop**, per `publish.mjs:26-28`: a stranded lease on a live page blocks the tenant's own admin chat.

**Consequence to schedule.** Adding a tail node is a topology change, not an authoring edit. It requires `npm run nodes:update` + redeploy, and it changes `publishingTailNodeIds`, `publishingTailDeclaration`, the drift-guard test (`tests/agent/workspace/publishingTail.test.ts`) and the re-seed script's tail check — all in the same commit, per `publishingTail.ts:14-22`. This is a **batch point**, and T15.6/T15.7/T15.10's topology changes must ship in the same reseed cycle.

### 4.4 `publish_executor`'s status vocabulary, corrected

Today the engine path publishes and then records `status:"blocked"` with `publishCommitted:true` and a `go_live_unconfirmed` blocker (`publishExecution.ts:39-42`) — an honest workaround for a missing step. With `release_executor` built, that workaround is retired: `publish_executor` records `status:"published_pending_release"` with `publishCommitted:true`, and `release_executor` produces the `executed` claim carrying real go-live evidence. `blocked` returns to meaning *blocked*, and `enforcePublishExecutionEvidence` keeps failing closed on any `executed` claim that lacks the evidence.

---

## 5. Decision 4 — `riskLevel` stays `"publish"`; visibility and blocking are decoupled

T14.5 tagged its publish node `riskLevel:"write"` to escape `executor.ts:491`. That is the failure mode this decision closes: **a node's risk classification describes what it can do, not whether someone must approve it.** Downgrading risk to buy autonomy makes the node invisible to `approvalsRequired`, the attention feed, the publish-risk look-ahead, and every future safety mechanism keyed on `isPublishRisk` — permanently, and silently.

**Ruling.** Every node that can mutate a live site is `riskLevel:"publish"` (or `"admin"`), in every mode, without exception — `publication_controller`, `publish_executor`, `release_executor`, and the capture/clone publish stages once composed. `isPublishRisk` is unchanged.

What changes is only what the executor *does* with that classification:

- **`operator-gated`:** exactly today's behaviour. The node blocks; `markPendingPublishApproval` records a `pending` entry; the run surfaces in the attention feed awaiting a decision.
- **`autonomous`:** the node **proceeds**, and still records its passage in `approvalsRequired` as a **non-pending, advisory** entry naming the authority that let it through (`source: "policy_autonomous"`). It remains fully visible to the attention feed and to publish-risk accounting; it simply does not wait.

An autonomous publish is therefore *observable in exactly the same places* as a gated one. That is the property T14.5 traded away, and the reason `riskLevel` may never again be used as an autonomy switch. A conformance test (T15.7) asserts that no node whose `allowedTools` can reach `object_publish` or `release_to_production` carries a `riskLevel` below `"publish"`.

---

## 6. Decision 5 — boundary contracts: what "compose the tail" means for capture and clone

### 6.1 The tail splits into two segments

`composeWorkflowNodes` today composes an upstream with all seven tail nodes. That is unusable for capture and clone, because the first three tail nodes — `contract_intelligence`, `artifact_plan`, `article_body` — are DTC **copy** authoring. A capture run has no article body and never will.

**Ruling.** `publishingTail.ts` declares two segments:

- **Authoring segment** — `contract_intelligence`, `artifact_plan`, `article_body`. Belongs to copy workflows. Optional in composition.
- **Publish segment** — `publish_payload`, `publication_controller`, `publish_executor`, `release_executor`, `learning_recorder`. **THE shared tail. Mandatory for every workflow that publishes anything. Not optional, not forkable, not substitutable.**

`publishingTailNodeIds` remains the full ordered list (the drift guard keeps working unchanged for `publishing_conductor`); `publishingPublishSegmentIds` is the new mandatory subset, and `composeWorkflowNodes` gains a segment selector. A workflow that publishes and does not compose the publish segment fails `WorkflowCompositionError` at composition time — the fork becomes structurally unexpressible, which is the whole point.

### 6.2 `publish_payload` is the boundary, and the contract

`publish_payload` is the one node every workflow must bind, because it is where a workflow's own output becomes the tail's input. Its bound artifact declares, for each object: `objectId`, `objectType`, the validation verdict the producing workflow reached for it, and quarantine status.

| Workflow | `publish_payload` bound to | Supplies |
|---|---|---|
| `publishing_conductor` | `article_body`, `artifact_plan` | *(unchanged — the composition reproduces the canonical array exactly)* |
| `capture_conductor` | `capture_emit_live`, `capture_score` | emission report: created/reused objects, per-object `validationStates`, quarantines |
| `clone_conductor` | `recipe_mint`, `theme_bind`, `layout_restamp` | minted recipes, bound theme, restamped layouts, with per-object validation |

`publication_controller` then reaches its run-scoped `decision:"go"` from that payload, and `publish_executor` applies the object-scoped self-check of §3. Capture's and clone's existing terminal report nodes (`capture_report`, `clone_report`) stay where they are and become genuine terminal reports over what the tail did — `clone_report`'s "terminal — human gate" framing is retired by T15.10.

### 6.3 Publishable types are chartered per workflow

Declared on the composition, snapshotted onto the run (§2.5), enforced in `publish_payload`: a workflow cannot publish an object type it is not chartered for, and the refusal is a typed composition/payload error, not a runtime surprise.

| Workflow | May publish |
|---|---|
| `publishing_conductor` | the project dialect's article/page object types — **and no template, theme, or section_template** |
| `capture_conductor` | `page`, `navigation` (today) — widened by T15.11 (#190) to `theme`, site singleton, `section_template` |
| `clone_conductor` | `section_template`, page template, `theme`, site singleton |

The first row's exclusion is deliberate and load-bearing: it is the mechanical hook for T15.29 (#205) — *copy workflows never author templates; the studio is the sole structure author* — expressed as a publish-time allowlist rather than only as a tool-permission audit. Two independent enforcement points for one invariant is correct here.

`publish.mjs:44-49` argued that a theme or `section_template` is a recipe and "publishing a recipe is a deliberate studio act, not a side effect of cloning a page." That reasoning is **upheld and relocated**: the clone workflow *is* the studio (ADR #204), so a recipe publish is a deliberate act *of that workflow*, and it is chartered here.

---

## 7. Decision 6 — `workflow.publish_run`'s `approved:true`

`workflow.publish_run` is an operator/test surface; it already says so. It is not on the content path and must not become the way autonomy is exercised.

**Ruling.**

- `approved` is **deprecated as an authority input.** It no longer contributes to whether a publish is authorized; `resolvePublishAuthority` is the only authority. Passing `approved:true` when the resolver says HALT does not publish — most importantly, it can never override rule 1.
- `live` is **retained unchanged** and still required for a real publish. It distinguishes *"plan this"* from *"do this"*, which is a caller-intent question, not an authority question, and remains genuinely useful for the dry-run plan.
- Under `operator-gated`, behaviour is unchanged: no durable `approved` record ⇒ dry-run plan.
- Under `autonomous`, `approved` may be omitted; `live:true` alone publishes, under policy authority, recorded as `source: "policy_autonomous"`.
- The parameter is accepted for one release for compatibility and ignored with a warning in the result, then removed.

Everything `publishRun` does apart from the gate — the request-id contract, media rejection, readiness policy, per-project dialect, step recording, learning observations, and B2 — is unchanged.

---

## 8. Receipts — an autonomous publish must never read as a human one

`operatorDecisionSource` gains a third value. Its existing two are kept for runs created before this ADR:

| Value | Meaning |
|---|---|
| `explicit` | an operator called `workflow.set_operator_publish_decision` |
| `project_policy_default` | *legacy only* — a pre-T15.5 run stamped by `operatorDefault` |
| `policy_autonomous` | **no operator spoke**; `autonomyMode:"autonomous"` authorized it |

`describeOperatorDecisionSource` keeps its job and its rule: descriptive only, never consulted by gate PASS/FAIL.

`approvalMatched` on `publish_execution.v1` is **redefined, and its fail-closed character preserved**. It currently means "the operator's durable decision is `approved`" — a claim that is simply false under autonomy, and leaving it would force every autonomous publish to be downgraded to `blocked` by `enforcePublishExecutionEvidence`. It now means: *the authority this receipt claims matches the authority the run actually holds.* The receipt carries the authority explicitly:

```jsonc
"publishAuthority": {
  "mode": "autonomous",           // from the run's policy snapshot
  "source": "policy_autonomous",  // or "operator_explicit"
  "operatorDecision": null        // verbatim run.operatorPublishDecision — null is null
}
```

`enforcePublishExecutionEvidence` re-derives the authority from the run and downgrades to `blocked` on any mismatch — unchanged in spirit and in strictness. It gains one clause: an `executed` claim whose `publishAuthority.source` is `operator_explicit` while `run.operatorPublishDecision` is not `"approved"` is a forged receipt and downgrades. **No receipt may ever assert a human decided when no human did.** That is the honesty property T2 was reaching for with `describeOperatorDecisionSource`, made structural.

---

## 9. What T15.7 deletes, and the one thing it must not

**Deleted:** `src/agent/capture/engine/publish.mjs`, its vendored twin in `platform/packages/core/cli/capture/`, their provenance hashes in `src/agent/capture/provenance.ts` (same task, per the vendored-engine rule), and the `capture_publish` node's dodge of the publish-risk machinery.

**Carried into the canonical path first** (T15.6, which lands *before* T15.7): the object-scoped self-validation gate, quarantine exclusion, named withholding with reasons, the non-throwing per-object loop, `finally`-released leases, and the permanent unreachability of `trigger_netlify_build` / `deploy`.

Ordering is not a preference. Deleting the side path before the canonical path carries its gate would leave a window in which capture publishes with *neither* gate.

---

## 10. Invariants this ADR binds

1. **One publish path.** Every workflow that publishes composes the publish segment (§6.1). A workflow-local publish or release mechanism is a defect, whatever its justification.
2. **`withheld` always halts.** Every mode, every layer, no override, no expiry.
3. **Autonomy removes the human gate, never the machine's self-check.** (§3)
4. **Nothing but an operator writes `run.operatorPublishDecision`.** Policy is read at gate time and never stamped. (§2.2)
5. **`riskLevel` describes capability, never approval requirement.** No node may lower its risk to gain autonomy. (§5)
6. **No receipt asserts a human decision that did not occur.** (§8)
7. **Authority is a pure function of the run's policy snapshot and the operator record.** Two runs of the same URL resolve identically. (§2.5)
8. **Release happens in exactly one node, once, verified.** (§4)

---

## 11. Consequences accepted

- **A misconfigured project publishes without asking.** Mitigated by three independent halts above policy (rules 1–3), the unrelaxable machine self-check, and full attention-feed visibility. Accepted deliberately: it is the directive, and the alternative — the current state — is four of five runs stalled behind a human who was told not to be involved.
- **`operatorDefault` is removed, changing an existing project-policy field.** Migration is mechanical and total; no project loses a capability.
- **The tail grows a node**, forcing a reseed + redeploy and a drift-guard update. Batched with T15.6/T15.7/T15.10.
- **`approvalMatched` changes meaning.** Confined to `publish_execution.v1`, whose only consumers are the tail and the receipt readers, both updated in T15.6.

## 12. Rejected alternatives

- **Keep both paths, document the fork.** Rejected: it is the status quo, and `publishingTail.ts:5-11` predicted the cost before workflow #2 existed.
- **Relax `readPublicationDecision` under autonomy.** Rejected: it deletes the machine's self-check along with the human's, which `publish.mjs:17-24` correctly identifies as the thing that makes unattended operation *safe* rather than merely unattended.
- **Keep `operatorDefault` and add `autonomyMode` beside it.** Rejected: two fields for one concept is how this fork started.
- **Let `autonomyMode` stamp `operatorPublishDecision:"approved"` at run creation** (the cheapest implementation). Rejected: it writes a human's decision when no human decided, and `workflow.reset_run` would then preserve a fabricated approval. §2.2.
- **A per-run `autonomous:true` flag on `workflow.start_dry_run`.** Rejected: autonomy is a standing property of a tenant relationship, not a per-invocation choice, and a per-run flag is a human gate wearing a parameter's clothes.
