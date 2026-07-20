# Agent Improvement Engine — strategy (research record, July 2026)

Status: **implemented (scaffold, mock-runnable end-to-end)** as Phase 3 of
`docs/platform/DIRECTION.md`. What shipped: `src/agent/improvement/` (types, mock+LLM
rubric judge with both-ordering pairwise, ACE playbooks, replay harness with
stage-output-suppressing trial facade, GEPA-style optimizer with propose→trial→promote
and a stale-baseline guard, cost-aware model ladder), Evaluation/Improvement
repositories (memory + blob/GCS), the provider registry (openai | google
OpenAI-compat | openai_compatible; env-var NAMES only) wired into the runner, the
per-node playbook injection replacing global observations (gap §6), and ~24 MCP tools
(`evaluation.*`, `feedback.*`, `dataset.*`, `optimizer.*`, `playbook.*`). Ops note:
add these namespaces to `MCP_EXPOSED_TOOL_PREFIXES` if the catalog is scoped.

**Known follow-ups (tracked, deliberately out of the scaffold — now sequenced as
`docs/platform/DIRECTION.md` Phases 4–8, with Netlify retained and the control
plane switchable from the existing UI):** the conductor
executes STATIC nodes (`nodes.ts`), so promoted prompts are live for independent
execution and replay but reach full conductor runs only once the executor reads
store nodes — the loop is self-consistent, but treat conductor behavior as unchanged
until that lands; LLM-driven playbook curation (current `playbook.curate` is
heuristic); automatic post-run reflection; analytics ingestion (Monetizer
`performance` → `feedback.record` outcomes); auto-promotion flag (promotion is
human-approved by design today); model-ladder enforcement in the conductor.

This document preserves the verified research and the chosen techniques behind that
implementation.

Goal: every agent in the constellation gets measurably better **in its own role**
over time while getting **cheaper**, using feedback from (a) human edits/approvals,
(b) published-content analytics, and (c) LLM judges.

## 1. The loop

**Capture → Evaluate → Diagnose → Propose → Trial → Promote → Distill**

The repo already provides most of *Capture* and all of the promotion substrate:
run records with per-node stage outputs (`ExecutionRepository`), token/cost ledger
(`modelUsage`), immutable change history with restore (`changes.*`), versioned
prompts and skills, per-agent constellation metrics, and dry-run execution. The
engine adds the missing entities its own gap register names
(`docs/constellation/data-model-gaps.md` §4b: evaluation, experiments; §6:
namespaced memory).

| Loop stage | Mechanism | Substrate |
|---|---|---|
| Capture | Existing run/usage/change records + new `FeedbackRecord` (approve/reject/edit-diff, analytics outcomes) | exists + additive repository |
| Evaluate | Per-node **rubrics** scored by LLM judges; human feedback; analytics | new `EvalRubric`/`EvalResult` entities |
| Diagnose/Propose | **GEPA-style reflective optimization**: LLM reads failing traces + eval evidence, proposes prompt mutations in natural language | new optimizer module |
| Trial | **Champion/challenger replay**: historical stage outputs = frozen inputs; challenger variants re-run offline; pairwise-judged | dry-run + independent node execution |
| Promote | Eval-gated, **human-approved by default**, written through the versioned `mutate()` funnel with structured reason ⇒ one-step rollback via `changes.restore` | exists |
| Distill | Export judge-approved traces as SFT/preference datasets → fine-tune small models when triggers fire (§5) | new export tools |

## 2. Chosen techniques and the products behind them

All verified current and production-credible as of July 2026:

- **Rubric-based LLM-as-judge** (per-node, role-specific criteria). Judging hygiene
  that is now consensus: pairwise comparisons run in **both orderings** (count only
  agreement; disagreement = position bias, recorded as `inconsistent`); judge from a
  **different model family** than the generator (self-preference bias is measurable);
  control for length bias; calibrate against human labels periodically.
  Optional CI gates later: promptfoo / DeepEval (both OSS).
