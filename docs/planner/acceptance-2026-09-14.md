# Track C acceptance — `editorial_planner`, 2026-09-14

_What was built, what was proven against the live fleet, and the one thing that cannot be proven
until both repos deploy._

## Verdict, first

**Can a tenant with a filled `commissioning` block publish 2 articles a day unattended? Not yet —
one redeploy short.** Every piece is built and tested; the plan is proven against live dr-lurie
data; and nothing that remains is design work. What is left is:

1. deploy `cms-agent` (service **and** a repin of the jobs), deploy `platform`;
2. write a `commissioning` block onto the tenant's `editorial_strategy` — impossible before (1),
   because the currently deployed body schema is `.strict()` and refuses the unknown key;
3. create the Cloud Run job and its schedule (commands in §5);
4. one `planner_commission {projectId, max: 1}` to watch a commissioned run reach release.

After that the answer is yes, and the only thing still manual is the strategist's decision about
what a site publishes — which is the thing that should stay manual.

## 1. The live dry plan (P2 acceptance) — PASSED

Run against the **real** dr-lurie catalogue and run history, through the real `buildCommissionPlan`.
Inventory read with `object_list content_item` (38 active objects); runs with
`workflow_list_runs {projectId: "dr-lurie", from: 2026-08-15}` (25 runs).

Caps `runsPerDay: 4, dailyBudgetUsd: 40, maxConcurrentRuns: 4`; four seeds and four stand-in model
candidates, one of which is deliberately excluded and three of which duplicate live articles.

```
REQUESTS: 4
  req_planner_ceramides_20260914_01                        | ceramides                          | recognition   | organic_search/problem_aware
  req_planner_barrier_repair_order_of_operations_20260914_02 | barrier repair order of operations | investigation | organic_search/problem_aware
  req_planner_double_cleansing_20260914_03                 | double cleansing                   | recognition   | organic_search/problem_aware
  req_planner_ph_and_cleansers_20260914_04                 | ph and cleansers                   | understanding | organic_search/problem_aware
REJECTED:
  azelaic acid                            -> duplicate_of_published  azelaic-acid
  slugging                                -> duplicate_of_published  slugging
  sunscreen                               -> duplicate_of_published  sunscreen
  prescription tretinoin dosing schedules -> excluded                prescription-tretinoin-dosing
CAPS: runsPerDay 4 (used 0) · budget $40 (spent $0, priced at $4/run → 10 slots) · concurrency 4 (0 in flight) → slots 4
```

≥ 3 requests: **4**. No duplicate of an existing slug: **confirmed** — `azelaic acid`, `slugging`
and `sunscreen` are all live articles on drluriescience and all three were refused. Every request id
matches dr-lurie's declared `req_<flow>_<topic>_<yyyymmdd>_<nn>`.

A narrower, more realistic block (`runsPerDay 2, dailyBudgetUsd 10, maxConcurrentRuns 1`) plans
**one** request and names the binding cap on each rejection
(`over_concurrency: slots=1 (runCount=2, budget=2, concurrency=1)`) — which is the behaviour the
caps are for.

### Two design corrections the live data forced

Both were invisible against fixtures and both are the expensive kind:

1. **`object_list` on this fleet returns object ids and no bodies.** No `slug`, no `title` — so the
   first implementation read a site with 38 published articles as an empty one and would have
   re-commissioned every subject on it. On this fleet a `content_item`'s id *is* its request id, so
   `topicFromRequestId()` now recovers the topic from the id (`req_plugin_azelaic_acid_20260904_01`
   → `azelaic acid`) and that is what caught all three duplicates above.
2. **dr-lurie carries seven `blocked` runs**, the oldest a week old, each waiting on a person who may
   never come back. Counting those toward `maxConcurrentRuns` would have stopped the site
   commissioning permanently because nobody clicked a button. Concurrency now counts only
   `queued`/`running`; `blocked` and `paused` runs still **claim their topic** (the draft exists) and
   still break the failure streak without counting as failures.

## 2. The one live commission (P2 acceptance) — NOT RUN, deliberately

It cannot prove what it is meant to prove today, and it is not free.

- The deployed engine has no `commissionedBy` field and no `planner_*` tools, so a run started now
  would carry **no stamp** — the exact thing the acceptance is checking for.
- dr-lurie's `editorial_strategy` cannot hold a `commissioning` block until `platform` deploys: the
  live body schema is `.strict()` and refuses the unknown key.
