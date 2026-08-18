# WORK ORDER — 2026-08-12 — Determinism program + conductor node-gating

**Next physical action:** open `src/agent/workspace/deterministicContractIntelligence.ts`, copy its pattern into a new `publishPayload.ts`, and wire `metadata.publishPayloadDeterministic` in `executor.ts`. That is W0. Everything else waits.

_Written by the 2026-08-12 Cowork session (Claude), which executed handoff v3 in full. This file replaces v3/v4 as the active work order. Per repo rule, prepend a short State section pointing here into `docs/plan/HANDOFF.md` at the start of the next code session (local git; this session avoided hand-retyping that 20KB file over MCP)._

---

## State since v3 (all of it verified live, not planned)

- v3 executed completely: R1–R4 re-applied surgically; publish gate is exact-`"go"` + exact-`"approved"` operatorPublishDecision, fail-closed; aggression spine live (`ceiling` conditional-required on contract_intelligence.v1, `resolved`+`resolvedBasis` required on article_brief.v1, consumption prompts in brief_architect/draft_writer); trafficSource/awarenessStage wired; EV floor (`evFloor`, cluster-level, required) live on monetization_strategy.v1.
- **Live run `run_1786468126136_ev9goe`: 23/23 nodes completed.** P0 done-condition met verbatim: controller emitted real `decision:"go"`; executor re-read it via stage tools and **blocked fail-closed** on `operatorPublishDecision absent (expected approved)`, zero side effects; learning_recorder captured it.
- **Article published for real** after explicit operator approval: `req_agent_governed_content_object_lifecycle_checklist_20260811_01`, publish commit `0a5b3c5f7293da4d7d86b53fd0d7aa032fffbc9a`, released, `deployStatus:"ready"` + `productionConfirmed:true` (2026-08-12 08:26 UTC). Riders `sec_audience_grid` and `prod_platform_review` deployed with it.
- Run cost $5.56 actual (publish_payload $2.73 across 5 attempts — 2 node-budget stops, 1 OpenAI-credits 429, 1 timeout at toolCallLimit, 1 success). Model config changes that landed: monetization_strategy maxTurns 8 / budget $0.30 + fail-fast-on-dead-monetizer prompt clause; publish_payload maxTurns 8 / toolCallLimit 6 / timeout 300s / budget $2.

## The finding that drives this order

Determinism audit of the completed run (full table in the session transcript; key numbers):
**$4.23 of the $5.56 run (76%) is determinizable.** The remaining ~$1.33 is the actual creative work (draft + reviews). The repo already has the pattern twice: `placement_resolver` (aggressionVector.ts, $0, 1ms) and `contract_intelligence` (prefetch + deterministic mapper, $0 pass-through on this run).

Hard evidence per node: publish_payload's `clientObject` was **byte-identical** to `article_body.body` (it paid $2.73 to copy JSON); input_triage's key fields are byte-identical input→output; artifact_plan's own output states its zero-media rule as an if-statement; monetization_strategy **invented** `estimatedRunCost: $250` (actual: $5.56 — 45× off) because nothing feeds it `workflow_get_run_cost`; `workflow_publish_readiness` (existing server tool, side-effect-free, takes runId) already returned the same GO verdict the $0.097 LLM controller produced.

## Workstreams, in order

**W0 — publish_payload → deterministic engine node. $2.73/run.**
`src/agent/workspace/publishPayload.ts` + `metadata.publishPayloadDeterministic`, mirroring the contract_intelligence pattern (deterministic path, schema-validate, fall through to model on failure). clientObject by reference from article_body; copy envelope/artifactReferences; one `object_validate` via project.call_read_tool; `blockers = union(upstream) − resolved`. Complement: extend server `publish_build_payload` to accept `runId` and emit the `dry_run_publish_payload.v1` projection (today it only wraps/validates an articleBody you pass it).

**W1 — publication_controller → `workflow_publish_readiness` wrapper. $0.10/run, zero new server code.**
Conductor calls the tool, maps `status → decision`, `checklist[].detail → notes`, `blockers → blockers`. Tool verified working on the real run this session.