- **GEPA — reflective prompt evolution** (Genetic-Pareto; ICLR 2026). The current
  production-standard prompt optimizer: default in DSPy 3.x, adopted by Google ADK,
  Microsoft, Databricks, Nubank; beats RL-style optimization with ~35× fewer
  rollouts and works from as few as ~10 examples. Plan: a TS-native GEPA-style loop
  around the existing runner (the core loop is small); heavy offline optimization
  can use the Python `gepa`/DSPy packages against exported datasets.
- **ACE — Agentic Context Engineering** (evolving playbook; ICLR 2026). Per-node
  curated bullet "playbooks" (helpful/harmful counters, dedup, size budget,
  Reflector→Curator updates) instead of the current anti-pattern of injecting **all**
  global learning observations into **every** prompt (gap register §6). Improvement
  with zero training.
- **Runtime critique loops** (Reflexion / Self-Refine style): bounded
  critique-then-revise passes pre-publish; cheap, immediate quality lift — the
  existing four review nodes already approximate this; rubrics make their output
  *scored data* instead of prose.
- **Observability**: the repo's own repositories already capture what the loop
  needs; if external observability is ever wanted, self-hostable OSS options are
  Langfuse / Arize Phoenix / Comet Opik, and the OpenTelemetry GenAI semantic
  conventions are the portable export format. Not required for the engine.

**Ecosystem landmines (verified):** OpenAI Evals / Agent Builder / reusable Prompts
are deprecating (shutdown Nov 2026) — build nothing on them. Humanloop is gone
(absorbed into Anthropic, platform sunset). Zep's OSS community edition is
deprecated (only Graphiti remains OSS). Gemini 2.5 Flash-Lite retires Oct 2026 —
start on 3.1 Flash-Lite instead.

## 3. Evaluation design (per-agent, role-specific)

Each node gets a versioned rubric matched to its role, e.g.:

- `draft_writer`: voice/style conformance, structure, factual grounding hooks,
  reader-value density.
- `seo_review`: metadata completeness, search-intent match, schema validity.
- `trust_factual`: claim-evidence linkage, unsupported-claim count.
- `publish_payload`: format/schema compliance, taxonomy correctness (near-boolean —
  cheap models judge these well).

Three feedback sources feed the same `EvalResult`/`FeedbackRecord` stream:

1. **Human edits/approvals** (highest value, zero extra effort): approve/reject
   decisions and the diff between the agent draft and the human-edited published
   body become preference signal automatically.
2. **Published analytics** (slow, but measures what matters): pull performance for
   published pieces (the Monetizer MCP's `performance`/`demand_signals` tools are the
   natural source) and attach outcomes to the runs that produced them.
3. **LLM judges** (fast, always on) with the §2 hygiene rules.

## 4. Model tiering + cost (verified economics, user's GCP)

Per-node "model ladder" policy: **the cheapest model whose eval pass-rate on that
node's rubric stays ≥ threshold** — decided by eval data, not intuition. The
existing per-node `modelConfig` is the seam; a provider registry (OpenAI-compatible
`baseURL` + API-key env-var *name*) lets nodes run on Gemini or self-hosted models
without changing the runner architecture.

Verified numbers (July 2026, directional — re-verify before budgeting):

- **Default cheap tier: Gemini 3.1 Flash-Lite on Vertex AI** (~$0.25/$1.50 per 1M
  tokens). At 30–300 articles/month with ~20–50 small subtask calls each, the entire
  small-model bill is **~$1–20/month**. Batch mode = flat **50% off** for
  non-interactive steps; context caching up to ~90% off large repeated context
  (style guides, exemplars). Reached via Gemini's OpenAI-compatible endpoint —
  a config change, not a rewrite.
- **Vertex vs AI Studio**: Vertex does **not** train on customer data; the AI Studio
  free tier **does** — free tier is disqualified for client work.
- **Self-hosting small open models is not cost-effective at current volume**: one
  L4 on Cloud Run ≈ $480–820/month always-on (or ~$75–200/month on spot GKE plus
  real ops burden) vs single-digit dollars on managed Flash-Lite. Break-even sits at
  tens of millions of tokens/day, or when a fine-tuned narrow model beats the managed
  tier on quality (see §5 triggers).