- So the run would be an ordinary `workflow_start_dry_run` costing ≈$4 and publishing a real article
  to a live site, to re-prove a pipeline that was already measured working on 2026-09-13.

**Do it in the first session after the redeploy**, as one `planner_commission {projectId:
"dr-lurie", max: 1}`, and record the run id, cost and wall-clock here. Everything the commission
path does between the plan and the run is unit-tested (`tests/agent/planner/editorialPlanner.test.ts`:
the stamp, the rationale, the placement vector, the learning observation, the `max` clamp, the stale
`planId` refusal, the halt).

## 2b. The adversarial review round

The squashed diff was reviewed adversarially before delivery (CLAUDE.md's standing rule). Seven
defects were found and fixed; each has a regression test named after the failure, not after the
function.

| # | Defect | Fix |
|---|---|---|
| 1 | **The daily budget was ~8× bypassable.** `p95RunCost` priced off *every* run with a cost, and this fleet's history is dominated by runs that died early. 19 runs blocked at $0.30 plus one real $14.70 run priced a run at $0.30 — turning a declared `dailyBudgetUsd: 10` into 33 authorized slots, ≈$80 of work, while the plan still reported `dailyBudgetUsd: 10`. | Price only **finished** runs, and floor at the measured $4. A partial run is evidence about a failure, never about cost. |
| 2 | **`workflow.reset_run` stripped the stamp.** Every planner brake filters on `commissionedBy`, so an operator resetting a failed commissioned run erased it from the failure streak, handed back its run slot, refunded its cost from the day's budget *and* made it invisible to the platform's adoption sweep — the article would publish with no accountable origin anywhere. | `resetRun` carries `commissionedBy`/`commissioningRationale` through, exactly as it already carried `requestId`. |
| 3 | **A tenant with a dead approval queue commissioned for ever.** `blocked` was excluded from concurrency *and* broke the failure streak without counting, so nothing braked: 42 undeliverable runs on the books and two more commissioned every morning, publishing nothing. | Concurrency now counts anything queued/running **plus the planner's own** runs stuck at a human gate. A human's blocked runs still do not freeze the site; a backlog the planner made is one the planner owns. |
| 4 | **The id-based dedupe could never match a long topic.** Ids are minted from a 40-character slug and were compared against the full topic, so on a bodiless-inventory tenant any topic over 40 characters was re-commissioned **every single day, for ever**. | Mint and compare share one `requestTopicSlug`. |
| 5 | **In-flight runs were billed at their partial ledger cost.** The usage ledger accrues per node, so a run started at 06:00 and still writing read as nearly free and handed back slots already committed — 40% over budget on a single pass. | An unfinished run is billed at the p95 or what it has spent, whichever is larger. |
| 6 | **Two overlapping callers could mint the same request id on two live runs** (the job plus an operator's `planner.commission`; the plan is deterministic and `startDryRun` enforces no uniqueness). Double the spend, and only one of the two ever reaches the inbox. | A last-moment check against today's runs before each start. It does not make commissioning atomic — it shrinks the window from the whole plan to the call itself. A per-project lock is the real fix and is the one open item below. |
| 7 | **Exclusions matched in both containment directions**, so a *more precise* veto banned *more*: `"prescription tretinoin dosing"` also rejected the candidate `"tretinoin"`. A one-character entry rejected nearly every topic and stopped the publication with `reason: "excluded"` and no hint the exclusion was the cause. | One direction (the candidate contains the veto), minimum three characters. |

Three smaller ones were fixed in the same round: an id-grammar refusal reported as
`unknown_archetype` (now `request_id_unmintable`); the adoption path reading `node_total` when the
engine sends `nodeCount`; and the adoption scan window raised from 25 runs to the 100-row page the
call already costs, since a run that falls off that page is lost permanently rather than adopted
next pass.

**Cleared on inspection:** no publish-charter widening (a commissioned run meets every gate an asked
run meets, supplies no `workflowId` and no `publishRequestId`, and so cannot enter late-stage or
reach publish without the same operator decision); no regression for existing tenants (a legacy
strategy parses, warns, and blocks nothing at publish); no cross-tenant adoption; `createRequest` is
genuinely idempotent; `runsPerDay: 0` and `dailyBudgetUsd: 0` both plan nothing and say which cap
bound.

**One open item, stated rather than hidden:** `set_strategy_fields` is agent-submittable, so a
single one-key patch (`commissioning: {enabled: true}`) is enough to switch a site into unattended
publishing at the defaulted $10/day. The governance of that switch rests entirely on the strategy
object's own write/approval path. If that is not the intent, the fix is to make `commissioning` a
privileged sub-block — a deliberate governance decision, not something to slip in here.

## 3. What shipped

### `vreich-ui/platform` — branch `feat/editorial-planner`

| Area | Files |
|---|---|
| P1 contract | `packages/core/schema/bodies/editorial-strategy-v1.ts`, `lib/registry/object-contract.ts`, `server/lib/object-validate.ts` |
| P1 genesis | `packages/core/cli/create-site.mjs`, `scripts/seed-editorial-strategy.mjs` |
| P4 visibility | `server/lib/requests/store.ts`, `lib/admin/requests-client.ts`, `lib/admin/request-logic.ts`, `lib/admin/blockage.ts` |
| P4 adoption | `server/lib/requests/adopt-commissioned.ts` (new), `server/lib/requests/sweep.ts`, `server/functions/editorial-request-sweep-background.ts` |
| Tests | `server/lib/commissioning-contract.test.ts`, `server/lib/requests/adopt-commissioned.test.ts`, `lib/admin/planner-visibility.test.ts` |

`npm test`: **5957 + 316 + 222 pass**. (`tests/scripts/system-docs.test.mjs` fails on this checkout —
pre-existing drift between the committed lock and a newer sibling `cms-agent` clone, reproduced on
`main` with the branch stashed. Not from this work; `node scripts/docs/system-contracts.mjs --write`
on a real checkout clears it.)

### `vreich-ui/cms-agent` — branch `feat/editorial-planner`

| Area | Files |
|---|---|
| Run stamp | `workspace/executionTypes.ts`, `workspace/executor.ts` (`StartDryRunInput`, `buildInitialRun`, `summarizeRunForList`) |
| P1 consumer | `planner/commissioningTypes.ts` (new), `projects/genesisEditorialStrategy.ts` |
| P2 core | `planner/plan.ts` (new) — pure |
| P2 orchestration | `planner/editorialPlanner.ts` (new) |
| P2 tools | `mcp/workspace/plannerTools.ts` (new), spread into `mcp/workspace/tools.ts` |
| P3 job | `planner/imageGuard.ts`, `entrypoints/editorialPlannerJob.ts`, `entrypoints/editorialPlannerJobMain.ts` (all new) |
| P3 deploy | `scripts/deploy-editorial-planner.sh`, `scripts/deploy-editorial-planner-schedule.sh`, `scripts/jobs-repin.sh` (new), `scripts/pin-job-images.sh` (`PIN_ONLY`), `deploy/executor-jobs.txt` |
| Tests | `tests/agent/planner/{plan,editorialPlanner,editorialPlannerJob,imageGuard}.test.ts`, `tests/deploy/editorialPlannerScripts.test.ts` |

`npm test`: **3827 pass, 0 fail**. `typecheck`, `test:drift`, `test:glossary`, `test:objects`,
`test:scope` all green. `docs/mcp-tool-manifest.json` and `docs/reference/MCP_TOOLS.md` regenerated
(160 tools; the three `planner_*` verbs are the delta).

## 4. The three MCP verbs

| Verb | Costs | Starts anything |
|---|---|---|
| `planner_plan {projectId}` | one model turn, ≤ $0.50 | no |
| `planner_commission {projectId, planId?, max?}` | the same turn, then the runs | yes |
| `planner_status {projectId}` | nothing | no |

`planner_plan` and `planner_commission` build the plan through the **same** code path, so the
preview is the plan that will be spent. `planner_status` is the free call to poll.

## 5. Operator steps

In this order. Nothing here executes a job.

**a. Deploy the service** (normal path). The planner verbs appear on `cms-agent-mcp`; the run record
gains `commissionedBy`. Note the deployed `SERVICE_GIT_SHA`.

**b. Deploy platform** (normal path). This is what lets a strategy hold a `commissioning` block, and
what makes a commissioned run appear in `/admin/requests`.

**c. Create the job** — substitute the image the service is actually serving:

```bash
PROJECT=cms-agent-503015 \
REGION=us-central1 \
IMAGE=us-central1-docker.pkg.dev/cms-agent-503015/cms-agent/mcp-service:<sha> \
GCS_BUCKET=<the bucket the other jobs use> \
RUNTIME_SA=<the existing CMS-Agent runtime SA> \
CMS_AGENT_SERVICE_URL=https://<cms-agent-mcp host> \
bash scripts/deploy-editorial-planner.sh
```

`CMS_AGENT_SERVICE_URL` is **required**: without it the stale-image guard is UNVERIFIED and cannot
protect anything.

**d. First execution must be a dry run:**

```bash
gcloud run jobs execute editorial-planner --project cms-agent-503015 --region us-central1 \
  --args=--import,tsx,src/agent/entrypoints/editorialPlannerJobMain.ts,--dry-run
```

It prints one line per tenant and the full plan, and starts nothing. With no tenant opted in yet it
should report every tenant as skipped — that is the correct first result.

**e. Schedule it, only after reading a dry-run plan:**

```bash
PROJECT=cms-agent-503015 REGION=us-central1 SCHEDULER_SA=<the scheduler SA> \
bash scripts/deploy-editorial-planner-schedule.sh     # daily, 0 6 * * * UTC
```

**f. Every release from now on, repin:**

```bash
PROJECT=cms-agent-503015 REGION=us-central1 scripts/jobs-repin.sh            # all but continuation-tick
PROJECT=cms-agent-503015 REGION=us-central1 scripts/jobs-repin.sh --check    # report drift only
```

**`site-credential-reconciler --apply` is NOT needed. No tenant scope changed.** That is deliberate:
the visibility gap (a planner-started run having no request row) was closed by teaching the existing
sweep to adopt such runs, rather than by adding a tenant `/mcp` write verb — which would have needed
a new per-tenant credential grant on every site.

## 6. The `commissioning` block a config session should write

Set it with `set_strategy_fields` on the tenant's `strat_<slug>` (an open deep-merge; no new patch
op). **Leave `enabled: false` until a dry plan for that tenant has been read.**

```json
{
  "commissioning": {
    "enabled": false,
    "runsPerDay": 2,
    "dailyBudgetUsd": 10,
    "maxConcurrentRuns": 1,
    "stopAfterConsecutiveFailures": 2,
    "readerStateMix": { "recognition": 0.35, "understanding": 0.3, "investigation": 0.2, "selection": 0.15 },
    "archetypes": [
      { "id": "barrier_rebuilder", "job": "Decide what to stop using while a compromised barrier heals.", "defaultTrafficSource": "organic_search", "defaultAwarenessStage": "problem_aware" },
      { "id": "actives_chooser",  "job": "Choose between two actives without making things worse.",       "defaultTrafficSource": "organic_search", "defaultAwarenessStage": "solution_aware" }
    ],
    "seeds": [
      { "topic": "ceramides",                          "readerState": "recognition",   "archetypeId": "barrier_rebuilder", "priority": 3 },
      { "topic": "barrier repair order of operations",  "readerState": "investigation", "archetypeId": "barrier_rebuilder", "priority": 2 },
      { "topic": "double cleansing",                    "readerState": "recognition",   "archetypeId": "barrier_rebuilder", "priority": 1 }
    ],
    "exclusions": ["prescription tretinoin dosing"]
  }
}
```

Rules worth knowing before writing one:

- **`dailyBudgetUsd: 10` with a measured ≈$4 run means two runs a day, not "about ten dollars".**
  The budget is priced at the **p95** of that project's own run cost (falling back to $4 with fewer
  than three priced runs), so set it as a multiple of what a run there actually costs.
- A seed naming an archetype the strategy does not define is **refused at write**. A duplicate
  archetype id likewise.
- `exclusions` match by **containment**, so `"prescription tretinoin dosing"` also blocks
  "prescription tretinoin dosing schedules". Dedupe against published work matches by **equality**,
  so "ceramides" and "ceramides for a damaged barrier" are two different articles.
- Absence of the whole block is a **warning, never a blocker**, on every tenant.

## 7. What is still manual after all of this

1. **Deciding what a publication is for.** The `commissioning` block is written by a person, per
   tenant. Nothing proposes one.
2. **The first dry-run read per tenant.** `enabled: true` should follow a plan somebody looked at.
3. **Clearing a `planner_halted`.** By design — two consecutive failures means something is wrong
   that the planner cannot diagnose, so it stops and asks. Both remedies render as buttons in
   `/admin`; neither fires on a timer.
4. **Publish approval**, wherever a tenant's policy requires it. Commissioning does not widen the
   publish charter: a commissioned run meets exactly the gates an asked run meets.
5. **Repinning the job on release** (§5f). The stale-image refusal is a backstop for a forgotten
   repin, not a replacement for it.