**W2 — publish_executor gate + learning_recorder → engine. $0.16/run, and removes prose reasoning from the one node that can mutate a live site.**
The gate is two comparisons the engine already owns (`publishDecision.ts`); learning_recorder is a template over structured run facts (optionally keep a nano-model for the one free-text field).

**W3 — article_body: engine-owned validator-retry loop + envelope echo + payload-by-reference. ~$0.6/run, and it was the root cause of W0's blowup** (article_body exhausted `toolCallLimit:3` mid-validation, `deferred: final_revalidation_not_completed_tool_call_limit_exceeded`, forcing publish_payload to redo validation at 5× cost). Also stop echoing `clientProjectId`/`clientObjectType`/`contractSource` through six nodes — inject as run-level context.

**W4 — Conductor node-gating (Wolf's addition, correct): don't run nodes that aren't needed.**
The full 23-node run this session was deliberate — v3 P0 1.5, a post-revert verification run whose job was to exercise every node and the new spine once. It is not the normal shape. The conductor already has the levers: `entrypoint: "article_body"` late entry, `workflow_run_until`, `workflow_run_node`, per-node deterministic metadata flags. What's missing is **skip predicates** — deterministic pre-dispatch rules that mark a node `skipped` instead of dispatching it:
- `research`: skip unless an external-claim trigger fires. Evidence: this run it made zero web calls and its output said browsing wasn't needed — $0.06 spent concluding it had nothing to do.
- `artifact_plan`: skip when the body declares no media slots (its own zero-media shortcut, moved pre-dispatch).
- `monetization_strategy`: skip (or run in cheap mode) for own-property/docs content where the EV floor is exempt by standing decision.
- Review quartet (`human_texture`/`trust_factual`/`emotional_resonance`/`reader_simulation`): tier by content class — docs/runbook content may need 1–2 reviewers, not 4. This one is a policy call, not pure code: propose the tiers, Wolf picks.
Implementation: a `skipWhen` predicate in node metadata evaluated by the executor pre-dispatch, emitting an explicit `skipped` node status (auditable, not silent). Ballpark: a typical docs-class run drops from ~$5.5 to well under $1 combined with W0–W3.

**W5 — EV-floor inputs made real.** New deterministic tool `monetize.ev_floor` (arithmetic + `runCost` from `workflow_get_run_cost`); fixes the 45× fabrication. Blocked upstream of real offer data by 2.4: set `MONETIZER_MCP_ENDPOINT`/`_TOKEN` (server env) **and** resolve the `project.call_read_tool` allowlist vs monetizer tool-name mismatch (`search_offers` etc. are not in the fixed allowlist — reads will be refused even with credentials).

**W6 — Correctness queue (from this session's live findings, order matters less):**
1. ✅ **DONE (S3, 2026-08-18 — `readinessContentChecks.ts`: `upstream_blockers` fails readiness on `aggression_ceiling_missing` from contract_intelligence/brief_architect; `article_has_content`, `article_body_blockers`, `media_requested_vs_delivered` added; every media ref must be verified; the controller passes `run.stageOutputs` to the readiness function.)** **Blocker propagation**: controller said "go" while contract_intelligence carried `aggression_ceiling_missing` and evFloor said `block` — upstream blockers never reach the decision. Make it a conductor rule over `workflow_publish_readiness`'s machine-readable blockers, not prompt text. Needs Wolf's ruling on the own-property EV exemption (this run's publish was approved as exactly that exception).
2. **Declare `aggression_ceiling` in the platform client contract** (platform repo) — until then every client run blocks at contract_intelligence by design.
3. **Resolved-vector clamp topology**: contract prefetch runs after brief_architect, so `resolved` ships unclamped (the run proved it: blocker raised, draft already written). Move prefetch ahead of brief_architect at next re-seed; make `resolved = min(ceiling, target)` engine-computed, never model-emitted.
4. **publish_executor modelConfig**: `maxOutputTokens` reads `"[REDACTED]"` on every MCP read path (node-specific server-side redaction — investigate why); `update_node_model_config` is whole-object replace that silently drops omitted keys (data-loss bug — fix the guard to recurse). Until the true value is recovered from the seed file, executor's toolCallLimit 3 makes `status:"executed"` structurally unreachable (needs ~4 calls of evidence) — fine while blocking, must fix before first executor-driven publish.
5. Real `trafficSource`/`awarenessStage` enums from `aggressionVector.ts` into both schemas; brief_architect→placement_resolver dependency at re-seed.
6. P2 backlog unchanged from v3: regression verdict compares baseline-only ("held" at 0/4 vs threshold 0.85), `casesPassed+casesFailed≠casesScored`, 4 cases share one subjectHash; 5 rubrics `status:"active"` vs `activationStatus:"DRAFT"`; rubrics missing for all commercial nodes; learning_recorder lacks `stage.get_output`; 11 mid-pipeline generic schemas; playbook migration ready (dryRun verified: 7 obs → 2 playbooks); editorial_review stub on agt_client_manager (gpt-4.1); extract shared publish sub-graph before workflow #2.

## Skills used this session (point the next session here)

- **`publish-gate-runner`** — governed the real publish (batch card, riders, release-once, deploy verification). **Two of its claims are now stale, update it:** (a) the three locks section — `publishEnabled` is `true` by standing go-live decision since 2026-07-31 and is an env flag, NOT patchable via `project_update`; (b) the "Known defect" section — publication_controller's schema is FIXED (required `decision` enum go/no_go/blocked with if/then forcing empty blockers on go). Use `skill-creator` to revise.
- **`adhd-agentic-work`** — this document's format (answer first, next physical action, capture, session close).
- Orchestration pattern that worked: per-fix subagents tiered by judgment required (Opus: publish gate / article_body / aggression spine; Sonnet: schema mechanics + diagnostics; Haiku failed at MCP-tool discipline — don't use it for MCP-heavy work).
- Relevant but not invoked this session: `money-attention` / `money-review` (cost lines were kept inline; the determinism program IS the cost lever), `okr-cycle` if this becomes the cycle's objective.

## Verification block for the next session

```
workspace_validate_graph                          # expect valid (v355+)
workflow_get_run({runId: "run_1786468126136_ev9goe"})   # 23/23, executor blocked-then-approved history
usage_get_summary({status: "actual", from: "2026-08-11T17:00:00Z"})  # ~$5.56 + $? publish
mcp__Kugel-Platform__deploy_status({commit: "0a5b3c5f"})  # ready + productionConfirmed:true
npm run nodes:check                               # store↔seed drift after this session's store edits — EXPECT DRIFT; re-seed deliberately, do not clobber (v3 §4 open question now live)
```

That last line is the trap to respect: this session made ~25 store-side edits (workspace v312→v355). `npm run nodes:update` re-seeds from live; never hand-copy, and confirm the seed run picks up the new schemas/prompts before the next deploy.

**S3 additions (2026-08-18) — belongs under HANDOFF.md G6; recorded here until that file is next edited in a code session:**

- **Offline half of G6: `npm run nodes:check:offline`.** CI runs the seed generator against the COMPILED canonical set (`--from-canonical`, no credentials), so a hand-edit to `nodes.ts` that the generator would not reproduce fails on every push. It proves the round-trip, NOT live parity — G6 (`npm run nodes:check`) is still the pre-deploy gate. The generator now keeps the shared `TRAFFIC_SOURCE_ENUM_PROPERTY` / `AWARENESS_STAGE_ENUM_PROPERTY` identifiers on re-seed instead of inlining the enum into every schema, and ignores hand-written `//` notes inside the array for the drift verdict.
- **requestId.** For a project whose `objectDialect.requestIdPattern` is declared, a live (`executionMode: openai`) `workflow_start_dry_run` REQUIRES a caller-supplied, pattern-valid `requestId` (`request_id_required` / `invalid_request_id`); nothing is auto-minted. Mock runs keep the auto-minted join key. The client manager supplies `req_agent_<slug>_<yyyymmdd>_<nn>`; the conductor creates the content-item shell under that id before `artifact_plan` (`src/agent/workspace/contentItemShell.ts`) and the publisher patches it, so media and object share one request id end to end.

**Money:** 2026-08-11/12 actual model spend $5.56 (engine) + publish-path spend; OpenAI credits were topped up mid-session after hitting $0. Deterministic program target: docs-class run < $1, money-class run ~$1.5–2, both with the gate intact.