- Quality-critical steps (final article pass) stay on the strongest model
  (currently `gpt-5.5`; Gemini 3.5 Flash is the mid-tier alternative).
- License-clean small-model portfolio when self-hosting does fire (Apache/MIT):
  **Qwen3 4B/8B/14B** (best structured-output + judge backbone), **Gemma 3/4 12B**
  (best small prose), **IBM Granite 4.x 8B** (long-context extraction/JSON),
  **Phi-4-mini** (tiny classifier). Serve with **vLLM** (OpenAI-compatible,
  preserves the `response_format`/JSON-schema + zod contract; Ollama's `format`
  param is *not* compatible with that contract — dev-only).

## 5. Fine-tuning flywheel (trigger-based, not default)

Do **not** fine-tune until triggers fire; prompt/context optimization (GEPA + ACE)
captures most gains first at near-zero cost.

**Triggers to start tuning a narrow subtask model:** (a) that subtask's volume ×
cost makes managed pricing material, or (b) eval data shows a quality ceiling that
prompt optimization can't break, and ≥500–2,000 judge-approved examples exist.

**The recipe (2026 consensus):**

1. Export judge/human-approved traces per node role as SFT JSONL; export
   chosen/rejected pairs from pairwise trials as preference data.
2. **Unsloth QLoRA** on a spot A100 (**~$3–10 per run**, ~1–4 h) for a 4–8B student
   (Qwen3-8B / Granite-8B class). Curation matters more than volume — judge-filtered
   beats bigger-but-unfiltered (distilabel is the standard pipeline tool).
3. Preference stage ladder for writing style: **SFT → ORPO or DPO** (paired data)
   or **KTO** (only thumbs up/down available) → **GRPO** with a judge-derived reward
   once the eval harness is trusted.
4. Serve adapters via **vLLM multi-LoRA** (hot-swappable, ~hundreds of adapters per
   GPU) on Cloud Run GPU with scale-to-zero, fed by overnight batches — pay only
   while the batch runs. Avoid the Vertex tuned-model hosting fee (~$1.20/h
   always-on) at low volume.
5. **Eval-gate every adapter**: a new adapter deploys only if it beats the incumbent
   on the held-out rubric set (champion/challenger, same as prompts). Mitigate
   forgetting with replay data / orthogonal-subspace LoRA; the mature end-state for
   continual gains is on-policy distillation (teacher scores the student's own
   rollouts).

## 6. Safety rails

- Optimizer is **propose-only by default**: every promotion is a human-approved,
  versioned change with a structured reason and evidence (run/eval IDs), flowing
  through the existing `mutate()` funnel ⇒ attributable, diffable, one-step
  reversible. Auto-promotion, if ever enabled, sits behind an explicit flag.
- Publish gating (`DR_LURIE_PUBLISH_ENABLED`, approval pins, readiness checks) is
  untouched by the engine.
- Judges and optimizers run as read-only consumers of run history; trials run
  against frozen replay inputs and must never mutate live workspace state.

## 7. Growth stages within the engine (basic → advanced)

1. **Measure** (basic): rubrics + judge scoring of existing runs + feedback capture.
   No behavior change — just scored visibility per agent. (This alone answers
   "which agent is weak, where, and is it getting better?")
2. **Remember**: ACE playbooks per node (replacing global observation injection —
   the documented gap §6 fix) + critique-loop tightening. First behavior change,
   zero training.
3. **Optimize**: GEPA-style propose → replay trial → pairwise gate → human-approved
   promotion. Prompts now evolve under version control.
4. **Cheapen**: model ladder per node on eval data; cheap subtasks migrate to
   Flash-Lite-class models; batch/caching discounts applied.
5. **Distill** (advanced): §5 flywheel — datasets, LoRA adapters, eval-gated adapter
   deployment, on-policy distillation.
6. **Close the outer loop**: published-analytics outcomes re-weight what the judges
   and optimizer optimize for (write what demonstrably performs, not just what
   scores well).

Stages 1–3 need no new infrastructure beyond the Phase-1/2 platform work; stages
4–6 are where Cloud Run Jobs (long batch) and the GCP model estate pay off.
