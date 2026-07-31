# Node-limits audit — every node, all five limits (2026-07-31)

Recorded as documentation of what was done in the node-system overhaul (PR A), not a proposal.
Evidence base: two live platform runs of the same brief — `run_1785405350649_9u5mjz` (pre-#99) and
`run_1785435947311_jl8hl4` (post-#99, $4.15 against a $3 ceiling = 138%) — plus the run record,
usage ledger, and prompt/config diffs. Tool-call transcripts do not exist for either run because
ToolExecutor's audit records lived in process memory and died with each serverless invocation
(fixed in PR B); every per-node diagnosis below is therefore prompt text + payload arithmetic, and
says so where it matters.

## The pattern that was killed

A looping node re-sends its whole growing conversation on every model turn. Anything that inflates
the conversation is therefore paid once per remaining turn, not once. Three mechanisms fed it:

1. **The runner's prompt duplicated every dependency output** — `input.dependencies` and a sibling
   `dependencyOutputs` key carried the same data, doubling the base payload of every node on every
   turn (`OpenAINodeRunner.ts`, fixed: delivered once).
2. **Tool results entered the conversation unbounded.** Only `web.fetch` had a byte cap (250KB —
   itself ~62K tokens). `stage.list_outputs` returned every stage output's full value (~130K chars
   on a mature run) and is granted to most nodes. Fixed twice over: `stage.list_outputs` now returns
   bounded summaries (id, stage, size, 240-char preview), and EVERY controlled-tool result is capped
   at `TOOL_RESULT_MAX_CHARS` (default 32,000 chars) entering the conversation, with explicit
   truncation, never silent.
3. **The limits that existed did not hold** (§budget guard below), and 16 of 21 nodes had no
   modelConfig at all — `maxOutputTokens` and per-node `budgetUsd` appeared zero times in the seed.

`toolCallLimit` previously bounded nothing (it only fed the maxTurns derivation; no code counted
invocations). It is now an enforced per-execution cap: calls beyond the limit are refused with
`tool_denied:tool_call_limit_exceeded`, a message the model reads mid-loop.

## The three suspects, diagnosed

### brief_architect — $0.042 / 2,600 in → $0.553 / 100,937 in (39×)

W-4's hypothesis confirmed by prompt diff + arithmetic. The pre-#99 prompt carried Dr. Lurie's tone
guardrails inline, so the node wrote the brief from angle_strategy alone: 2,600 input tokens ≈ one
turn, no tool reads. #99's client-neutral rewrite told it "the brief's tone guardrails must come
from [the client's own record and the run's inputs]" — sources none of its three tools
(workspace.get_node, stage.get_output, stage.list_outputs) can reach, because P-2 (the voice record)
is unbuilt. It went hunting: its own delivered input was ~4.4K chars (angle_strategy only), the
available stage outputs total ~33K chars ≈ 8K tokens per full read, and ~5 hunting reads re-sent per
turn compound to exactly the observed ~101K input tokens within its 7-turn ceiling.

Fix is structural (W-5 precedent — deterministic input beats hoping the model makes the right tool
call): brief_architect now DEPENDS on all six strategy nodes (topic_opportunity, reader_insight,
research, objection_mapping, narrative_movement, angle_strategy; requiredInputs in lockstep), so
everything its prompt tells it to consult arrives in its input, delivered once. Its prompt now says
tone guardrails come ONLY from what is present in its input; a missing voice direction is recorded
as an assumption, never searched for — when a client voice record exists, the conductor delivers it.

### artifact_plan — $0.278 / 50,469 in → $1.95 / 386,138 in (7.6×)

Its delivered input was 18K chars (article_body's output). Its output: 3K chars, for a text-only
article with zero media. Everything in between was loop growth: with no modelConfig it had 7
derived turns, no tool-call cap, no output cap, no budget — and its slot-verification prompt plus
uncapped stage/tool reads re-sent per turn fits the 386K observed (a single full stage dump is ~33K
tokens; 386K ≈ a handful of large reads compounding over 5-6 turns). "Aborted incomplete" in the
ledger sense: the run's ceiling was defended only AFTER it finished (see budget guard below).

Fixes: the zero-media shortcut in its prompt ("when the delivered body declares no media slots —
emit the plan immediately with zero tool calls"), plus maxTurns 5 / toolCallLimit 3 / budgetUsd 0.5,
plus the global result caps.

### research — $0.38 / 71,586 in → $0.563 / 104,247 in

Yes — fetched pages were living in the conversation: `web.fetch` returns up to 250KB of page text,
the conversation re-sends it on every one of up to 15 turns, and nothing instructed extraction.
Fixes: prompt now mandates extract-what-you-need-immediately ("every retained page is re-sent on
each of your subsequent turns"), the 32K-char per-result cap bounds each fetch entering the
conversation, toolCallLimit 8 is now enforced, and budgetUsd 0.75 backstops the whole node.

## The limits table (current → new)

All five limits = maxTurns / toolCallLimit / timeout(ms) / budgetUsd / maxOutputTokens.
"—" = absent before. Observed = jl8hl4 unless noted.

| node | before | after | rationale |
|---|---|---|---|
| input_triage | — | 3 / 2 / 90000 / 0.10 / 2000 | reshapes the request; observed $0.008 |
| topic_opportunity | — | 3 / 2 / 90000 / 0.10 / 2500 | single-dep strategy call; observed $0.019 |
| reader_insight | — | 3 / 2 / 90000 / 0.10 / 2500 | single-dep strategy call; observed $0.018 |
| research | —/12/180000/—/— | 12 / 8 / 240000 / 0.75 / 4000 | the one legitimate tool-loop; caps now enforced; observed $0.563 must come down |
| objection_mapping | — | 3 / 2 / 90000 / 0.15 / 3000 | observed $0.034 |
| narrative_movement | — | 3 / 2 / 90000 / 0.15 / 3500 | observed $0.033 |
| angle_strategy | — | 3 / 2 / 90000 / 0.15 / 3000 | observed $0.029 |
| brief_architect | — | 4 / 2 / 180000 / 0.40 / 5000 | six deps now delivered in input; healthy baseline $0.04, regression $0.553 |
| draft_writer | —/—/300000/—/— | 4 / 2 / 300000 / 0.50 / 8000 | largest single generation (F5's proven 300s stays); observed $0.095 |
| human_texture | — | 3 / 2 / 180000 / 0.25 / 4000 | full-draft rewrite pass; observed $0.061 |
| trust_factual | —/8/120000/—/— | 8 / 5 / 180000 / 0.40 / 3000 | web.fetch verifier; caps now enforced; observed $0.086 |
| emotional_resonance | — | 3 / 2 / 120000 / 0.20 / 2500 | observed $0.059 |
| reader_simulation | — | 3 / 2 / 120000 / 0.20 / 2500 | observed $0.057 |
| review_aggregator | — | 3 / 2 / 120000 / 0.25 / 3500 | 4-way fan-in arrives in input; observed $0.053 |
| contract_intelligence | 8/5/180000/—/— | 6 / 3 / 180000 / 0.35 / 6000 | post-prefetch it is validation/pass-through; observed $0.134 |
| article_body | — | 6 / 3 / 300000 / 0.75 / 10000 | biggest builder + client validator round-trips; observed $0.40 |
| artifact_plan | — | 5 / 3 / 180000 / 0.50 / 3000 | see diagnosis; zero-media shortcut makes the common case one turn |
| publish_payload | — | 5 / 3 / 180000 / 0.50 / 10000 | assembles the full payload; never ran in jl8hl4 |
| publication_controller | — | 3 / 2 / 120000 / 0.25 / 3000 | decision record only |
| learning_recorder | —/—/300000/—/— | 5 / 4 / 300000 / 0.30 / 3000 | G1's proven 300s stays; list_outputs now returns summaries |
| publish_executor | — | 4 / 3 / 180000 / 0.50 / 4000 | draft node; sized for when it activates |

retryCount kept where it existed (research, draft_writer, trust_factual, contract_intelligence).
Worst-case sum of node budgets ≈ $6.4; a healthy full run is expected ≈ $1.5–2.0 with the caps, and
the run-level ceiling (workflow.start_dry_run budgetUsd) now actually holds (below).

Prompt-side, the open invitation "Memory policy: read relevant stage outputs and learning
observations when useful" (17 of 21 prompts) became "your dependency outputs and the run's inputs
are delivered in this node's input — work from them; do not re-read stage outputs you already hold."

## Why the budget guard permitted 138% (and the fix)

Reproduced from jl8hl4's numbers: spend before artifact_plan ≈ $2.2 of a $3 ceiling — dispatch
legal. #95 H4's in-loop guard listened to the SDK's `agent_start` hook and read `runContext.usage`
for accrued spend; that object is not reliably populated while a node's own loop is running, so the
accrued term stayed pinned at $2.2 for the whole loop and only the single-turn prospective estimate
grew. artifact_plan's turns each passed ($2.2 + one-turn-estimate < $3) while actual spend climbed
to $4.15; the between-node gate then reported the crossing after the fact. Two further holes made it
worse: a failed/aborted node recorded NO usage at all (success-path-only telemetry), and the
between-node gate reserved nothing for the node it was about to dispatch.

Fixes (all in PR A):
1. **Per-request interception** (`budgetGuard.ts`): the Model itself is wrapped; every request is
   gated BEFORE it is sent (prior-run spend + this node's ACTUAL accumulated usage + the request's
   own prospective size vs the tighter of node/run ceilings) and every response's actual usage is
   accumulated. A node stops before the turn that would cross, with `budget_exceeded` naming the
   numbers.
2. **Failed nodes record their real spend** (partial "actual" usage record with failureCode).
3. **Pre-dispatch reservation**: the run gate now blocks when accrued spend + the next node's own
   declared budgetUsd would cross the run ceiling — a run stops before the dispatch that would
   cross, not after it did.

## Conductor findings (c) and (d)

**(c) getRunContext bundle:** measured — the conductor injects NOTHING from getRunContext into any
dispatched node's conversation. Node input is exactly `{initialInput?, dependencies,
clientProjectId}` plus `prefetchedContract` for the one contractPrefetch node. The bundle is only
served on the `workflow.get_run_context` wire tool (operator surface) and is memoized per run. The
per-turn re-entry that DID exist was the runner's own duplicate serialization of dependencies
(fixed) and unbounded tool results (fixed). No node's allowedTools includes
`workflow.get_run_context`, so the bundle cannot enter a conversation by tool call either.
`RunContext.projectContract.canonicalArticleBody` still exists in the bundle type and dies with the
R-23 rename in PR B.

**(d) canonical-vs-store schema sources:** re-verified 2026-07-31 — nodes.ts was regenerated from
the live v259 export in this change, so `getWorkspaceNode("article_body").outputSchema` and the
store's copy are byte-identical by construction today. The structural two-sources situation (canonical
for the seven read sites, store-overlay for executor validation) is unchanged and remains guarded by
`nodes:check`; no drift found since #99.

## MCP boundary — what enters a conversation, and what bounds it now

| endpoint | callers | enters conversation? | bound (now) | fails by name? |
|---|---|---|---|---|
| project.call_read_tool | contract_intelligence, article_body, artifact_plan, publish_payload (+ prefetch path in code) | yes (tool result) | 32K-char runner cap; contract fetches go through reduceContract (~13K tokens) instead | allowlist: `read_tool_operation_not_permitted`; policy: codes; transport: now `client_unreachable (<ErrorName>)` |
| project.call_tool | same four + publication_controller, publish_executor (approval-gated) | yes when approved | 32K-char runner cap | same |
| contractPrefetch (`getReducedContract`) | executor, before contract_intelligence | yes, once, as `prefetchedContract` | reduceContract keeps bodySchema whole + bounded extracts; platform's raw contract is 141K chars, reduced ≈ 25K chars; jl8hl4 measured 13,364 input tokens total for the node | `prefetch_object_type_unresolved` + run-visible warning |
| publish-hook ctx.call | drLurie/platform executePublish via publisher.ts | no (wire response only, never a model conversation) | extractors narrow results; steps[] stores {tool, ok, error} only | throws `<tool>_failed: …` — by tool name |
| get_pdf_tool_storage_grant | remote tool on client servers; reached via project.call_tool (artifact_plan) | yes when approved | 32K-char runner cap | client's own error surface |
| stage.list_outputs (controlled) | most nodes | yes | summaries only (id, stage, size, 240-char preview) | n/a |
| web.fetch | research, trust_factual | yes | 250KB fetch cap AND 32K-char conversation cap | named fetch errors |

**reduceContract keeps nothing unread**: bodySchema (article_body), idConventions (article_body,
publish nodes), mediaConvention (artifact_plan), taxonomy + validationSurface (publish_payload,
publish_executor), constraints/publishPolicy/workflowSequence (publish path), contractSource
(provenance, every consumer), `unmapped` (bounded to 20 entries — the honesty valve for a client
shaped differently than the ones inspected). Nothing else survives the reduction.

**private.agentNotes**: verified against platform's LIVE content_item contract 2026-07-31 —
`private.agentNotes` (string) IS declared inside `private` alongside strategy/intent/sourcePromptId/
inputTemplateId, with `additionalProperties: false` on the private block. article_body's per-node
notes emission is contract-valid; no prompt change needed.

## Dr. Lurie purge — inventory

Shared-layer traces found and moved/neutralized (all live-plane + re-seed, workspace v255 → v259,
skill store v14 → v20):

- **Prompts** (5 nodes carried domain text): topic_opportunity ("scientific, medical-adjacent"
  research triggers), research (medical-adjacent triggers, "primary scientific, clinical" source
  preference, "unsafe medical certainty" blocker), brief_architect + draft_writer ("unsafe medical
  certainty", "diagnosis"), trust_factual ("medical/compliance risk", "overconfident medical
  language"). All are now client-neutral ("unsupported certainty on high-stakes claims", "a client
  whose domain needs a stricter evidence bar declares it in its own record"); the removed
  constraints live verbatim-equivalent in `src/agent/projects/drLurie/editorialVoice.ts`
  (DR_LURIE_DOMAIN_CAUTION) and surface on project.get via drLurie knowledge.
- **Skill ids**: `dr_lurie_contract_intelligence` → `contract_intelligence`,
  `dr_lurie_dtc_science_editorial` → `editorial_craft` (clone → patch name/namespace/metadata →
  reassign → delete old ids). Memory namespaces renamed in lockstep. The branded voice text (the
  old skill's v2) is preserved verbatim in `editorialVoice.ts` as the `vox_drlurie_default` seed
  (P-2), so deleting the old ids lost nothing.
- **The remaining "(medical, legal, financial)" mentions** are the universal professional-advice
  safeguard, deliberately kept — that is shared-baseline reader safety, not client voice.
- **Client-layer files keep their brand** (drLurie/ hooks, knowledge, policy docs) — untouched
  except for gaining the editorial/caution module. Historical wave logs untouched.

## The two standing attention warnings — resolved deliberately

`publication_controller` and `publish_executor` no longer carry the contract skill at all. The
skill's instructions center on project.call_read_tool discovery, which those nodes rightly deny and
never need (they consume publish_payload's output; their prompts + metadata.canonicalRules carry
the gate discipline). The warnings existed because the ASSIGNMENT was wrong, not the lock. Verified
live post-change: constellation.get_attention shows zero skill/tool warnings; the nodes' own
approval-gated project.call_tool grant is byte-for-byte unchanged, and no publish gate opened or
changed its grants anywhere in this change.
